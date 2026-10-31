# Mining position ownership and recovery

A source's spawn bindings (`memory.b`) identify staffing contracts. Physical
working positions are coordinated separately in rebuildable heap state.

`miningStations.reconcile` runs before the room's creep actions. It elects one
container owner and gives other active miners distinct, walkable source-adjacent
positions. Assignments retain healthy incumbents and existing valid positions.
An overflow miner cannot treat “already within one tile of the source” as having
vacated the container: all station moves use an exact packed position, range 0.

A same-contract replacement waits outside the source working positions. The
incumbent continues working until its replacement is adjacent and either the
incumbent has at most 30 TTL or its WORK capacity needs upgrading. A retained
overflow yields to a ready slot-0 miner. Conflicts and station/mode changes clear
incompatible sticky tasks. A heap reset reconstructs ownership from occupants,
living assignments and birth bindings without interrupting healthy harvest tasks.

Traffic and new path searches respect the current tick's station reservations.
A miner at its working position is pinned; a miner assigned to yield is not.
Waiting miners use staging tiles outside source and link-loader working positions.
An unavailable alternate working tile produces a wait, not mission completion or
additional spawn demand.

Harvest plans include source/container/link identities and hauling readiness in
their cache key. Static mining can be supported by a generic hauler, a dedicated
source mining hauler, or a source link with a receiver. Only active, local haulers
count. A 25-tick grace period avoids mode flapping during brief hauling gaps.
Source placement intel detects object replacements even at unchanged structure
counts. Spawn fulfillment retains valid birth contracts and redistributes surplus
WORK from obsolete bindings before asking for more source staffing.

## Telemetry and bounded recovery

Segment 90's existing `rooms[room].mining[sourceId]` object contains:

- `mode`, `owner`, actual `occupant`, miner names, assigned tiles and roles;
- `lastHarvest`, `successfulIntents100`, and `estimatedHarvest100`;
- active `work`, `reason`, and `blockedTicks`.

Energy is explicitly an estimate from successful harvest API intents, capped by
start-of-tick source energy. It is not an engine-resolved resource balance.

A stationary source with energy and nearby assigned static miners, but no
successful harvest for 20 ticks, is marked `position_blocked`. Recovery clears
stale tasks and reconstructs ownership, at most once per 50 ticks. Empty sources,
full containers, travel, missing miners and mobile delivery cycles have distinct
reasons and do not trigger positioning recovery. Recovery never adds spawn demand.
All coordination and health history rebuild after VM reset; no Memory migration
or manual colony-state reset is required.

## Verification

Run `npm run check`, `npm test`, `npm run build`, and
`node scripts/replay-mining.js`.

The replay fixtures capture all five sources in W43S28, W44S28 and W44S29 from
read-only API snapshots on 31 October 2026, approximately 08:32 MYT. Tests cover
normal operation, the exact W44S29 deadlock, replacements in every captured room,
one-tile sources, blocked alternates, obsolete spawn bindings, damage, hauling
loss/restoration, container destruction/replacement, stale tasks, reservations,
heap resets and bounded stall recovery.

These are offline source-pipeline replays using the repository simulator. They
resolve movement and energy intents, but omit fatigue, full link energy transport
and other Screeps engine details. Whole-bot simulations separately exercise
bootstrap, logistics, labs, core lanes, replacements and long runs. Actual game
CPU cost and live recovery must be measured after deployment.
