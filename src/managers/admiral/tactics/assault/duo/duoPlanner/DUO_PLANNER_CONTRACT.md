# Duo Planner Contract (Phase 0)

Purpose: Define the planner/executor contract before any behavioral changes.

## Principles
- `duoPlanner` is the single authoritative movement planner for a duo.
- The duo (leader + support) is treated as one 2-tile unit.
- Each tick, the planner outputs primitive movement steps only.
- The executor (`role.assault.js`) executes the plan and does not call `moveTo` during cohesive duo movement.
- Default safety: HOLD over desync; fallback `moveTo` only if explicitly allowed.

## Request Schema (mission-agnostic)
```
request = {
  leader: Creep,
  support: Creep,
  memoryKey: "duo:<stableId>",
  goal: {
    pos: RoomPosition,
    type: "RANGE" | "OCCUPY",     // default RANGE
    range: number                // default 1 (used when type=RANGE)
  },
  formation: {
    cohesionRange: 1,            // default 1
    anchor: "leader",
    supportOffset: "auto",       // behind|left|right|auto
    allowSwap: true
  },
  movement: {
    allowSplit: false,           // default false
    usePathCache: true,
    pathReuseTicks: 25,
    stallRepathTicks: 2,
    preferRoads: true
  },
  runtime: {
    roomCallback?: (roomName)=>CostMatrix | false
  },
  debug: boolean
}
```

## Plan Output (executed by role.assault.js)
```
plan = {
  ok: boolean,
  reason: string,
  mode: "COHESIVE_TRAVEL" | "REGROUP" | "BORDER_HANDSHAKE" | "HOLD" | "FALLBACK",
  cohesive: boolean,
  sameRoom: boolean,
  dist: number,
  step: {
    leaderDir: number | null,
    supportDir: number | null,
    leaderTo: RoomPosition | null,
    supportTo: RoomPosition | null
  },
  meta: {
    goalKey: string,
    usedPath: boolean,
    pathIndex: number,
    stalledTicks: number,
    allowFallbackMoveTo: boolean
  },
  debug?: {...}
}
```

## Success Criteria (Phase 0 target)
- `range(leader, support) <= 1` whenever `allowSplit=false`.
- No border deadlock; split rooms converge and cross together.
- Multi-room travel works without drift when following cached steps.
- Single-tile goals do not break formation (default RANGE behavior).

