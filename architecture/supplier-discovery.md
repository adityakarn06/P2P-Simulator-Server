# Supplier Discovery & Ranking (Phase 5)

Turns an extracted `Requirement` into a committed `SourcingDecision` — matching free-text wording
to a catalog `Product`, scoring every supplier that offers it, and selecting a winner. Ranking is
pure deterministic TypeScript; Gemini is called once, *after* the winner is fixed, only to explain
the decision in business English.

Consumes the `supplier-discovery` queue, which
[Phase 4](./conversational-requirements.md) fills on reaching `REQUIREMENTS_EXTRACTED`.

## Flow

```text
Worker: processSupplierDiscoveryJob
  1. Load requisition (tenant-scoped) + requirement. State guards:
       SUPPLIER_SELECTED / PO_CREATED  -> return stored decision, re-enqueue
                                           purchase-order, write nothing
       not REQUIREMENTS_EXTRACTED      -> return { skipped }, no writes
       requirement missing             -> invariant breach, throw (see 8)
  2. Product matching (src/rules/productMatching.ts):
       MATCHED   -> exactly one Product
       NO_MATCH / AMBIGUOUS -> terminal failure (see 7)
  3. Load every SupplierProduct for that Product, scoped through
     supplier.organizationId (SupplierProduct has no organizationId of its own).
  4. Eligibility + scoring + ranking (src/rules/supplierRanking.ts), pure.
  5. No eligible supplier -> terminal failure (see 7).
  6. Gemini writes the rationale. Winner is ALREADY fixed; any failure falls
     back to buildRationale(). Never throws, never retries.
  7. Transaction:
       claim REQUIREMENTS_EXTRACTED -> SUPPLIER_SELECTED (guarded updateMany)
       replace SupplierCandidate rows (all of them, eligible and not)
       upsert SourcingDecision
       audit SUPPLIERS_DISCOVERED + SUPPLIER_SELECTED
  8. After commit: enqueue purchase-order.
```

**AI interprets, deterministic code decides.** Gemini is never asked to rank, filter, or select. It
receives the top 3 candidates *after* ranking, with every monetary value pre-formatted as a
currency string so it never sees raw paise, and returns one field: `rationale`. Nothing downstream
reads that text. A reply is discarded in favour of the deterministic fallback if it fails Zod,
never names the selected supplier, or leaks a camelCase identifier — so a model insisting a
different supplier should have won changes nothing but its own discarded sentence.

## Product matching

`Requirement.productName` is free text the user typed ("100 wireless keyboards"); the catalog holds
canonical names ("Wireless Keyboard"). `findBestProduct()` bridges them without AI:

```text
tokenize   lowercase -> strip punctuation -> drop stopwords -> singularize
           ("wireless keyboards" -> ["wireless", "keyboard"])

score      exact SKU match                    -> 1
           otherwise blended two-way coverage:
             0.7 * (matched query tokens / query tokens)
           + 0.3 * (matched product tokens / product tokens)

threshold  PRODUCT_MATCH_THRESHOLD = 0.6
sort       score desc -> category match desc -> sku asc
```

Two-way coverage penalises both an under-specific match and an over-broad one. Against the seeded
catalog, `"wireless keyboards"` scores **1.00** on *Wireless Keyboard* and **0.50** on *Wireless
Mouse* — which is precisely why the threshold is 0.6 rather than 0.5.

The result is a three-way outcome, never a bare null:

| Outcome | Meaning |
| --- | --- |
| `MATCHED` | One product, confidently and uniquely |
| `NO_MATCH` | Nothing clears the threshold |
| `AMBIGUOUS` | Two or more tie, and category cannot separate them |

`AMBIGUOUS` exists because `"wireless"` alone scores 0.85 against *both* the keyboard and the mouse.
Letting the SKU tie-break decide would be a silent coin-flip on what the organization actually buys,
so the requisition fails with a message naming the candidates instead. `Requirement.category` is a
tie-breaker only, never a filter — Phase 4 does not currently populate it, so filtering on it would
discard the whole catalog.

Exactly one product is ever selected, which is what makes `SupplierCandidate`'s
`@@unique([requisitionId, supplierId])` unviolatable: `SupplierProduct` is unique on
`[supplierId, productId]`, so one product yields at most one offer per supplier.

## Eligibility

`checkEligibility()` returns the **first** failing reason in a fixed order, or `null`. The order is
fixed so the same offer always produces the same message — reasons are stored on
`SupplierCandidate.ineligibleReason` and shown to buyers.

| # | Rule | Example reason |
| --- | --- | --- |
| 1 | `supplier.isActive` | `Supplier is inactive` |
| 2 | Currency equality | `Quotes in USD, requirement is in INR` |
| 3 | `stockQuantity >= quantity` | `Stock 40 is below the required 100` |
| 4 | `unitPricePaise <= maxUnitPricePaise` | `Unit price ₹2,500.00 exceeds the ₹2,000.00 maximum` |
| 5 | `deliveryDays <= deliveryDeadlineDays` | `Delivery in 8 days exceeds the 7-day deadline` |
| 6 | `minOrderQuantity <= quantity` | `Minimum order of 500 exceeds the requested 100` |

Rules 3–5 are the CLAUDE.md set; 1, 2 and 6 close gaps the schema already implied.

There is **no FX conversion anywhere** — a differently denominated quote is simply incomparable, and
approximate arithmetic must never touch money. A null `maxUnitPricePaise` or `deliveryDeadlineDays`
means unconstrained: that check passes for everyone (Phase 4 guarantees both in practice, but the
columns are nullable).

## Scoring

Weights come from `SUPPLIER_SCORE_WEIGHTS` in `src/config/constants.ts`.

```text
priceScore       30%   min-max, cheapest = 100     ┐ normalised across the
deliveryScore    25%   min-max, fastest  = 100     │ ELIGIBLE SET ONLY
stockScore       10%   min-max, most     = 100     ┘
reliabilityScore 20%   supplier.reliabilityScore (0-1) x 100   ┐ absolute
ratingScore      15%   supplier.rating          (0-5) x 20     ┘ scales

totalScore = weighted sum of the ROUNDED components
```

Price, delivery and stock have no natural absolute scale, so they are normalised min–max against
the other candidates in contention. **Only eligible offers feed those bounds** — an ineligible
bargain must not deflate the price scores of the suppliers actually competing. Reliability and
rating do have natural scales and use them, which keeps them comparable across requisitions.

Each component is rounded to 2dp *before* the weighted sum, so a stored row always reconciles: its
five components add up to its stored total. A single eligible candidate scores 100 on the
peer-relative dimensions (`min === max`), not 0.

Ties break deterministically: `totalScore desc -> unitPricePaise asc -> deliveryDays asc ->
supplierId asc`. Ineligible candidates are persisted too — scored zero, ranked after every
eligible one, ordered by `supplierId` — so the audit trail records why each supplier lost. Ranks
run `1..n` across the whole list. The function is order-independent: shuffling the input yields
identical output.

### Worked example — the seeded keyboard scenario

`100 wireless keyboards under ₹2000 each within 7 days`:

| Rank | Supplier | Price | Delivery | Stock | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | TechSource Distributors | ₹1,820 | 5d | 500 | **eligible, total 97.8** |
| 2 | BudgetBulk Traders | ₹1,700 | 4d | 40 | `Stock 40 is below the required 100` |
| 3 | Global Office Supplies | ₹1,950 | 8d | 300 | `Delivery in 8 days exceeds the 7-day deadline` |

TechSource is the only eligible offer, so it takes 100 on all three peer-relative dimensions:
`100(.30) + 100(.25) + 95(.20) + 92(.15) + 100(.10) = 97.8`. Note the cheapest *and* fastest
supplier loses — eligibility is a gate, not a score.

Gemini's rationale for exactly this run:

> TechSource Distributors was selected as it met all project requirements, offering a price of
> ₹1,820.00 per unit with delivery in 5 days. BudgetBulk Traders offered a lower price and faster
> delivery, but was excluded because its stock of 40 units fell short of the required 100. Global
> Office Supplies was also excluded because its 8-day delivery time exceeded the 7-day deadline.

Ineligible candidates are never scored, so their reliability and rating are zero *placeholders*,
not measurements. The prompt omits those two lines for them — sending the zeros would have the
model tell a buyer that a real supplier scores zero on reliability.

## Failure modes

Business failures are terminal states, not errors: they **return normally** so BullMQ does not burn
retries on a decision that cannot change.

| Trigger | Outcome |
| --- | --- |
| No product matched / ambiguous wording | `FAILED` + `NO_SUPPLIER_FOUND` |
| No eligible supplier | `FAILED` + `NO_SUPPLIER_FOUND`, rejected candidates persisted |
| Technical failure (DB/Redis/invariant) | Retried; on the final attempt `FAILED` + `SYSTEM_FAILURE` |
| Gemini failure of any kind | **Not a failure** — deterministic rationale, sourcing completes |

Every failure path writes `failureReason` on the requisition, an `Exception` row, and
`EXCEPTION_CREATED` + `WORKFLOW_FAILED` audits, and never enqueues purchase-order. A requisition
that cannot be read at all is rethrown as-is — there is nothing to attach a failure to.

## Idempotency & concurrency

Assume every job runs more than once.

- **Already sourced.** `SUPPLIER_SELECTED`/`PO_CREATED` returns the stored decision and writes
  nothing — re-running could otherwise pick a different supplier than the PO already names.
- **Lost enqueue self-heals.** The purchase-order job is added *after* the transaction commits, so a
  Redis failure in that window would leave a committed decision with no job behind it. The
  already-sourced branch re-enqueues, so the retry closes that gap instead of stranding the
  requisition in `SUPPLIER_SELECTED` forever. Phase 4's guard does the same one stage earlier.
- **Concurrent runs.** Two jobs can both pass the status check before either commits, so the
  transition is *claimed* with a guarded write:
  `updateMany({ where: { id, organizationId, status: REQUIREMENTS_EXTRACTED } })`. A zero-row result raises
  `CONFLICT`, rolling the loser's transaction back before it writes anything. The loser then returns
  `skipped` — losing a race is not a system failure.
- **Partial runs.** Candidates are replaced wholesale (`deleteMany` then `createMany`) and the
  decision is upserted, so a half-finished previous run leaves no duplicates.
- **Exceptions.** `recordException()` upserts on `@@unique([organizationId, type, entityId])` and
  deliberately leaves `status` untouched on update — a re-drive must never reopen an exception a
  human already resolved.

## Schema

**No migration.** Every model this phase writes already existed: `SupplierCandidate`,
`SourcingDecision`, `Exception`, `AuditLog`, `AIProcessingLog`, and the `SUPPLIERS_DISCOVERED` /
`SUPPLIER_SELECTED` / `EXCEPTION_CREATED` / `WORKFLOW_FAILED` audit actions.

## Key files

```text
src/rules/productMatching.ts            tokenize / score / findBestProduct (pure)
src/rules/supplierRanking.ts            checkEligibility / rankSuppliers / buildRationale (pure)
src/services/sourcing.service.ts        loads, transactions, generateRationale
src/services/exception.service.ts       recordException (idempotent upsert, joins a transaction)
src/ai/prompts/sourcing.v1.ts           versioned narration prompt
src/zod/sourcing.schema.ts              sourcingRationaleSchema
src/workers/supplierDiscovery.worker.ts processSupplierDiscoveryJob
src/config/constants.ts                 SUPPLIER_SCORE_WEIGHTS
src/queues/supplier.queue.ts            enqueueSupplierDiscovery (pre-existing)
src/services/requisition.service.ts     getRequisition — exposes the outcome to clients
```

`src/rules/*` import no Prisma and perform no I/O — the financial decision-maker is exhaustively
unit-testable in isolation.

## Testing

`pnpm test` — 82 tests across five files under `tests/`, no database, Gemini always mocked.

```text
supplierRanking.test.ts           (23)  scoring arithmetic, all 6 eligibility rules, tie-breaks,
                                        determinism, and that ineligible offers cannot skew
                                        min-max normalisation
supplierDiscovery.worker.test.ts  (21)  orchestration against a fake Prisma client, so transaction
                                        contents are asserted; concurrency, self-heal, state guards
productMatching.test.ts           (18)  the real seeded catalog: plurals, SKUs, stopwords,
                                        NO_MATCH and AMBIGUOUS
sourcingRationale.test.ts         (11)  fallback on every Gemini failure mode; the sanity gate
                                        accepts plain English and rejects leaked identifiers
requisitionDetail.test.ts          (9)  the client-facing read shape: winner-name resolution,
                                        the null-sourcing case, tenant scoping
```

## Read surface

The phase adds no routes. `GET /api/v1/requisitions/:id` now returns two extra fields — `sourcing`
(the committed decision, with the winner's name resolved server-side) and `supplierCandidates` (the
full ranked list, losers included, with their `ineligibleReason`). A separate `requisitionDetailSelect`
carries those joins so the extraction worker's own load stays lean. Client contract:
[`api-docs/sourcing-api.md`](../api-docs/sourcing-api.md).

## Notes

- Ranking never involves Gemini (CLAUDE.md §3). The one AI call is cosmetic and fully non-fatal.
- `AIProcessingLog` records the rationale call as `generate-sourcing-rationale` / `sourcing.v1`,
  including failures — an outage is visible without ever failing a job.
- `purchase-order` jobs queue and are consumed by `src/workers/purchaseOrder.worker.ts`
  ([Phase 6](./purchase-orders.md)) — sourcing does not wait on it, just enqueues.
- Socket.IO events and the `/api/v1/suppliers` read routes are out of scope here.
