# Screepify v2 — Architecture Design

> Status: **Phase 1 implemented**, not yet run in game (see §16, and [ECONOMY.md](ECONOMY.md) for the v1 port) · Baseline: `master` @ `10a8ff4` · Branch: `v2`

## 0. Decisions already made

| # | Decision | Choice |
|---|---|---|
| D1 | Language / typing | Plain JS + **JSDoc + `// @ts-check`** (no TS compile step) |
| D2 | Where v2 lives | Fresh **`v2` git branch**, built from scratch; `master` keeps running live until v2 is mature |
| D3 | Military (assault, duo/solo planners, drain) | **Shelved** for phases 0–2. Towers + basic defense stay in scope |
| D4 | Colony continuity | A colony restart is acceptable if it buys a cleaner architecture |
| D5 | Movement | Our own library, built on **lessons from Traveler** (§11.1) |
| D6 | Room planning | **Automatic planner** (§12.1). A simple stamp layout in phase 1, the full planner in phase 2 |
| D7 | Stats | Console **and dashboard**: stats exported to a memory segment that `gui_data/dashboard.py` reads (§14.1) |
| D8 | Pixels | **Generate whenever the bucket is full** (§5.2) |

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
    plan/    missions.js  spawnPlanner.js  assignment.js  layout.js  construction.js
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
 * @property {'room'|'shard'} scope   room → once per tracked room (see §18); shard → once per tick
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
| `< 1,000` | critical + normal (if it fits) | `limit × 0.8` (refill) |
| `1,000 – 6,000` | all (if it fits) | `limit × 0.95` |
| `> 6,000` | all | `limit × 1.2` (spend some bucket) |
| `≥ burst job's threshold` | all + one `burst` job | e.g. room planner; each job declares the bucket it needs |
| `= 10,000`, no burst job queued | all, then **generate a pixel** (D8) | — |

Order of checks per process: **due → tier allowed → fits remaining budget (EMA cost) → run**. `low` tier only runs while the bucket is ≥ 1,000.

- A process skipped for budget is marked **owed**. Owed processes jump the queue next tick, so nothing starves.
- **Critical** processes (spawning, harvest/fill execution, towers, defense) always run, even over budget.

**Pixels vs bursts (D8).** `Game.cpu.generatePixel()` empties the bucket, so the bot must keep working normally from a near-empty bucket. That's why the low-bucket band still runs `normal` work when it fits within the limit. Burst jobs don't need a full bucket: they run as soon as the bucket reaches their declared threshold, before it ever gets to 10,000. A pixel is generated only when the bucket is full **and** no burst job is waiting, so pixels never starve the planner. Pixel generation can be switched off per shard in config.

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
 * @property {string} home       owning room (spawns + owns the creeps)
 * @property {string} room       room where the work happens (may differ from home)
 * @property {string} [shardTarget]  only for cross-shard missions (§18.3)
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
- Creep `role` is gone. Behaviour comes from `mission.type`; `memory.a` (archetype) only says which body class the creep is, so missions can require e.g. a miner. `main.js` no longer has a hard-coded list of roles.

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
- The empire spawner (cross-room spawning) comes in phase 4, as a shard-scope process that consumes leftover requests.

## 11. Shared services

| Service | Replaces (v1) | Notes |
|---|---|---|
| `movement` | `creepBorderNav`, `creepLaneMovement`, scattered `moveTo` | See §11.1 |
| `cache` | `heap.js`, `roomCache.js`, `global._*` | Named heap stores with TTL; per-tick `find` cache |
| `body` | spawner body builders, `bodyCodec` | Archetype recipes scaled by energy budget |
| `pos` | ad-hoc RoomPosition handling | pack/unpack, range helpers |
| `log` | `debug(...)` categories | Categories toggled via `Memory.config.debug` |

### 11.1 Movement library (D5)

We write our own, borrowing the ideas that made Traveler cheap. We re-implement the ideas rather than copy its code.

**API.** One call, used by every action executor:

```js
/** @returns {ScreepsReturnCode} */
move.to(creep, target, { range = 1, priority = 0, avoidHostile = true, preferRoads = true })
```

| Lesson from Traveler | How v2 applies it |
|---|---|
| Path once, reuse many ticks | Path serialized as a direction string and stored on heap (`creep.name → {dest, path, i}`). Each tick costs one `move(dir)`, not a `PathFinder` call |
| Detect stuck, then repath | Same position for 2+ ticks (fatigue excluded) → repath **with creeps as obstacles** for that one search |
| Cache cost matrices | Per room on heap: structures and roads, rebuilt every N ticks or when a construction site or structure count changes. Creep positions are never cached |
| Route between rooms first | `Game.map.findRoute` with a room cost from intel (avoid hostile owned rooms and source-keeper rooms, prefer highways); `PathFinder` is then limited to the rooms on the route |
| Ignore creeps by default | The normal search ignores creeps; only the stuck repath counts them |
| Room-edge handling | Exit-tile bounce handled inside `move.to`, which replaces v1's `creepBorderNav` |

**Beyond Traveler: traffic management (phase 2).** Moves become *intents* collected during ACT and resolved at the end of the tick. Higher-priority creeps can then **swap with** or **shove** idle or lower-priority creeps (e.g. a static miner standing on a road), which removes most "stuck" repaths. Phase 1 ships without it.

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

### 12.1 Automatic room planner (D6)

Split into a **planner** (expensive, rare) and a **builder** (cheap, frequent):

| Part | Process | Tier / cadence | Output |
|---|---|---|---|
| Planner | `plan.layout` | `burst` job, once per room (on claim, or on demand from the console) | A compact layout: `{rcl → structureType → packed positions}` stored in `Memory.rooms[n].plan` (or a segment if it grows) |
| Builder | `plan.construction` | `normal`, every 50 ticks + on RCL change | Places construction sites from the stored plan for the current RCL, respecting the site limit and priority order (spawn → extensions → tower → storage → roads…) |

**Planner steps (phase 2).**
1. Distance transform on the terrain to find open areas.
2. Place the core stamp (spawns, storage, terminal, link, towers) at the best spot that balances openness against distance to sources and controller.
3. Flood-fill extension stamps outward from the core.
4. Lay roads with `PathFinder` from the core to sources, controller and mineral, reusing tiles where possible.
5. Place container and link spots at sources and the controller.
6. Place ramparts with min-cut around the core (phase 3).

The planner is written as a **resumable state machine**: it does a slice of work per tick, so a single run never risks the 500 CPU tick ceiling. It runs only when the bucket allows (§5.2).

**Phase 1 stand-in.** A fixed, deterministic stamp around the first spawn: checkerboard extensions, roads to sources and the controller, and containers. That is enough to reach RCL 4 unattended. The phase-2 planner replaces it behind the same plan format, so the builder doesn't change.

## 13. Military (shelved, D3)

- v1's admiral stack (~11.7k lines) is **not ported** in phases 0–2.
- The integration point is reserved: a future `processes/act/military.js` plus `missions/assault/`, using the same contracts. The duo/solo planners can be wrapped behind an adapter instead of rewritten.
- Until then: towers, safe mode and a simple `defend` mission (melee/ranged defenders when towers can't hold) cover defense.

## 14. Config, console, build and deploy

**Config.** `config.js` holds defaults, deep-merged with `Memory.config` at boot and on `config.reload()`. Covers process toggles, cadence overrides, safe-mode rooms, pixel generation, debug categories.

**Console.** Each domain registers its commands at boot (`console/*.js`): `stats()`, `proc.list()`, `proc.toggle(id)`, `mission.list(room)`, `config.set(path, value)`, `plan.run(room)`, `plan.show(room)`.

### 14.1 Stats and dashboard (D7)

| Piece | Design |
|---|---|
| Source of truth | Kernel telemetry (§5.5) plus a `report.stats` process |
| Console | `stats()` prints a compact table: CPU (avg, top processes), bucket, GCL/RCL progress, energy per tick, creeps per mission, unmet missions |
| Export | `report.stats` (tier `normal` so a pixel's empty bucket doesn't pause it, every 20 ticks) writes compact JSON to a dedicated **memory segment** (config, default 90), not to `Memory`, so normal ticks don't parse it |
| Contents | `{v, shard, t, cpu: {avg, limit, bucket, byProcess: top N}, gcl, rooms: {name: {rcl, progress, energy, storage, creeps, missions, threat}}, history: ring buffer of ~100 samples}` |
| Dashboard | `gui_data/dashboard.py` gains a v2 mode that reads the segment through the API endpoint for memory segments, per shard, and keeps its v1 `Memory` mode until switchover |

The segment API details (activation and size limits) still need to be checked before implementation.

**Build.** `scripts/build.js` uses esbuild to bundle `src/main.js` into `dist/main.js` (CommonJS). The output target must match the official server's JS runtime; verify this before locking it in. Start conservatively (`es2018`).

**Typecheck.** `jsconfig.json` with `checkJs: true` plus `@types/screeps`. `npm run check` runs `tsc --noEmit` (dev dependency only, no compile step).

**Tests.** `node --test test/` with a minimal `Game`/`Memory` mock. Cover kernel scheduling, shedding and isolation, planners, body builder, and spawn deficits.

**Deploy.** `scripts/deploy.js` uses Node `https` (works behind proxies) to upload to **Screeps code branch `v2`**. Switchover means activating branch `v2` in-game. Rollback means activating `default` again, which still runs v1.

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
| Zeadmin empire board/tasker/executor | Shard-scope processes (phase 4) |
| `overseer/policy/*` (room phase + state, dev_make_missions_missions) | `processes/sense/policy.js` |
| `telemetry/*`, `screeps-profiler` | `kernel/telemetry.js` (always on) |
| `heap.js`, `roomCache.js`, `global._*` | `services/cache` |
| Grunt flatten-copy | esbuild bundle |

## 16. Migration plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Skeleton** ✅ | Build/check/test tooling, kernel, registry, ctx, telemetry, memory schema, cache service, console basics, pixel rule, stats segment export | Kernel tests pass. Empty loop costs < 0.5 CPU. Deploys to branch `v2` |
| **1 — Core economy** ✅ code, ⏳ in game | intel, census, harvest, fill, haul, upgrade, build, repair, spawns, towers, safe mode, movement (Traveler-style, no traffic manager), stamp layout + construction builder, dashboard v2 mode | **Restart colony on v2.** Reaches RCL 4 unattended. Average CPU within budget with bucket rising |
| **2 — Growth** | Automatic room planner, traffic management, links, storage logistics, remotes (reserve/harvest/haul), terminal balancing, labs (basic), scout | Sustains 2 remotes per room within 20 CPU. Planner lays out a fresh room with no manual input |
| **3 — Defense+** | defend missions, threat-driven tower/rampart policy; optional military plugin port | Survives NPC invaders and small player raids |
| **4 — Empire** | Expansion/claim, cross-room spawning, resource balancing | Second room claimed and bootstrapped automatically |

Features from the newer v1 branch `dev_make_missions_missions` (room policy, traffic, lane logistics, remotes, labs, terminal) are scheduled into phase 2 in [PORTING.md](PORTING.md).

Phase 1 is verified in a single-room simulator against v1 (`test/sim.test.js`, [ECONOMY.md](ECONOMY.md)); the in-game exit criteria are still open.

Switchover can happen as early as the end of phase 1 if v2 outperforms v1 for the current colony size. `master` and v1 stay deployable on branch `default` until v2 is merged.

## 17. CPU targets (targets, not measurements)

| Item | Target |
|---|---|
| Kernel + ctx overhead | < 0.5 CPU / tick |
| Per creep (steady state, sticky task + cached path) | ≈ 0.2–0.3 CPU |
| Planning (amortised by cadence) | < 1 CPU / room / tick |
| Whole bot, 1 room RCL 4–5, ~15 creeps | ≤ 8 CPU average |

## 18. Scaling: more rooms and more shards (no reboot needed)

The kernel's **process list is static** and the **set of rooms and shards it runs over is dynamic**. A new room or shard therefore never requires a code change or restart: it shows up in `ctx` on the next tick and every room-scope process starts covering it.

### 18.1 Room lifecycle (`Memory.rooms[name].k`)

```
 scouted ─► target ─► claiming ─► bootstrap ─► owned ─► (lost → GC)
              │                       ▲
              └──► remote (reserved/harvested by a home room)
```

| Kind | Who runs it | Processes that cover it |
|---|---|---|
| `owned` (has spawn) | itself | all room-scope processes |
| `bootstrap` (claimed, no spawn yet) | **parent** room | parent gets `pioneer`/`build` missions targeting it; its towers/defense run locally once they exist |
| `remote` | parent room | parent's remote missions (reserve/harvest/haul) |
| `target` / `claiming` | empire planner | `claim` mission spawned from the nearest suitable room |

- **Mission `home` and target room are separate.** `Mission.home` owns the creeps and spawning; `Mission.room` is where the work happens. This is how one room feeds another without special cases.
- **Rooms are promoted automatically:** when a `bootstrap` room has a working spawn, its kind becomes `owned` and its own planners take over. The parent's pioneer missions stop being generated.
- **Garbage collection:** a `sense.rooms` process (cadence 50) drops heap stores and memory for rooms that are no longer tracked.

### 18.2 Expanding within the CPU budget

- **Expansion is gated on CPU, not just GCL.** The empire planner only picks a new target when the CPU EMA plus a per-room cost estimate (measured by telemetry) is below `limit × 0.8`, and the bucket is trending up.
- **Per-room CPU accounting:** telemetry keeps CPU per process *per room*, so the cost of one room is known before claiming another.
- **Shedding is ordered by room priority:** under pressure, `low` tier work stops in the least important rooms (newest, then remotes) first, and the core room is protected.
- **Cadence staggering** (§5.3) already spreads room work across ticks, so adding rooms raises average CPU instead of creating spikes.

### 18.3 Shards

Each shard runs the **same bundle** in its own VM, with its own `Memory`, heap and CPU limit. Shards only share data through `InterShardMemory` (each shard writes its own string; others can read it).

| Concern | Design |
|---|---|
| Shard-specific behaviour | Only through config: `config.shards[Game.shard.name]` overrides process toggles, pixel generation, expansion. Never `if (shard === 'shard2')` in code (v1's pixel hack moves here) |
| Scope | New process scope **`shard`** (once per shard per tick), alongside `room`. The `empire` layer is a set of shard-scope processes |
| Cross-shard comms | `processes/sense/intershard.js` (cadence 10): reads other shards' `InterShardMemory`, writes our own. Versioned JSON: `{ v, t, creeps: {name: mem}, msgs: [...] }`, trimmed to stay well under the size limit |
| Creeps through portals | `Memory.creeps` does not follow a creep across a portal. Before entering, the creep runner writes `{m, t, home}` under its name in our ISM. On the other side, a creep with no memory is **adopted** from the source shard's ISM, then the entry is acked and deleted |
| Cross-shard missions | A `portal` action plus `shardTarget` on the mission. A cross-shard claim is: the empire planner on shard A posts a message, and shard B's planner turns it into local missions |
| CPU split | `shard.cpu` process calls `Game.cpu.setShardLimits` from `config.cpu.shards` (only matters for accounts with CPU on several shards; shard3 is capped at 20) |

Cross-shard play stays a **non-goal for phases 0–3** (§1). Reserving the `shard` scope, the ISM schema and the adopt-on-arrival rule now means it won't need a contract change later.

## 19. Open questions

The first round is resolved as D5–D8. Facts checked during phase 0:

1. **JS runtime:** no current official statement found; the last documented runtime is Node 8.9.3 (2017). The build targets **ES2017** and esbuild lowers newer syntax, so this is safe either way.
2. **Segments** (official API docs): ids 0–99, max 10 active, 100 KB each; data requested with `setActiveSegments` is readable next tick. The docs don't say whether writing needs an active segment, so `services/segments` only writes active segments and queues the rest.
3. **InterShardMemory** (official API docs): 100 KB per shard; `getLocal`/`setLocal` for our shard, `getRemote(shard)` read-only for others. `generatePixel` costs 10,000 bucket.
