# Screepify v2 — Auto market

> Status: implemented (`services/market.js`, `processes/act/market.js`, `console/market.js`, `test/market.test.js`). Ported from v1's `manager.terminal` sell path on `dev_make_missions_missions`, plus own sell orders.

## What the market looked like (shard3, 2026-10-26)

| Resource | Buy orders | Best buy | Recent trading |
|---|---|---|---|
| KO (our lab product) | none | — | sellers at ~32.9; 51–1,268 units/day |
| O | 10+ | 18.05 | liquid |
| K | 3 | 11.38 | thin |
| energy | — | — | ~15–21 credits |

- **The player who calls `deal` pays the transfer energy.** Every buyer was 40–80 rooms away. With energy at ~17 credits, selling O into the best buy order netted **5.24** per unit after the fee (headline 18.05), and K came out **negative**.
- With **our own sell order**, the buyer pays the transfer; we get the full price minus the 5% listing fee.

So every resource defaults to **own sell orders**. Selling into buy orders (deals) is still available per resource, judged after the fee, for when there are buyers nearby.

## Rules

| Rule | Detail |
|---|---|
| What is sold | `config.market.sell[res] = {mode, keep, batch?, minPrice?}`. Only the surplus above `keep` (storage + terminal of the room) |
| Floor | max(`minPrice`, `floorFactor` × volume-weighted average of the last `historyDays` days). No history and no `minPrice`: not sold |
| Deal mode | Best buy order by **price after the energy fee** (`price − fee × energyValue / amount`, v1), at or above the floor; never our own orders; one deal of up to `batch` per room per run; terminal keeps `minTerminalEnergy` |
| Order mode | One sell order per resource, in the room with the largest surplus, priced 1% under the cheapest competing seller and never below the floor (no competitor: max(floor, average)). Topped up to `orderSize` when below half; re-priced every `orderRefresh` ticks if the price moved > 0.5% |
| Energy value | `energyValue: 'auto'` = recent energy price |
| Terminal stock | What a room sells is stocked in its terminal through the logistics bands: up to `terminalStock`, rounded up to 1,000s of the surplus |
| Skipped | Rooms in CRITICAL; deals from terminals on cooldown |
| Cadence | `act.market`, low tier, every 50 ticks (`getAllOrders` costs real CPU) |

Defaults: KO keep 2,000; O and K keep 100,000; floor 0.9 × 3-day average; order size 5,000; re-price every 500 ticks.

## Console

`market.show()`, `market.sell(res, keep, mode?, minPrice?)`, `market.stop(res)`, `market.on()`, `market.off()`. Every deal and order change is logged as `[market] …`.
