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

## Guarding against manipulation

Bots list many lines of one product at absurd prices, post tiny bait orders, or trade with themselves to move averages. A careful human trusts **trades over listings**, ignores what's absurd, looks at **depth** rather than the top line, and doesn't panic-drop. The rules do the same:

| Attack | Guard | Config |
|---|---|---|
| Many listings at absurd low or high prices | Order-book entries outside 0.5×–2× the trade reference are ignored | `bandLow`, `bandHigh` |
| One player listing the same price many times | One entry per (room, price) | — |
| Tiny bait order at the top of the book | Listings under max(1,000, 10% of our order) ignored; we price **1% under the depth price**, the level where enough real volume is listed to fill an order our size | `minListing`, `orderSize` |
| Wash trades moving the averages | Reference = max(recent 3-day average, 0.85 × **median of the last 14 daily averages**). One fake day can't move a median; it takes over half the window (8 of 14 days). Under 50 trades in 14 days: no market price at all | `historyDays`, `longDays`, `longShare`, `minTrades` |
| A crash, real or staged | Our floor falls at most **5% per day** from what it was (`Memory.rooms[room].mk`); rises at once | `maxDropPerDay` |
| Thin products (KO: 11 trades in 14 days) | Floor = the value of its reagents | — |
| Labs making something worth less than its inputs | Auto reactions only for products whose trade price beats their reagents by 5%; an unpriced (thin) product isn't made. A configured reaction isn't second-guessed; with no market data at all (private server) reactions are allowed | `productMargin` |
| Anything else | `minPrice` per resource always wins | — |

Floor = max(`minPrice`, 0.9 × reference, reagents' value), then the daily-drop limit. `market.show()` prints every part: trades, recent, median, reference, reagents, floor, how many listings were ignored, and the depth price.

### Dry run on live shard3 data (2026-10-26)

| | Trades (14 d) | Reference | Floor | Listings → kept | Depth | Our price |
|---|---|---|---|---|---|---|
| O | 30,178 | 18.15 | 16.33 | 59 → 24 | 15.52 | 16.33 |
| K | 16,762 | 15.38 | 13.84 | 40 → 23 | 13.49 | 13.84 |
| KO | 11 (thin) | none | 33.52 (K + O) | 19 → 11 | 40.15 | 39.75 |

The cheapest KO listings (32.86) were 4 and 85 units: bait. The labs would stop making KO: with no trusted trade price, it can't be shown to be worth more than K + O.

## Rules

| Rule | Detail |
|---|---|
| What is sold | `config.market.sell[res] = {mode, keep, batch?, minPrice?}`. Only the surplus above `keep` (storage + terminal of the room) |
| Floor | See above. No reference, no reagent value and no `minPrice`: not sold |
| Deal mode | Best (cleaned) buy order by **price after the energy fee** (`price − fee × energyValue / amount`, v1), at or above the floor; never our own orders; one deal of up to `batch` per room per run; terminal keeps `minTerminalEnergy` |
| Order mode | One sell order per resource, in the room with the largest surplus, priced 1% under the depth price of the cleaned order book and never below the floor (no real competition: max(floor, reference)). Topped up to `orderSize` when below half; re-priced every `orderRefresh` ticks if the price moved > 0.5% |
| Energy value | `energyValue: 'auto'` = recent energy price |
| Terminal stock | What a room sells is stocked in its terminal through the logistics bands: up to `terminalStock`, rounded up to 1,000s of the surplus |
| Skipped | Rooms in CRITICAL; deals from terminals on cooldown |
| Cadence | `act.market`, low tier, every 50 ticks (`getAllOrders` costs real CPU) |

Defaults: **market off** until live prices are reviewed with `market.show()`; KO keep 2,000; O and K keep 100,000; order size 5,000; re-price every 500 ticks.

## Console

`market.show()`, `market.sell(res, keep, mode?, minPrice?)`, `market.stop(res)`, `market.on()`, `market.off()`. Every deal and order change is logged as `[market] …`.
