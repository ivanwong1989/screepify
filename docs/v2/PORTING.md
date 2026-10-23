# Screepify v2 — Porting plan from `dev_make_missions_missions`

v2 was cut from `master` at `4fa726e` (2026-03-14). The newest v1 work lives on
`dev_make_missions_missions` (36 commits after that point, up to `12f11c4`,
2026-03-28, about 20.8k lines added). None of it is in v2 yet.

This document says what to take from that branch, what v2 shape it becomes, the
order, and a rough effort per item. It extends [DESIGN.md](DESIGN.md) §15 (v1 → v2
mapping) and §16 (migration plan).

## 1. Assessment that drives this plan

Scores come from a code read and pattern counts, not in-game profiling.

| | v1 branch | v2 |
|---|---|---|
| Size | ~46k lines, 15 files > 700 lines | ~5.8k lines, largest file 310 |
| Modularity | 5/10 | 8/10 |
| CPU efficiency | 6/10 | 8/10 (design, not yet proven in game) |
| Testability | 2/10, no tests | 8/10, sim and economy tests |
| Features | 9/10 | 4/10 |

**v1 problems we must not bring over**

- Very large files. Core lane hauling is 3.5k lines (1,910-line mission + 1,559-line role).
- "Simple" and "V2" variants are copy-paste forks. `harvest` and `simpleHarvest` share about 415 lines.
- Roles call `missionBoard`, `missionRuntime`, `manager.terminal` and the remote utilities directly, so the two layers depend on each other.
- A hard-coded 24-role switch in `main.js`.
- No CPU budget. The only bucket check is `bucket >= 10000`.
- 130 `room.find(FIND_*)` calls (16 in the core lane mission alone) and 82 uncached `Game.getObjectById` calls.
- 9 different `isWalkable*` helpers.
- More than 15 top-level `Memory.*` keys, 6 of them debug flags.

**v1 ideas worth keeping**

- Room phases and states (`room.policy.constants.js`).
- Refresh throttling per mission type.
- Persistent missions instead of rebuilding every tick.
- The lane-building algorithm and its PathFinder cost model.
- Lab automation.
- Remote-haul pathing.
- Traffic manager.

## 2. Porting rules

1. **Port logic, not files.** Read the v1 code, then rewrite it as v2 parts:
   - `processes/<phase>/*` for room-level sense, plan and act
   - `missions/*` for the work units
   - `actions/*` for what a creep does
   - `services/*` for shared helpers
2. **No roles.** What a creep does comes from its mission type. A creep's body is chosen by archetype (`memory.a`). New body recipes go in `services/body.js`.
3. **One mission per job, with settings by phase.** No `simpleX` / `xV2` pairs. Room phase (item P1 below) chooses the parameters.
4. **File size limit.** Aim for under 400 lines per file. Split pathing, planning and execution.
5. **Room objects come from `ctx` / `roomData` / `cache`.** No `room.find` inside missions or actions.
6. **Every process declares a cadence and tier** so the kernel budget can shed it.
7. **Tests come with the port.** Each item adds or extends a `test/sim.test.js` scenario or a unit test before it is called done.
8. **Memory.** No new top-level `Memory.*` keys. Use `Memory.rooms[name]` and the existing schema in `kernel/memory.js`. Debug flags go in `config.js` / console.
9. **One shared walkability helper** in `services/pos.js`, used everywhere.

## 3. Inventory and target shape

Effort: **S** ≈ 1 session, **M** ≈ 2–3, **L** ≈ 4+. v1 line counts are for the
source files only.

| # | Feature | v1 source (lines) | v2 target | Effort |
|---|---|---|---|---|
| P1 ✅ | Room policy (phase + state) | `overseer/policy/*` (279) | `processes/sense/policy.js`, targets in `config.policy`, result in `rc.policy`; upgrade + fortify gated | S |
| P2 ✅ | Mission refresh throttling | `board/utils/missionThrottle.js` (56) | Per-generator interval in `config.missions.every`, reuse in `plan/missions.js` | S |
| P3 ✅ | Traffic manager | `traffic/*`, `utils/movement.js` (1,019) | `services/traffic.js` + `act/traffic.js` (after all creeps act) | M |
| P4 ✅ | Core lane logistics | `mission.logisticsCoreV2.js`, `role.coreLaneHauler.js` (3,469) | `services/lanes*.js`, `laneStore.js`, `plan/lanes.js` (burst), `missions/coreLane.js`, action `lane` (~1,200 lines in total) | L |
| P5 ✅ | Mining lane logistics | `mission.logisticsMiningV2.js`, `role.miningLaneHauler.js`, `utils/creepLaneMovement.js` (1,367) | Reuse `services/lanes.js`, then `missions/miningLane.js`; replaces `fleet.js` haul routes from phase STORAGE | M |
| P6 | Early-game "simple" variants | `logisticsSimple*`, `simpleHarvest`, `role.simple*` (2,635) | **Not ported as code.** Covered by v2's existing harvest/logistics plus P1 phase settings | S |
| P7 | Fortify | `mission.fortify.js` (498) | Merge into `missions/repair.js` as a fortify mode, gated by P1 state | S |
| P8 | Scout | `mission.scout`, `role.scout`, `overseer.scout` (651) | `missions/scout.js`, writes to `sense/intel` | S |
| P9 | Remotes: reserve / harvest / haul / build | `mission.remote*`, `role.remote*`, `overseer.remote*` (3,946) | `missions/remote/{reserve,harvest,haul,build}.js`, `services/remotePath.js`; room kind `remote` per DESIGN §18.1 | L |
| P10 | Minerals | `mission.mineral`, `role.mineralMiner` (378) | `missions/mineral.js` + storage routes in `logistics.js` | S |
| P11 | Terminal | `manager.terminal.js` (1,156) | `processes/act/terminal.js` (balancing) + terminal jobs on the core lane | M |
| P12 | Labs (auto in/out, clear, reverse, boost stock) | `manager.labs.js`, `labs.reverse.js` (1,226) | `processes/plan/labs.js` (pick reaction) + `act/labs.js` (run) + lab fill/clear missions | M |
| P13 | Ramparts | `manager.ramparts.js` (29) | Fold into `plan/construction.js` | S |
| P14 | Telemetry / console extras | `telemetry/*`, `console/*` (2,908) | Only the missing commands; telemetry is already in `kernel/telemetry.js` | S |
| P15 | Empire layer (zeadmin) | `managers/zeadmin/*` (1,816) | Shard-scope processes, DESIGN §16 phase 4 | L, later |
| P16 | Military (admiral, assault, defender) | `managers/admiral/*`, roles (12,412) | Still on hold; DESIGN §13 / phase 3 | L, later |

Already in v2 with no port needed: harvest, build, repair, upgrade, tower,
links (`act/links.js`), spawning contracts, safe mode, census, intel.

## 4. Order

```
Wave A (foundations)        Wave B (economy depth)       Wave C (growth)          Later
P1 policy ─┬─► P7 fortify   P4 core lane ─► P11 terminal  P8 scout ─► P9 remotes   P15 empire
P2 cadence │   P6 settings  P5 mining lane               P10 minerals             P16 military
P3 traffic ┘   P13 ramparts                              P12 labs
```

- **Wave A** is small and every later item needs it. P1 decides the bootstrap → full-economy switch, and P3 is a dependency of the lanes.
- **Wave B** does what the core lane hauler did. P11 depends on P4 because v1 runs terminal jobs on the core lane.
- **Wave C** matches DESIGN §16 phase 2's exit criteria (2 remotes per room within 20 CPU).

## 5. Item notes

**P1 Room policy. ✅ Done** (`processes/sense/policy.js`, `test/policy.test.js`).
- SENSE process after census. Writes `rc.policy = {phase, state, reasons}`. Previous state is kept in `Memory.rooms[n].ps` for hysteresis.
- Phase is ported as-is: BOOTSTRAP → EARLY → BASIC_INFRA → STORAGE → LINKS → TERMINAL → LABS. `policy.atLeast(p, phase)` compares phases.
- State: DEFENSIVE / CRITICAL / RECOVER / STOCKPILE / GROW. SIEGE can only be set from the console until a combat layer exists.
- Stockpile targets per RCL and the ±10% hysteresis are in `config.policy`.
- Creep counts come from census archetypes, not roles.
- Changes from v1, all to stop the state flipping back and forth:
  - Hostiles with no ATTACK, RANGED_ATTACK, HEAL, WORK or CLAIM parts don't count as a threat.
  - Low spawn energy only means RECOVER once the room has extensions.
  - Phase BOOTSTRAP alone doesn't mean RECOVER. A drop-mining room with a healthy workforce keeps upgrading.
- Upgrade:
  - GROW: full upgrade, still subject to v2's UPGRADING/STOCKPILING economy state.
  - RECOVER / DEFENSIVE / SIEGE: 1 WORK.
  - CRITICAL / STOCKPILE: keep existing upgraders but spawn none, unless the controller is close to downgrading.
- Fortify:
  - DEFENSIVE / SIEGE: always on.
  - CRITICAL / STOCKPILE: off.
  - RECOVER: existing fortifiers keep going, but no new spawns.
  - Otherwise: only from phase STORAGE.
- Console: `policy.show()`, `policy.set(room, state)`, `policy.clear(room)`. The phase and state are also in the stats segment.
- Still to do in later items: phase choosing the logistics mode (P4/P5/P6).

**P2 Refresh intervals. ✅ Done** (`test/planning.test.js`).
- Each generator reuses its last output until its interval in `config.missions.every` runs out. The values are v1's: tower 1, logistics 7, fleet 11, upgrade 11, build 17, harvest 21, repair 25, others 31.
- All generators refresh straight away when any of these change: op or economy state, policy, RCL, energy capacity, site count, or whether hostiles are present. Logistics also refreshes when spawn energy drops below capacity, so refills start at once.
- Simulator: planning went from 0.027 to 0.006 ms per tick with the same economy.

**P3 Traffic. ✅ Done** (`services/traffic.js`, `processes/act/traffic.js`, `test/traffic.test.js`).
- Rewritten from the vendored manager instead of copying it. Same depth-first swap/shove search and working-area preference. State lives in a per-tick heap store, not on room or creep objects.
- `movement.to` registers each step and still calls `creep.move`. If `act.traffic` is off (`config.traffic.enabled`) or fails, creeps move exactly as before.
- `act.traffic` runs once per shard, after `act.creeps`, and resolves every room where something wants to move.
- Every one of my creeps can be moved aside unless it's pinned, tired or has no MOVE. Actions mark a working area once in range. Harvesting creeps are pinned, so miners stay on their containers.
- Movement now spots when a creep was shoved off its path and repaths, instead of following the old path from the wrong tile.
- Shove directions are tried in a fixed rotating order, not at random.
- The simulator now lets a creep step into a tile vacated in the same tick, as the real game does.
- Results: in a one-tile lane, an idle creep no longer blocks a hauler. On the open simulator room the economy is unchanged and traffic costs about 0.025 ms per tick.

**Existing rooms (decided 2026-10-23).** Three live rooms are already built around a core lane, with extensions placed along it, which the lane hauler keeps supplied. The design exists to cut traffic. P4/P5 port the **behaviour** first: they run on the lanes and flags already in those rooms and don't move or add structures. Whether the automatic stamp/room planner (DESIGN §12.1) can produce the same layout is a separate later question.

What the live layout looks like (screenshot of one room, 2026-10-23):
- The spawns and storage sit at the top of the core.
- From there a diagonal road loop runs down and back up through about 60 extensions, which are packed on both sides so every one touches the lane.
- The labs are a separate cluster under the `CORE_LABS` flag.
- Mining roads come in from each source to the edge of the core.

So the core lane hauler only works if it follows the loop in one direction and fills every extension next to it as it passes. Traffic (P3) matters most where the mining roads meet the loop.

Before v2 runs in those rooms, check `plan.construction` (the phase-1 stamp builder). Extensions, towers and storage are capped per RCL and will already be at the cap there, so only roads and containers are at risk. It could still add roads from the spawn to the sources and controller, and a container at the end of each road. If that's unwanted, set `config.set('construction.enabled', false)` until the planner understands the lane layout.

**P4 Core lane. ✅ Done for refilling** (`test/coreLane.test.js`). Side jobs on the lane are still to do: terminal stock (P11) and lab hauling (P12).
- **Lane discovery** (`services/lanes.js`, `laneSearch.js`, `laneGeo.js`) is v1's algorithm with v1's constants: the same head rules, candidate ends (service roads, bridge roads, the farthest road), routes through one or two waypoints, coverage scoring, and the loop join. A `CORE_END*` flag in the room still overrides the end. Like the live rooms, no flag is needed.
- **Building** (`plan.lanes`) is a burst process. It works on one room at a time at `config.lanes.cpuPerTick` (10), resumes across ticks, and saves the lane to `Memory.rooms[n].ln`. It rebuilds when the room signature changes (checked every 50 ticks) or every 5,000 ticks (v1: every 500, because v1 kept the lane only on heap). Simulator room with 40 extensions: about 800 PathFinder searches per full search.
- **Lane hauler** (`missions/coreLane.js`, archetype `laneHauler`, road body of 2 CARRY per MOVE up to 33 CARRY, one per room, priority 92):
  - LOAD: withdraw at the head from storage, or the head link.
  - DELIVER: fill the stop at each lane index. A straight lane is walked to its end. On a loop the hauler goes to the nearest stop that needs energy, either way round.
  - RETURN: walk back to the head and empty into storage.
  - When idle it parks at the head, drains the head link, and renews at the adjacent spawn between TTL 1100 and 1450.
- **Logistics** leaves the lane's targets and the head link to the lane hauler while one is alive and storage holds at least 1,000 energy. Otherwise the fleet refills them as before.
- Changes from v1:
  - The lane mission stays up in CRITICAL while a lane hauler is alive.
  - After a transfer that satisfies a stop, the hauler steps on in the same tick, and it starts walking in the same tick it withdraws.
  - A bootstrap-sized hauler (under half the target CARRY) gets a full-size replacement and then retires. v1 kept it for its whole life.
  - Lane-local yield/swap is replaced by `services/traffic`.
- Bugs found while testing and fixed:
  - The hauler set off without refilling the spawn next to the head.
  - The spawn's demand, ignored while renewing (v1 rule), was also skipped on the way out, so renews drained extensions.
- Simulator now has `renewCreep` and `suicide`, and deterministic runs seed `Math.random`. That fixed a 1-in-10 flaky test that was there before P4.

Original plan for P4, kept for reference:
- Split into:
  - `services/lanes.js` (lane search with v1's costs PLAIN 20, SWAMP 45, ROAD 4; candidate limits; rebuild every 500 ticks; cached in a heap/segment store)
  - `missions/coreLane.js` (job queue with v1's `CORE_SERVICE_JOB_PRIORITY`)
  - actions (`load`, `deliver`, `return`)
- Renewing at the spawn becomes a shared `renew` action, gated by TTL (1100 / 1450).
- Use the same `CORE_END` / `CORE_LABS` flag names until the room planner (DESIGN §12.1) places the lane itself.
- Target is about 800 lines in total, down from 3,469.

**P5 Mining lane. ✅ Done** (`missions/miningLane.js`, action `mlane`, `test/miningLane.test.js`).
- From phase STORAGE (not CRITICAL), every source with a container gets mission `mlane:<source>`, archetype `miningHauler` (normal hauler body).
- Fixed path from the container to the nearest sink (storage, else a non-mining container). Costs: plain 10, swamp 30, road 2. The core lane head costs 200 and tiles next to sources are blocked.
- 1–3 haulers sized for 10 energy per tick over the round trip. They wait at the container for a full load (part-full only at TTL ≤ 80), walk the path, and unload into the sink.
- Link sources (a link within 2 and another link away from all sources): one 1-CARRY hauler stands next to both the container and the link and moves energy from one to the other.
- Once a lane has a live hauler, fleet sizing skips that source (fleet minimum becomes 1) and logistics drops its mining routes. Policy and spawning count `miningHauler` and `laneHauler` as haulers.
- Changes from v1: the path is cached on heap with a signature (v1 rebuilt every 100 ticks); moves go through `services/traffic`; on/off switch `config.lanes.mining`.
- Simulator, two remote-ish sources at RCL 4, 500 ticks: with the fleet, storage went down 3,550 while the containers sat close to full (3,125 on average). With mining lanes, storage went up 4,427 and the containers averaged 1,737.

**P6 Simple variants.**
- Diff v1's simple missions against v2's harvest/logistics.
- Any early-game behaviour v2 is missing becomes a setting by phase, not a new mission.

**P9 Remotes.**
- Reuse v1's `overseer.remoteHaulPathing` cost model inside `services/remotePath.js`.
- Mission `home` is the parent room and `room` is the remote, per DESIGN §18.1.
- Reserve renews below 2000 ticks, as in v1.

**P12 Labs.**
- Keep v1's stable mission names, so a hauler isn't released halfway through a fill or clear.
- Keep boost-lab stocking separate from the reaction mode.
- Keep the "empty but wrong mineral is fine" rule.

## 6. Done means

For each item:
1. `npm test` passes, with a new or extended test covering it.
2. Its CPU shows up under its own process name in `kernel/telemetry`.
3. No file goes over 400 lines.
4. No new `room.find` in missions or actions.
5. A row is added to the DESIGN §15 mapping, and this table is marked ✅.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Lane logic depends on v1 flag placement | Keep flag names; replace with the planner in phase 2 |
| Traffic manager adds CPU per creep | Measure in sim with and without it; let only moving creeps opt in |
| Hidden behaviour in 3.5k lines of core lane code | Before porting, write the v1 job list and states down as a test table |
| v1 branch keeps changing | Port from `12f11c4`; any newer v1 commits get a separate diff review |
