# Analytics API

Read-only aggregation over what the workflow has already recorded. Nothing here writes, enqueues, or
decides — these endpoints answer questions about the data PostgreSQL already holds. Every response
is scoped to the caller's organization.

Base path: `/api/v1/analytics`.

## Conventions

**Window.** `summary` and `anomalies` accept optional `from` and `to` query params (anything
`new Date()` parses; `2026-08-01` and full ISO timestamps both work). Both bounds are inclusive. An
absent bound means "since the beginning" / "up to now" — there is deliberately no default window, so
a dashboard cannot silently report the last 30 days as if it were all time. `from` after `to` is a
`400 VALIDATION_ERROR`.

**Money** is always an object:

```json
{ "paise": 21476000, "display": "₹2,14,760.00" }
```

`paise` is the integer value to compute with. `display` is formatted with `en-IN` grouping (lakhs)
and is for rendering only — never parse it back into a number.

**Rates** are `0`–`1`, never percentages, and are `null` rather than `0` when the denominator is
empty. "Nothing has happened yet" and "nothing worked" are opposite facts and must not render the
same way.

**Durations** are in hours, reported as `{ count, meanHours, medianHours, p90Hours }`. Median and
p90 are there because procurement durations are skewed — one requisition left over a weekend drags
a mean into something no buyer recognises as their own process.

---

## `GET /analytics/summary`

The dashboard payload. One call, six sections.

```http
GET /api/v1/analytics/summary?from=2026-08-01&to=2026-08-31
```

### `funnel`

Counts by status for `requisitions`, `purchaseOrders`, `invoices`, and `payments`. Every status in
the enum is present with a `0`, so a chart keeps a stable axis on an empty organization.
`GENERATED` invoices (the convenience PDFs this system produces from a PO) are excluded — counting
them as invoices received would double the funnel.

### `automation`

| Field | Meaning |
| --- | --- |
| `touchlessInvoiceRate` | Invoices that reached `PAID` with **no exception ever raised** against them, over invoices that reached a terminal state (`PAID`, `EXCEPTION`, `FAILED`). |
| `touchlessInvoices`, `terminalInvoices` | The numerator and denominator, so the rate can be recomputed. |
| `firstPassMatchRate` | `ThreeWayMatch` rows that came back `MATCHED`, over all matches run. |
| `invoicesRequiringReview` | Paid invoices that needed a human to clear an exception first. |

Two things this figure deliberately does **not** do. It does not count only *currently open*
exceptions — an exception that was raised and then resolved still disqualifies the invoice, because
a human touched it. And it is **invoice-side only**: purchase-order approval is a human step in this
build (`PO_AUTO_APPROVE_ENABLED` is `false` in `src/config/constants.ts`), so an end-to-end
"touchless" number would be `0` by construction and would say nothing about how well the automation
works. Label it as invoice-side in any UI.

### `cycleTimes`

`requisitionToPurchaseOrder`, `purchaseOrderToApproval`, `approvalToDelivery`, `invoiceToPayment`,
`endToEnd`. Measured from entity timestamps, not the audit log. A flow that has not finished
contributes nothing rather than counting as instant, so `count` may differ between stages.

### `exceptions`

`byType` (one row per `ExceptionType`, with `open` / `resolved` / `rejected` / `total`, sorted by
total), `openTotal`, and `meanResolutionHours`. `OPEN` and `UNDER_REVIEW` are both counted as
`open` — the split between them is workflow detail a summary does not need.

### `spend`

`committed` (every non-`REJECTED` purchase order), `paid` (completed payments), `blocked` (payments
held by an exception), and `topSuppliers` (top 10 by committed value, with order counts).

### `ai`

Per `jobType`: `runs`, `successRate`, `p50LatencyMs`, `p95LatencyMs`, from `AIProcessingLog`. This
is the only reader of that table — the latency percentiles are what tell you whether the Gemini
calls are why the workflow feels slow.

---

## `GET /analytics/suppliers`

The vendor scorecard. `?limit=` (default 50, max 100), ordered by `reliabilityScore` descending.

```json
{
  "suppliers": [
    {
      "supplierId": "sup-techsource",
      "supplierName": "TechSource Distributors",
      "isActive": true,
      "rating": 4.5,
      "onTimeRate": 0.75,
      "inFullRate": 0.5,
      "otifRate": 0.375,
      "damageRate": 0.025,
      "avgLeadTimeDays": 6.5,
      "totalDeliveries": 4,
      "reliabilityScore": 0.75,
      "baselineReliability": 0.9,
      "reliabilityDelta": -0.15,
      "purchaseOrders": 4,
      "spend": { "paise": 21476000, "display": "₹2,14,760.00" },
      "lastDeliveryAt": "2026-08-26T00:00:00.000Z"
    }
  ]
}
```

`reliabilityScore` is not decoration: it carries the `RELIABILITY` weight (20%) in
`SUPPLIER_SCORE_WEIGHTS`, so this table shows exactly why the next requisition will pick who it
picks. It is recomputed from OTIF every time a goods receipt is booked
(`src/rules/supplierPerformance.ts`), shrunk toward `baselineReliability` — the score the supplier
was onboarded with — so one bad delivery moves it without destroying the supplier.
`reliabilityDelta` is the movement since onboarding.

A supplier that has never delivered reports `null` for every rate, not `0`.

`otifRate` is `onTimeRate × inFullRate`, an approximation: the stored counters do not record which
deliveries were both.

---

## `GET /analytics/anomalies`

Cursor-paginated feed of advisory signals. Same pagination shape as `/audit-logs`.

Query params: `from`, `to`, `severity` (`INFO` | `WARNING` | `CRITICAL`), `signalType`,
`entityType`, `entityId`, `limit` (default 20, max 100), `cursor`.

```json
{
  "signals": [
    {
      "id": "sig_...",
      "signalType": "PRICE_OUTLIER",
      "severity": "WARNING",
      "entityType": "PurchaseOrder",
      "entityId": "po_...",
      "score": 3.2,
      "observed": "Wireless Keyboard: ₹3,000.00",
      "baseline": "₹1,820.00 average over 4 prior order line(s)",
      "explanation": "TechSource Distributors is charging ₹3,000.00 per unit for Wireless Keyboard, well above the ₹1,820.00 they have historically charged.",
      "metadata": { "productId": "prod-kb", "unitPricePaise": 300000 },
      "createdAt": "2026-08-28T04:02:09.000Z"
    }
  ],
  "nextCursor": null
}
```

### These are advisory, and that is load-bearing

A signal **never** blocks a payment, raises an `Exception`, or changes a three-way-match verdict.
`src/rules/threeWayMatch.ts` remains the only financial gate and `src/rules/paymentRules.ts` the
only payment one. They are stored in their own table for exactly this reason: `evaluatePayment`
refuses to pay while an exception is open, so filing a heuristic as an `Exception` would silently
block money.

Signals are deterministic statistics — mean and standard deviation over the organization's own
history (`src/rules/anomalyDetection.ts`) — not a model. Every one is explainable in the sentence
that ships with it.

| `signalType` | Raised when | Where |
| --- | --- | --- |
| `PRICE_OUTLIER` | A unit price sits more than 2σ from what this supplier has historically charged for the product. This is the gap matching leaves by design: `UNIT_PRICE` compares an invoice to *its own* PO, and a PO built from an inflated catalog price matches itself perfectly. | PO creation |
| `QUANTITY_OUTLIER` | An order quantity far outside the organization's own history for that product. | PO creation |
| `NEW_SUPPLIER_HIGH_VALUE` | A first-ever order with a supplier, above ₹5,00,000. | PO creation |
| `PREDICTED_LATE_DELIVERY` | The supplier's measured mean lead time exceeds the delivery days they quoted by more than 20%. Raised *before* the delay happens — this is the predictive one. | PO creation |
| `SUPPLIER_DEGRADATION` | Reliability has fallen 0.15 or more below the onboarding baseline. Filed against the `Supplier`, not the order — the order is fine, the relationship changed. | PO creation |
| `NEAR_DUPLICATE_INVOICE` | The same supplier billed the same total within 30 days under a *different* invoice number — the case the exact-number `DUPLICATE_INVOICE` check cannot see. | After matching |

No outlier signal fires with fewer than 3 prior observations; with two samples every third one looks
like an anomaly. When every prior value is identical (σ = 0, which is what a catalog price looks like
until it changes) the z-score is replaced by a 15% relative-deviation test, so a supplier's first
price change is not reported as infinitely severe.

Thresholds live in `ANOMALY_THRESHOLDS` in `src/config/constants.ts`.

Signals are upserted on `[organizationId, signalType, entityType, entityId]`, so a re-delivered
BullMQ job refreshes a row rather than filling the feed with duplicates.
