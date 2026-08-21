# Plan: HOT-50 — Counterparty exposure ignores trade direction

## Problem

`exposureByCounterparty` in `src/positions.ts` sums raw `t.volume` for every
trade regardless of `side`, so offsetting buys and sells inflate exposure
instead of netting. A counterparty with a 100 MWh buy and a 100 MWh sell shows
200 when the net position is 0.

## Changes

1. **`src/positions.ts`** — in `exposureByCounterparty`, accumulate the signed
   volume (reuse the module's existing `signedVolume` helper: buys +, sells −)
   instead of raw `t.volume`. Keep counterparties whose net exposure is 0 in
   the returned map — netted-flat is information, not absence. Update the
   function's doc comment to say the exposure is net signed volume.

2. **`test/positions.test.ts`** — update the `exposureByCounterparty` suite:
   - Fix the existing expectation if it assumed unsigned aggregation.
   - Add a mixed buy/sell case for one counterparty (e.g. buy 100, sell 30 →
     net 70).
   - Add a netted-to-zero case (buy 100, sell 100 → entry present with value 0).

## Out of scope

No changes to `netPositions`, `netPositionFor`, pricing, validation, or the
trade book. No new exports.

## Verification

`npm run typecheck` and `npm test` both pass; the three new/updated
expectations above are green.
