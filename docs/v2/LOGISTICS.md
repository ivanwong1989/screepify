# Screepify v2 — Logistics: requests, bands and the ledger

> Status: **proposal**. It replaces the per-feature storage/terminal rules from P4, P10 and P11 before any of them is deployed. It extends [DESIGN.md](DESIGN.md) §6 (ctx) and §9 (tasks).

## 1. The problem

Every building that holds resources wants some amount of something: extensions want energy, the terminal wants 20k energy and some minerals, labs want reagents and want their product taken away, storage takes whatever is left over. Today each feature decides for itself where things go:

| Writer | Rule |
|---|---|
| `coreLane.dumpCargo` | leftovers → storage, else terminal |
| `missions/transfer.js` | non-energy cargo → **terminal**, else storage |
| `missions/mineral.js` | loads → storage, else terminal |
| `laneStock` (P11) | storage ↔ terminal toward targets, energy target exact |

Loops come from three things:

1. **Several writers with different rules for the same resource.** One puts X in the terminal and another moves it back to storage.
2. **Exact thresholds.** Moving the target one tick away from its threshold makes it want the opposite move. Fees, sends, spawning and towers nudge amounts all the time.
3. **Not counting what's in flight.** A hauler takes 1,650 out and the source suddenly looks short, so something refills it. Or two haulers fill the same deficit.

v1 had all three.

## 2. The model

### 2.1 Every store has a band per resource

For each (structure, resource) a pure rule gives three numbers: **min ≤ target ≤ max**.

```
amount:  0 ─────── min ═══════ target ═══════ max ─────── capacity
                    ▲ request         neutral          ▲ offer
         below min: REQUEST (target − amount)   above max: OFFER (amount − target)
```

- **Below min** the store *requests* enough to reach **target**.
- **Above max** it *offers* everything above **target**.
- **In between** nothing happens. That gap is the hysteresis.

| Store | Energy band | Other resources |
|---|---|---|
| spawn, extension | min = target = max = capacity (always top up) | — |
| tower | min 70%, target = max = 100% | — |
| terminal | e.g. 18k / 20k / 22k (config) | config targets, deadband 5% (50–2000) |
| lab (P12) | min = target = max = 2000 | reagent: request to the reaction amount; product: offer above 0; wrong mineral: offer all |
| container at a source | offers above 0 (mining) | offers all |
| controller container | min 50%, target 100% | — |
| link | not here: links move by `act.links`, the head link just offers |
| **storage** | the **buffer**: no band; it absorbs every offer nobody requests and fills every request nobody offers | same |

The rule that stops ping-pong:

> **A move goes from an offer (or the buffer) to a request (or the buffer), never between two buffers, and its amount is at most min(offer down to target, request up to target).**

After the move the source sits at or above its target, which is ≥ its min, so it doesn't request anything back. The destination sits at or below its target, which is ≤ its max, so it doesn't offer anything back. That holds as long as **min ≤ target ≤ max** for every store and only one model decides. Small outside changes (a terminal fee, a tower shot) stay inside the band and trigger nothing.

### 2.2 The ledger: effective amounts

All decisions use the **effective** amount, never the raw store:

```
effective(id, res) = store[res] + incoming(id, res) − outgoing(id, res)
```

`incoming` and `outgoing` are rebuilt every tick from the creeps themselves (their current task plus what they carry), like `census.reserved` today. Nothing is stored that could go stale: a dead creep's reservation disappears with it.

- A hauler that has just taken 1,650 from the terminal is "outgoing 1,650" until it withdraws, then it carries the cargo and is "incoming 1,650" at its destination until it delivers. The terminal never looks short in between, so nothing refills it.
- Two haulers can't fill the same deficit: the second one sees the first one's incoming.

### 2.3 Jobs are committed

A move becomes a **job**: `{res, amount, from, to}` on the creep (`memory.t`, so the existing task contract stays).

- A hauler decides **before it withdraws**. Once it carries cargo for a job, it delivers it there.
- If the destination stops wanting it (destroyed, full), the cargo goes to the **best other request for that resource**, and only then to the buffer.
- Higher-priority demand (extensions while spawning) is handled by choosing what to pick up next, not by dropping what's already carried. For the lane hauler, a stock trip at the head takes two ticks, so it finishes first.

This removes "picked up X, demand appeared, dumped X back into storage, picked X up again".

### 2.4 One writer

| Piece | Kind | Writes / does |
|---|---|---|
| `services/bands.js` | service (pure) | `band(structure, res, cfg)` → `{min, target, max}`; storage is the buffer |
| `services/ledger.js` | service (pure) | incoming/outgoing from creeps' tasks + cargo; `effective()` |
| `sense.logistics` | SENSE process, room, cadence 1–5 | `rc.requests`: per resource, the requests and offers (id, amount, priority), using effective amounts |
| `services/matcher.js` | service (pure) | pairs offers with requests by priority and distance; `bestFor(creep, rc, filter)` |
| haulers (lane, fleet, logistics, lab hauler) | missions | take jobs from the matcher; **no own rules about where things go** |
| `act.terminal` | process | only terminal → terminal sends; it changes amounts, and the bands absorb that |

`missions/transfer.js`, `coreLane.dumpCargo`, the mineral miner's delivery and `laneStock` stop choosing destinations themselves. They ask the matcher, which falls back to the buffer.

Request priority (high first): spawns/extensions → towers → boost labs → reaction labs → terminal → controller container → buffer.

## 3. Your three questions

| Situation | What happens |
|---|---|
| Different buildings want different amounts | Each has its own band per resource. They never compete through separate code, only as requests in the same list, ordered by priority. |
| The hauler takes some out and the source drops below threshold | It only takes from an **offer**, and only down to target, which is above min. The outgoing amount is counted from the moment the job is picked, so the source's effective amount never crosses its min. |
| The other way round (a store goes above threshold after a delivery) | Deliveries only go up to target, which is ≤ max. Incoming is counted from the moment the job is picked, so a second hauler won't overfill it. |
| Something outside changes amounts (sends, fees, spawning, towers) | Inside the band: nothing. Outside: one normal move back to target. |

## 4. Tests that prove it

- **Property test:** random stores, bands, outside changes and haulers in the simulator for thousands of ticks. Assert that no (resource, structure pair) ever has a move A→B followed by B→A within N ticks, unless an outside change put a store outside its band in between.
- **Unit:** `min ≤ target ≤ max` for every band rule and config; move amounts never cross the other side's target.
- **Sim:** existing lane, terminal and mineral tests keep passing with the matcher in place of the old rules.

## 5. Plan

| Step | Scope |
|---|---|
| L1 | `bands`, `ledger`, `sense.logistics` (`rc.requests`), `matcher`; property test. No behaviour change yet |
| L2 | Core lane hauler: head side jobs (terminal, head link) and leftover cargo through the matcher; drop `laneStock` and `dumpCargo` rules |
| L3 | `transfer.js`, mineral miner delivery and logistics supply through the matcher |
| L4 | P12 labs as bands (reagent requests, product offers, boost stock), with no new hauling rules |

P11's balancing (`act.terminal`) and the terminal targets carry over unchanged as config. Only how they get moved changes.
