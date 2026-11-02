# Boost baseline and recipe chains

A lab room keeps a reserve of boosts for its own defense and attack
(`labs.rooms[room].reserve`, in priority order). Live default, W44S28:

| Boost | Role | Tier | Reserve |
| --- | --- | --- | ---: |
| XLHO2 | heal | 3 | 10,000 |
| XGHO2 | tough | 3 | 10,000 |
| KHO2 | ranged attack | 2 | 3,000 |
| UH2O | attack | 2 | 3,000 |
| ZHO2 | move | 2 | 2,000 |

## Rules (`services/labChain`, `plan.labs`)

1. **The reserve is never spent.** Selling keeps at least the reserve
   (`market.sellKeep`). Sale reactions and partner buying see only stock above
   it (`labChain.free`).
2. **The reserve is refilled first.** `plan.labs` walks the recipe tree from
   the first short boost. A reaction runs when both reagents (above their own
   reserve) cover the amount still needed. A short compound reagent is made
   first, all of what is needed, so the labs don't alternate. A short base
   mineral is wanted from the market.
3. **Reagents are shared.** What one target will use is taken out before the
   next target is planned. With two tier 3 boosts short, the X wanted covers
   both.
4. **No switching back and forth.** The running reaction is kept while both
   of its reagents last. Stock carried by creeps counts as room stock. Each
   rule alone stops the LHO2 → XLHO2 → LHO2 flip that the sim test caught.
5. **Buying (`act.marketBuy` 2b).** Wanted base minerals are bought by deal
   into the lab room, in amounts rounded up to 100 (at least 1,000). The usual
   ceiling, 270M credit floor and daily cap apply. Nothing is bought again
   until a plan made after the purchase still wants it.
6. When the reserve is full, the labs fall back to sale production
   (`productionMarket`) as before.

Segment 90 `rooms[room].baseline` shows `short`, `wants`, `step` and `reason`
(`reserve_full`, `reserve_refill`, `reserve_waiting_for_reagents`).

## Live estimate (2026-11-02 stock)

Short: XLHO2 3,165, XGHO2 2,690, UH2O 3,000, ZHO2 2,000. First step:
LO + OH → LHO2 (1,300), then XLHO2. To buy: about 855 X and 2,316 U
(about 0.22M credits). Reaction times: LHO2 5, XLHO2 60, XGHO2 150, UH2O 5,
ZHO2 5 ticks.

## Not yet

Sale chains (whole chains judged on the final product's price, e.g. spare
KHO2 and KO → XKHO2), and pacing sales of tier 3 boosts.
