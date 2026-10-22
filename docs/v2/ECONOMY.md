# v2 economy port (phase 1)

v2 keeps v1's economy rules; only the machinery around them changed. This page
lists what was kept, what deliberately changed, and what isn't ported yet.

## Kept from v1 (same numbers, same rules)

| Area | v1 source → v2 file | Rules kept |
|---|---|---|
| Room state | `overseer.intel` → `processes/sense/intel.js` | EMERGENCY when no creeps / no miners / <300 energy with <2 creeps; STOCKPILING⇄UPGRADING hysteresis by RCL thresholds and storage fill (90% / 80%), `ecoOverride` |
| Harvest | `mission.harvest`, `exec/harvest` → `missions/harvest.js` | static / static_drop / mobile modes, 7 WORK target, one slot per open tile, slot 0 sits on the container, overflow slots drop, pre-spawn by travel time |
| Efficient sources | `overseer.missions` → `plan/missions.js` | same formula, including the bootstrap "best open source" rule |
| Hauler fleet | `mission.fleet_logistic` → `missions/fleet.js` | carry per source from path length, 5 CARRY floor (3 with links), min 2 haulers, 25 CARRY cap |
| Logistics | `mission.logistics`, `exec/transfer` → `missions/logistics.js`, `missions/transfer.js` | supply missions; haul routes with slots (≤3), route policies (min amount / max age), route continuity, local top-up, anti ping-pong, dump non-energy first |
| Upgrade | `mission.upgrade`, `mission.idleUpgrade` → `missions/upgrade.js` | 15 WORK while UPGRADING, trickle while STOCKPILING (spawn only near downgrade), 1 WORK while anything is being built, idle catch-all at −100 |
| Build | `mission.build` → `missions/build.js` | FIFO by first seen, 5 WORK (+2/RCL above 3), max 5 workers |
| Repair / fortify | `mission.repair`, opportunistic scanner → `missions/repair.js`, `sense/repairScan.js` | decay-based worker count, critical/attack boosts, sticky targets, RCL fortify targets, fortify only while UPGRADING or under attack |
| Opportunistic repair | `utils/creepOpportunisticRepair` → `missions/shared/oppRepair.js` | every other tick, > 50% energy, range 3, most damaged first |
| Vacate source | `_policy_vacate_source` → `missions/shared/vacate.js` | workers step off source tiles before working |
| Parking | `mission.decongest` → `missions/decongest.js` | `Parking*` flags, rings 1–3, −200 priority |
| Assignment | tasker + `reassignWorkers` → `plan/assignment.js` | priority band then closest, archetype + body-part checks, upgraders → build deficits, parked → deficits, idle/upgrade preemption |
| Spawning | spawn contracts / census / planner → `act/spawns.js` | pool / slot / mission contracts, near-death replacement (miners, haulers), 5-in-a-row rule, bootstrap/emergency budget, 100-tick grace before downsizing |
| Bodies | `manager.room.economy.spawner` → `services/body.js` | identical recipes and energy caps |
| Towers | `mission.tower` + tasker → `missions/tower.js`, `act/towers.js` | focus-fire scoring, quick-kill / healer-blocker targeting, shared heal/repair deficits, repair gating |
| Links | `manager.links` → `act/links.js` | source → controller/spawn/other links, > 600 per transfer |
| Safe mode | `safemodeManager` → `act/defense.js` | same three triggers |

## Deliberate changes

| Change | Why |
|---|---|
| **Sticky tasks.** A creep keeps its task until it finishes; the mission decides the next one only then | v1 re-decided every creep every tick, which was most of its CPU |
| **Mission planning every 2 ticks** (`proc.every('plan.missions', n)`) | Missions change slowly; assignment and creeps still run every tick |
| **Spawn/extension refill priority 80 → 90** (towers and link drain stay 95, emergency 900) | In simulation haulers preferred mining routes (85) and left the spawn half empty, stalling all spawning once extensions existed |
| **Miners can harvest and transfer in the same tick** | Separate intent pipelines; free throughput |
| **Opportunistic repair only while moving/carrying** | During upgrade/build/harvest it was overwritten by the main action anyway |
| **No spawn tickets.** Creep memory says which contract it fills | Removes `Memory.spawnTickets` and its cleanup |
| **Own movement library** (Traveler-style, DESIGN §11.1) instead of `moveTo` | Paths reused for many ticks; repath only when stuck |
| **Safe mode watches all owned rooms** (`config.set('safeMode.rooms', ['W1N1'])` to limit) | v1 hard-coded W44S28 |
| **Automatic layout + construction** (new; `config.set('construction.enabled', false)` to turn off) | Restart from scratch needs extensions/containers without manual placement |
| **Kernel starvation guard** | A process skipped for budget runs after 50 ticks regardless |
| **Creep memory** `{a, h, b, m, t, s}` (archetype, home, binding, mission, task, state) | Smaller Memory; v1 keys (`role`, `room`, `missionName`, `taskState`...) are gone after the v1→v2 wipe |
| Economy flow EMA and resource ledger dropped | v1 only logged them; no decision used them |

## Not ported yet

Phase 2: remote mining/reserving/hauling, scouting, minerals, labs, terminal and
market, terminal energy targets and mineral logistics, user flag missions
(dismantle, transfer, move2flag, claim/reserve), cross-room spawning.
Shelved (D3): admiral/military, defenders, assault.

## Simulator check

`test/helpers/sim.js` is a small single-room engine (spawning, movement,
harvest/transfer/withdraw/pickup/drop, build/repair/upgrade, controller levels,
regen, death). The same room was run with v1 (`master` dist) and v2.

| 8,000 ticks from a fresh RCL 1 room | v1 | v2, construction off | v2, construction on |
|---|---|---|---|
| Creep mix at the end | 10 miners, 3 haulers, 15 workers | 10 miners, 3 haulers, 15 workers | 4 miners, 3 haulers, 8 workers (bigger bodies) |
| Controller | RCL 2, 44.5k progress | RCL 3 (51.7k total) | RCL 3 by ~8,800 ticks, with 5 extensions + 3 containers built |
| Median time per tick in the simulator | 3.9 ms | 0.5 ms | 0.2 ms |

The time column is wall time in Node, not game CPU, and the simulator's
`moveTo` has no path reuse, which inflates v1's number. Real CPU still has to be
measured in game; `stats()` and the dashboard's v2 tab show it per process.
