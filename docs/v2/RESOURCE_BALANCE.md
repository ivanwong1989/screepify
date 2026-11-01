# Demand-limited production and energy exports

The 31 October 2026 shard3 snapshot (tick 83979988, approximately 15:41 Asia/Kuala_Lumpur) showed idle labs with 10,360 Z in W44S28's terminal and none in storage. The old planner picked ZK from historical prices even though executable bids did not support its sales floor. Untargeted terminal minerals had no logistics offer. Meanwhile energy balancing could redistribute energy but could not remove empire-wide surplus.

## Behavior

- An unmanaged terminal reagent can supply an actual lab request. The offer is restricted to those lab destinations, excludes outgoing hauling commitments and advertised sales, and cannot become a general terminal-to-storage drain. Explicit terminal bands still take priority.
- Automatic lab recipes need either an explicit `labs.production.stock[product]` target or a configured `market.sell[product].mode = 'deal'` exit. Production for a sell order alone is disabled because it does not establish an executable buyer.
- Market production requires at least 1,000 units of clean buy depth, net of transport energy, above both the seller's actual floor (including its slow-drop anchor) and a 20% margin over reagent references. Already-made surplus and active sales consume demand depth. Production is bounded to a 5,000-unit target above retained stock, subject to the existing product cap. ZK has a 1,000-unit deal sales policy; this does not force it to be produced.
- Complement purchases use the same consumer decision. Quantities cover only the unmet consumer target plus the existing 2,000 reagent reserve, less partner stock already held, within the existing budget and order guards. A qualified recipe can start with a minimum batch plus its reagent reserve instead of requiring the legacy 10,000 units. Explicit product stock targets are also retained by terminal staging and selling.
- Energy export uses own sell orders; buyers pay transaction energy. Start above 450,000 buffered energy, stop at 400,000, preserve at least 300,000 in storage. Buffered energy is storage + terminal minus the ordinary terminal target, so moving energy into or out of the terminal cannot trigger a hysteresis loop. Exporting stages up to 50,000 energy in the terminal and advertises at most 5,000 staged surplus per order, leaving the existing 10,000 terminal floor.
- Export is limited to owned GROW rooms. Defense, reserve breaches, exporter disablement, global market disablement, or `market.stop('energy')` cancel automatic orders. An explicit energy sales specification takes precedence. Existing completed orders are reused. Listing and repricing fees share a credit budget across exporting rooms and preserve `market.buy.creditReserve`.
- Terminal sales targets include the hauling ledger so goods in transit do not cause target oscillation. Telemetry room records include `production` decisions and `energyExport` state/reasons. No extra market-book reads occur in the per-tick reporting path; production buy books are cached for 50 ticks and export uses the existing 50-tick market cadence.

## Offline confirmation

Run `node scripts/replay-resources.js`. It uses the sanitized saved snapshot under `test/fixtures/economy`; it does not read credentials or contact Screeps. Transaction energy is modeled as 10% of the amount. These are replay outcomes, not current readings or proof that buyers will fill an order.

| Snapshot room | Storage energy | Buffered energy | Replay export |
| --- | ---: | ---: | --- |
| W43S28 | 470,809 | 470,809 | 5,000-unit offer, 50,000 terminal target |
| W44S28 | 467,159 | 465,909 | 5,000-unit offer, 50,000 terminal target |
| W44S29 | 329,602 | 331,542 | Protected, ordinary terminal target |

The saved book rejects ZK production: reference 134.787, sales floor 121.308, profitable clean depth zero. An explicitly selected ZK recipe produces a valid 500-unit terminal-to-input-lab Z job; this isolates reagent routing without pretending automatic production is justified by that market.

The simulator additionally checks a terminal-only 4,500 Z supply: a 2,500 ZK consumer target plus the protected raw reserve, below the old startup threshold. It runs reactions, reaches the target with bounded planning-cadence overshoot, accounts for every unit, and trips no logistics flip guard. Market scenarios cover profitable and unprofitable buyers, transport costs, anchored seller floors, product stock retention, pending sales, outgoing/incoming hauling, complement budgets, protected rooms and disable controls. A repeated buyer-fill scenario sells 70,000 energy from W43S28 in 5,000-unit batches and leaves buffered energy at 400,809; its remaining sub-1,000 surplus is not listed.

## Limits and rollout

This branch builds on deployed mining commit `62ef5a55c4e1252963c4c69abbf02606c3a26243`; it does not deploy itself or write live Memory. Local validation cannot establish current buyer demand or in-game CPU costs. Lab targets are evaluated on the existing 100-tick cadence, so output can exceed a target by work performed before the next plan. Buy depth is evaluated per room, without an empire-wide reservation across multiple lab rooms; currently W44S28 is the production room. Existing untracked complement buy orders are not automatically canceled; inspect them before deployment. Existing mineral sell orders continue under their configured policies.

After an authorized deployment, verify actual energy fills, the energy reserve band, complementary purchase spend, lab reasons and segment-90 process CPU/bucket. Poorly priced markets should leave labs intentionally idle. Energy sell orders need real buyers; this change does not guarantee a storage drain rate or solve every mineral stockpile. Factory batteries and power processing remain outside this change.
