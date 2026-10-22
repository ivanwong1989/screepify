# Screepify v2 — Architecture Design

> Status: **Draft for discussion** · Baseline: `master` @ `10a8ff4` · Target branch: `v2`

## 0. Decisions already made

| # | Decision | Choice |
|---|---|---|
| D1 | Language / typing | Plain JS + **JSDoc + `// @ts-check`** (no TS compile step) |
| D2 | Where v2 lives | Fresh **`v2` git branch**, built from scratch; `master` keeps running live until v2 is mature |
| D3 | Military (assault, duo/solo planners, drain) | **Shelved** for phases 0–2. Towers + basic defense stay in scope |
| D4 | Colony continuity | A colony restart is acceptable if it buys a cleaner architecture |

## 1. Goals and non-goals

**Goals (in priority order)**

1. **CPU efficiency.** We play on the 20 CPU non-subscription shard, so every tick must fit in 20 CPU and the bucket must stay healthy.
2. **Modularity.** A feature is a self-contained plugin. Adding, removing or changing one must not ripple into others ("no dominoes").
3. **Fault isolation.** A crashing or over-budget plugin degrades only itself.
4. **Observability.** CPU per plugin is always known.
5. **Testability.** Core logic runs under Node with a mocked `Game` object.

**Non-goals (for now)**

- Offensive military, market trading AI, multi-shard play, automated base layout.
- Feature parity with v1 before switchover. v2 replaces v1 when it runs the economy better, not when it does everything v1 does.

## 2. Constraints

| Constraint | Value | Design impact |
|---|---|---|
| CPU limit | 20 / tick (shard3, no subscription) | Cadence scheduling, tiered shedding |
| Bucket | max 10,000; max 500 CPU in one tick | Bucket-aware tiers; burst only for rare heavy work |
| `Memory` | JSON parsed each tick (mitigated by memhack) | Keep `Memory` small; heap first |
| Global/heap | Survives between ticks until VM reset | Everything rebuildable lives on heap |
| Code upload | Flat module namespace on the server | Bundle to a single `main.js` |

## 3. Architecture at a glance

```
                ┌──────────────────────────────────────────────┐
 main.loop ───► │ KERNEL                                       │
                │  boot (once per VM) → load registry, config  │
                │  tick: budget = f(bucket, limit)             │
                │        for phase in SENSE→PLAN→ACT→REPORT:   │
                │          for proc in phase (by priority):    │
                │            due? tier allowed? fits budget?   │
                │            → try { proc.run(ctx) } + CPU log │
                └──────────────┬───────────────────────────────┘
                               │ every process gets the same
                               ▼
                ┌──────────────────────────────────────────────┐
                │ TickContext (ctx)  — typed blackboard        │
                │  ctx.rooms[name] → RoomCtx {intel, missions, │
                │     census, reservations, spawnQueue, state} │
                │  ctx.empire, ctx.config, ctx.log, ctx.heap   │
                └──────────────┬───────────────────────────────┘
          ┌────────────────────┼────────────────────────┐
          ▼                    ▼                        ▼
   Mission registry      Action executors         Shared services
   (one folder/type)     (harvest, build…)        movement, cache, body
```

**Plugins never import each other.** They meet only in `ctx`, through the mission/task contracts, and through shared *services* (pure helpers with no tick state).

## 4. Source layout

```
src/
  main.js                    # 10 lines: memhack + kernel.loop
  kernel/
    kernel.js                # scheduler, budget, error isolation
    registry.js              # THE list of enabled processes (one line each)
    context.js               # builds ctx / RoomCtx each tick
    telemetry.js             # per-process CPU EMA, bucket trend
    memory.js                # memhack, schema version, migrations
  contracts/                 # JSDoc typedefs only — the shared language
    process.js  mission.js  task.js  spawn.js  ctx.js
  services/                  # stateless helpers, safe to import anywhere
    movement/  cache/  body.js  pos.js  log.js
  processes/                 # plugins, grouped by domain
    sense/   intel.js  census.js  threat.js
    plan/    missions.js  spawnPlanner.js  assignment.js
    act/     creeps.js  spawns.js  towers.js  links.js  defense.js
    report/  stats.js  visuals.js
  missions/                  # one folder per mission type (plug-and-play)
    harvest/  haul/  upgrade/  build/  repair/  fill/  scout/ ...
      index.js               # exports a MissionType (see §8)
  actions/                   # one file per creep action executor
    harvest.js transfer.js withdraw.js pickup.js upgrade.js build.js
    repair.js dismantle.js reserve.js claim.js move.js drop.js
  console/                   # console commands, registered at boot
  config.js                  # defaults; overridable via Memory.config
test/                        # node:test + Game mock
scripts/                     # build.js (esbuild), deploy.js
```

Folders are real folders. esbuild resolves `require('./x')` normally, which removes v1's flattened `managers_overseer_x` naming.

## 5. Kernel

### 5.1 Process contract

```js
/**
 * @typedef {'SENSE'|'PLAN'|'ACT'|'REPORT'} Phase
 * @typedef {'critical'|'normal'|'low'} Tier
 *
 * @typedef {Object} Process
 * @property {string}  id          unique, e.g. 'act.towers'
 * @property {Phase}   phase
 * @property {'room'|'empire'} scope   room → run once per owned room
 * @property {Tier}    tier        decides shedding under CPU pressure
 * @property {number}  [priority=100] lower runs first within a phase
 * @property {number}  [every=1]   cadence in ticks (staggered per room)
 * @property {(ctx: TickContext, room?: RoomCtx) => void} run
 * @property {(ctx: TickContext) => void} [init]  once per VM boot
 */
```

`registry.js` is a plain array, so turning a plugin off means commenting out one line or toggling it in config:

```js
module.exports = [
  require('../processes/sense/intel'),
  require('../processes/sense/census'),
  require('../processes/plan/missions'),
  // require('../processes/act/military'),   // shelved (D3)
];
```

### 5.2 Tick budget and shedding

| Bucket | Tiers allowed | Soft CPU target |
|---|---|---|
| `< 1,000` | critical | `limit × 0.8` |
| `1,000 – 6,000` | critical + normal | `limit × 0.95` |
| `> 6,000` | all | `limit × 1.2` (spend some bucket) |
| `= 10,000` and idle | all + `burst` jobs | e.g. room planning, pixel (config) |

Order of checks per process: **due → tier allowed → fits remaining budget (EMA cost) → run**.

- A process skipped for budget is marked **owed**. Owed processes jump the queue next tick, so nothing starves.
- **Critical** processes (spawning, harvest/fill execution, towers, defense) always run, even over budget.

### 5.3 Cadence staggering

A room process with `every: N` runs when `(Game.time + hash(roomName)) % N === 0`. This spreads expensive work across rooms and ticks, so CPU per tick stays flat instead of spiking.

### 5.4 Fault isolation

- Each `run` is wrapped in `try/catch`. On error the kernel logs it once per 100 ticks with the stack, increments `errors[id]`, and continues with the next process.
- After K consecutive failures (config, default 20) the process is **quarantined** for 500 ticks.
- The creep runner isolates **per creep**: one bad creep cannot stop the others.

### 5.5 Telemetry (built in)

The kernel records CPU for every `run`, with an EMA (α≈0.1) per process id, plus bucket and creep counts. `stats.print()` (console) shows a table sorted by cost. The same EMA is used for the budget check in §5.2.

## 6. TickContext (replaces `room._*`)

```js
/**
 * @typedef {Object} RoomCtx
 * @property {Room}   room
 * @property {string} name
 * @property {RoomIntel} intel            // heap-cached, refreshed by sense.intel
 * @property {Mission[]} missions         // heap-cached, refreshed by plan.missions
 * @property {Census} census              // creeps by mission id / archetype
 * @property {Reservations} reservations  // per-tick energy/target claims
 * @property {SpawnRequest[]} spawnQueue
 * @property {RoomState} state            // {economy, threat, overall}
 */
```

**Ownership rule:** every field has one writer process (documented in `contracts/ctx.js`). Everyone else only reads. This replaces v1's ~16 ad-hoc `room._*` keys and the Admiral concatenating into the Overseer's list.

`ctx` is rebuilt each tick, but heavy fields (`intel`, `missions`) are **references to heap data** refreshed on cadence. Building `ctx` is cheap.

## 7. State and persistence policy

| Tier | What | Rule |
|---|---|---|
| **Tick** (`ctx`) | reservations, spawn queue, derived state | Never persisted |
| **Heap** (`services/cache`) | intel, missions, cost matrices, paths, census index | Must be rebuildable from `Game` + `Memory`. Named stores only, with no raw `global._x` |
| **Memory** | creep task + mission id, room plan anchors, config, schema version, small stats | Small. Short keys. No full mission objects |
| **Segments** | scouting/intel of many rooms, long stats series | Phase 2+, only if needed |

- **Schema:** `Memory.v = 2`, plus an ordered list of migrations in `kernel/memory.js`. Boot runs pending migrations. The first v2 boot wipes v1 keys (a colony restart is acceptable, D4).
- **Memhack:** carried over as is.

## 8. Missions (the plug-and-play unit)

v1's best idea was the mission contract. v2 keeps it, formalises it, and packages each mission **type** as one self-contained module.

### 8.1 Mission instance

```js
/**
 * @typedef {Object} Mission
 * @property {string} id         stable, e.g. 'harvest:W1N1:<sourceId>'
 * @property {string} type       MissionType key
 * @property {string} home       owning room
 * @property {number} priority   higher = more important
 * @property {Demand} demand     { work?, carry?, claim?, minCreeps, maxCreeps }
 * @property {string} archetype  body recipe key ('miner', 'hauler', 'worker'…)
 * @property {Object} [data]     type-specific, owned by the MissionType
 */
```

### 8.2 MissionType module

```js
/**
 * @typedef {Object} MissionType
 * @property {string} type
 * @property {number} every                      // planning cadence
 * @property {(r: RoomCtx, ctx: TickContext) => Mission[]} generate
 * @property {(creep: Creep, m: Mission, r: RoomCtx) => Task|null} nextTask
 * @property {(budget: number, m: Mission) => BodyPartConstant[]} body
 * @property {(creep: Creep, m: Mission) => number} [fitness]   // assignment score
 */
```

**Adding a feature** means creating `missions/<name>/index.js` and adding it to the mission list in `config.js`. Nothing else changes: the planner, assignment, spawner and creep runner are all generic over `MissionType`.

### 8.3 Planned phase-1 mission types

`harvest` · `haul` (container→storage/spawn) · `fill` (spawns/extensions/towers) · `upgrade` · `build` · `repair` · `scout`. v1 equivalents are mapped in §15.

## 9. Tasks and the creep runner

### 9.1 Task contract (stored in `creep.memory.t`)

```js
/**
 * @typedef {Object} Task
 * @property {string} a    action: 'harvest'|'transfer'|'withdraw'|'pickup'|'upgrade'
 *                          |'build'|'repair'|'dismantle'|'reserve'|'claim'|'move'|'drop'
 * @property {string} [i]  target id
 * @property {string} [p]  packed target pos (when no id)
 * @property {string} [r]  resource type (default energy)
 * @property {number} [n]  range (default per action)
 */
```

Creep memory is just `{ m: missionId, t: Task, h: homeRoom }`.

### 9.2 Lifecycle: sticky tasks (the main CPU win)

```
idle creep ─► assignment (plan phase, cadence) picks mission by priority × fitness
     │
     ▼
creep has mission ─► runner: task missing/done? → MissionType.nextTask()
     │                                   (O(1) per creep in most ticks)
     ▼
actions[t.a].run(creep, task) → CONTINUE | DONE | FAIL
```

- Creeps are **not** re-evaluated every tick. v1's tasker walks every creep against every mission each tick. In v2, assignment runs only for idle creeps, or when a mission vanishes or is rebalanced (cadence 5–10).
- **Action executors** do one thing: move into range, perform the intent, and return a status. All moving goes through `services/movement`.
- Creep `role` is gone. Behaviour comes from `mission.type`. `main.js` no longer has a hard-coded list of roles.

## 10. Spawning

```
missions(demand) ─► census(fulfilment by mission id, incl. spawning)
                 ─► spawnPlanner: deficits → SpawnRequest[] (sorted by priority)
                 ─► act.spawns: per room, pick idle spawn, build body via MissionType.body()
```

```js
/** @typedef {Object} SpawnRequest
 *  @property {string} missionId  @property {number} priority
 *  @property {BodyPartConstant[]} body  @property {string} home
 *  @property {number} [leadTicks]  pre-spawn for replacements
 */
```

- **No `Memory.spawnTickets`.** The creep's memory (`m`) is set at spawn time. Spawning creeps are counted through `spawn.spawning.name` → `Memory.creeps[name].m`. This removes the ticket GC in v1's `main.js`.
- Pre-spawn for replacements: when a creep's `ticksToLive` is below its `travelTicks` plus spawn time, the mission counts it as departing.
- The empire spawner (cross-room spawning) comes in phase 4, as an empire-scope process that consumes leftover requests.

## 11. Shared services

| Service | Replaces (v1) | Notes |
|---|---|---|
| `movement` | `creepBorderNav`, `creepLaneMovement`, scattered `moveTo` | Cached serialized paths (heap), cost matrices per room every N ticks, stuck detection, swap/shove for idle creeps |
| `cache` | `heap.js`, `roomCache.js`, `global._*` | Named heap stores with TTL; per-tick `find` cache |
| `body` | spawner body builders, `bodyCodec` | Archetype recipes scaled by energy budget |
| `pos` | ad-hoc RoomPosition handling | pack/unpack, range helpers |
| `log` | `debug(...)` categories | Categories toggled via `Memory.config.debug` |

## 12. Structures and defense

| Process | Phase | Tier | Cadence |
|---|---|---|---|
| `act.towers` (attack > heal > emergency repair) | ACT | critical | 1 |
| `act.defense` (safe mode trigger, hostile response) | ACT | critical | 1 |
| `sense.threat` (hostile scan, threat level) | SENSE | critical | 1 (cheap `find` from tick cache) |
| `act.links` | ACT | normal | 5 |
| `act.terminal` (balancing only) | ACT | low | 50 (phase 2) |
| `act.labs` | ACT | low | 10 (phase 2+) |

Safe mode is driven by config (`config.safeMode.rooms`, or automatic for all owned rooms) instead of the hard-coded `W44S28`.

## 13. Military (shelved, D3)

- v1's admiral stack (~11.7k lines) is **not ported** in phases 0–2.
- The integration point is reserved: a future `processes/act/military.js` plus `missions/assault/`, using the same contracts. The duo/solo planners can be wrapped behind an adapter instead of rewritten.
- Until then: towers, safe mode and a simple `defend` mission (melee/ranged defenders when towers can't hold) cover defense.

## 14. Config, console, build and deploy

**Config.** `config.js` holds defaults, deep-merged with `Memory.config` at boot and on `config.reload()`. Covers process toggles, cadence overrides, safe-mode rooms, pixel generation, debug categories.

**Console.** Each domain registers its commands at boot (`console/*.js`): `stats()`, `proc.list()`, `proc.toggle(id)`, `mission.list(room)`, `config.set(path, value)`.

**Build.** `scripts/build.js` uses esbuild to bundle `src/main.js` into `dist/main.js` (CommonJS). The output target must match the official server's JS runtime; verify this before locking it in. Start conservatively (`es2018`).

**Typecheck.** `jsconfig.json` with `checkJs: true` plus `@types/screeps`. `npm run check` runs `tsc --noEmit` (dev dependency only, no compile step).

**Tests.** `node --test test/` with a minimal `Game`/`Memory` mock. Cover kernel scheduling, shedding and isolation, planners, body builder, and spawn deficits.

**Deploy.** `scripts/deploy.js` uses screeps-api to upload to **Screeps code branch `v2`**. Switchover means activating branch `v2` in-game. Rollback means activating `default` again, which still runs v1.

npm scripts: `build`, `check`, `test`, `deploy` (= check + test + build + upload).

## 15. v1 → v2 mapping

| v1 | v2 |
|---|---|
| `main.js` loop, role switch, ticket GC | `kernel/*`, `processes/act/creeps.js` |
| `runColony.js` fixed order | Kernel phases + registry |
| Overseer intel / ledger | `processes/sense/intel.js` |
| `overseer.missions.js` + 21 `mission.*.js` | `processes/plan/missions.js` + `missions/<type>/` |
| `tasks.assign.js` (1.1k lines) + `tasks/exec/*` | `processes/plan/assignment.js` + `MissionType.nextTask` + `actions/*` |
| `role.universal.js` action switch | `actions/*` registry |
| Spawner (contracts, census, planner, tickets) + global spawner | `sense/census`, `plan/spawnPlanner`, `act/spawns` |
| `structures/*` | `act/links`, `act/terminal`, `act/labs`, `act/towers` |
| Admiral, military tasks, `role.assault`, `role.defender` | Shelved → future `act/military` + `missions/assault` |
| Zeadmin empire board/tasker/executor | Empire-scope processes (phase 4) |
| `telemetry/*`, `screeps-profiler` | `kernel/telemetry.js` (always on) |
| `heap.js`, `roomCache.js`, `global._*` | `services/cache` |
| Grunt flatten-copy | esbuild bundle |

## 16. Migration plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Skeleton** | Build/check/test tooling, kernel, registry, ctx, telemetry, memory schema, cache service, console basics | Kernel tests pass. Empty loop costs < 0.5 CPU. Deploys to branch `v2` |
| **1 — Core economy** | intel, census, harvest, fill, haul, upgrade, build, repair, spawns, towers, safe mode, movement | **Restart colony on v2.** Reaches RCL 4 unattended. Average CPU within budget with bucket rising |
| **2 — Growth** | links, storage logistics, remotes (reserve/harvest/haul), terminal balancing, labs (basic), scout | Sustains 2 remotes per room within 20 CPU |
| **3 — Defense+** | defend missions, threat-driven tower/rampart policy; optional military plugin port | Survives NPC invaders and small player raids |
| **4 — Empire** | Expansion/claim, cross-room spawning, resource balancing | Second room claimed and bootstrapped automatically |

Switchover can happen as early as the end of phase 1 if v2 outperforms v1 for the current colony size. `master` and v1 stay deployable on branch `default` until v2 is merged.

## 17. CPU targets (targets, not measurements)

| Item | Target |
|---|---|
| Kernel + ctx overhead | < 0.5 CPU / tick |
| Per creep (steady state, sticky task + cached path) | ≈ 0.2–0.3 CPU |
| Planning (amortised by cadence) | < 1 CPU / room / tick |
| Whole bot, 1 room RCL 4–5, ~15 creeps | ≤ 8 CPU average |

## 18. Open questions

1. **Movement:** write our own (cached paths and shove), or adopt a known library pattern (Traveler-style)? Leaning towards our own minimal one.
2. **Room planning:** manual flags or placement for now, or an automatic base planner in phase 2? It's a big CPU burst, so it would be a `burst` job.
3. **Stats export:** keep the console sparklines only, or also push to `Memory.stats` or a segment for the `gui_data/dashboard.py` tool?
4. **Pixel generation:** keep it on with a full bucket? On a 20 CPU shard it competes with bucket-funded bursts.
