# Exceptions API Reference (Frontend)

How a client sees why an invoice is stuck, and how a human clears it. See
`architecture/matching-and-payment.md` for the backend design, and `api-docs/invoices-api.md` for the
stage that precedes this.

Conventions (headers, envelope, error codes) are identical to the requisitions API — see
`api-docs/requisitions-api.md`. Every request carries `x-organization-id`.

## The stage in one picture

```text
Invoice EXTRACTED
        │
        ▼  automatic — matching worker (deterministic, no AI)
Invoice APPROVED  ──▶  automatic — payment worker  ──▶  Invoice PAID           (clean match)
        │
        └─▶  Invoice EXCEPTION, Payment BLOCKED, one or more Exceptions OPEN   (mismatch)
                        │
                        ▼
             GET /exceptions?entityId={invoiceId}      list what's blocking it
             GET /exceptions/:id                        read one in full
                        │
                        ▼
             POST /exceptions/:id/resolve
             { decision: "APPROVE" | "PARTIAL_APPROVE" | "REJECT", reason, approvedAmountPaise? }
                        │
                        ├─ REJECT, or other exceptions on the invoice still open
                        │        → exception closed, invoice stays EXCEPTION
                        │
                        └─ APPROVE / PARTIAL_APPROVE and this was the last open exception
                                 → Invoice EXCEPTION → APPROVED → PAID (or PARTIALLY_PAID)
                                 → automatic — payment worker → Invoice PAID
```

There is currently **no dedicated endpoint for reading `ThreeWayMatch`/`MatchCheck` or `Payment` rows**
— see [Not yet available](#not-yet-available). The exception's own `description` and `metadata.checks`
are the only place the specific check failures (expected vs. actual values) are exposed today. Drive
the "why is this invoice stuck" screen from the exceptions list, and drive "is this invoice paid yet"
from `GET /invoices/:id`'s `status` field.

## `Invoice.status` values this stage introduces

Building on the table in `api-docs/invoices-api.md`:

| `status` | Meaning | What the client shows |
| --- | --- | --- |
| `MATCHING` | Three-way matching is running | spinner — transient, usually resolves in well under a second since there's no AI call in this stage |
| `APPROVED` | Match passed (or a human overrode a mismatch) | payment is queued automatically; poll a little longer for `PAID` |
| `EXCEPTION` | Match failed, one or more exceptions are open | fetch `GET /exceptions?entityId={invoiceId}` and render them; payment is blocked |
| `PAID` | Settled | terminal, success state |

`FAILED` (extraction failure) is unrelated to this stage — see `api-docs/invoices-api.md`.

## GET /api/v1/exceptions

Cursor-paginated list, newest first. This is the primary read for "what needs my attention" — an
exceptions inbox screen should poll this with no filters, or `status=OPEN` to hide already-decided
ones.

| Query param | Default | Notes |
| --- | --- | --- |
| `status` | — | `OPEN` \| `UNDER_REVIEW` \| `RESOLVED` \| `REJECTED` |
| `type` | — | See [Exception types](#exception-types) below |
| `entityId` | — | Scope to one entity — e.g. all exceptions blocking one invoice |
| `limit` | `20` | Max `100` |
| `cursor` | — | The `nextCursor` from the previous page |

Pages are ordered newest-first by `createdAt`, with `id` as a tiebreaker (several exceptions from the
same matching run share a `createdAt` down to the millisecond) — so a page boundary landing inside a
tie can never skip or repeat a row.

```json
{
  "success": true,
  "data": {
    "exceptions": [
      {
        "id": "exc_abc123",
        "organizationId": "org_dev",
        "type": "QUANTITY_MISMATCH",
        "status": "OPEN",
        "severity": "CRITICAL",
        "entityType": "Invoice",
        "entityId": "inv_abc123",
        "title": "Three-way match failed: quantity mismatch",
        "description": "INVOICED_QUANTITY: expected Wireless Keyboard: 96, got Wireless Keyboard: 100",
        "metadata": {
          "checks": [
            {
              "checkType": "INVOICED_QUANTITY",
              "expected": "Wireless Keyboard: 96",
              "actual": "Wireless Keyboard: 100",
              "variance": 4
            }
          ]
        },
        "resolution": null,
        "resolutionReason": null,
        "resolvedAt": null,
        "resolvedBy": null,
        "createdAt": "2026-08-26T11:05:00.000Z",
        "updatedAt": "2026-08-26T11:05:00.000Z"
      }
    ],
    "nextCursor": null
  },
  "error": null
}
```

`nextCursor` is `null` on the last page.

## GET /api/v1/exceptions/:id

The same shape as one entry above, plus two fields the list does not carry — `failedChecks` and
`settlement`. Together they are everything an operator needs to decide an invoice exception: *which
of the twelve checks failed*, and *what settling it would cost*.

```json
{
  "success": true,
  "data": {
    "exception": {
      "id": "exc_abc123",
      "...": "",
      "failedChecks": [
        {
          "checkType": "RECEIVED_QUANTITY",
          "expected": "100",
          "actual": "96",
          "variance": -0.04,
          "severity": "CRITICAL"
        },
        {
          "checkType": "SUBTOTAL",
          "expected": "18200000",
          "actual": "17472000",
          "variance": -0.04,
          "severity": "HIGH"
        }
      ],
      "settlement": {
        "purchaseOrderId": "po_1",
        "poNumber": "PO-20260824-ABC123",
        "currency": "INR",
        "invoiceTotalPaise": 21476000,
        "invoiceSettledPaise": 0,
        "invoiceOutstandingPaise": 21476000,
        "purchaseOrderTotalPaise": 21476000,
        "purchaseOrderSettledPaise": 0,
        "purchaseOrderOutstandingPaise": 21476000,
        "fullySettled": false,
        "suggestedAmountPaise": 20616960
      }
    }
  },
  "error": null
}
```

`suggestedAmountPaise` is the "pay for what actually arrived" figure: accepted units at the
**purchase order's** agreed unit price, plus tax at the order's rate. Priced off the PO rather than
the invoice deliberately — the invoice is the document under suspicion, so if the supplier also
inflated the unit price, the suggestion must not inherit that. It is capped at whatever the invoice
and the order still have outstanding, and it is `null` when nothing has been received yet.

It is advisory. Whatever amount is approved is re-checked against both balances before anything is
charged. It is `null` — offer no one-click amount — whenever the worker would refuse it anyway:
nothing received yet, no extracted invoice total, the invoice already fully settled, or the purchase
order already spent.

`failedChecks` is `[]` and `settlement` is `null` for an exception that is not about an invoice
(e.g. `NO_SUPPLIER_FOUND` on a requisition).

An exception belonging to another organization is a `404`.

## POST /api/v1/exceptions/:id/resolve

The only mutation in this API. Records a human's decision.

```json
{
  "decision": "PARTIAL_APPROVE",
  "approvedAmountPaise": 20616960,
  "reason": "Supplier confirmed the remaining 4 units ship next week; paying for what arrived."
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `decision` | `"APPROVE"` \| `"PARTIAL_APPROVE"` \| `"REJECT"` | Required |
| `approvedAmountPaise` | integer > 0 | **Required** with `PARTIAL_APPROVE`, and **rejected** with anything else. Silently ignoring a number someone typed into a payment request is how the wrong sum gets paid |
| `reason` | string | Required, 10–1000 characters. This is a financial judgement — the backend refuses a resolution with no real explanation (CLAUDE.md: "Every resolution needs a reason and AuditLog") |

### The three decisions

- **`APPROVE`** — the discrepancy is acceptable and the invoice should be paid as billed. Settles
  whatever the invoice still owes.
- **`PARTIAL_APPROVE`** — the short-delivery answer. The paperwork genuinely disagrees; rather than
  paying the whole invoice or nothing at all, authorize a specific amount, typically
  `settlement.suggestedAmountPaise` from `GET /exceptions/:id`. The invoice becomes `PARTIALLY_PAID`
  and the purchase order keeps its remaining balance, so a follow-up invoice for the backordered
  units can still be matched and settled. The tranche is recorded against this exception, with the
  approver and the reason attached — see [`payments-api.md`](./payments-api.md).

  The full-value payment row that matching parked stays `BLOCKED`, which is what it is: the
  settlement for the whole amount was refused, and a smaller one authorized instead. Only `APPROVE`
  releases it.
- **`REJECT`** — closes the exception without releasing anything.

The approved amount is a *request*, not an authorization. The payment worker re-derives the
invoice's outstanding balance and the purchase order's remaining commitment before any money moves,
and refuses an amount that no longer fits. A mistyped figure is refused rather than paid; the
refusal shows up as `skippedReason` on the job and leaves the payment unsettled.

The response carries `approvedAmountPaise` back (`null` on a full approval) alongside
`releasedForPayment`.

```js
await fetch(`/api/v1/exceptions/${exceptionId}/resolve`, {
  method: "POST",
  headers: { "x-organization-id": orgId, "Content-Type": "application/json" },
  body: JSON.stringify({ decision: "APPROVE", reason }),
});
```

Response — `200`:

```json
{
  "success": true,
  "data": {
    "exception": {
      "id": "exc_abc123",
      "status": "RESOLVED",
      "resolution": "APPROVE",
      "resolutionReason": "Supplier confirmed the remaining 4 units ship next week; approving payment for what arrived.",
      "resolvedAt": "2026-08-26T12:00:00.000Z",
      "resolvedBy": "user_dev",
      "...": ""
    },
    "releasedForPayment": true
  },
  "error": null
}
```

### Reading `releasedForPayment`

This is the field to branch on for UI feedback, and it means something specific:

- **`true`** only when `decision` was `APPROVE` or `PARTIAL_APPROVE` **and** this was the *last* exception still open against
  the invoice. The invoice has just moved `EXCEPTION → APPROVED` and payment has been queued
  automatically — show "approved, payment processing" and start (or keep) polling
  `GET /invoices/:id` for `PAID`. After a `PARTIAL_APPROVE` the terminal state is `PARTIALLY_PAID`,
  not `PAID`.
- **`false`** in every other case: a `REJECT`, or an approval on an invoice that still has other
  exceptions open. **An invoice can have more than one exception** (e.g. both a quantity and a price
  mismatch) — approving one does not release the invoice, and the correct UI is to keep the invoice's
  remaining open exceptions visible rather than treating this response as final. Refetch
  `GET /exceptions?entityId={invoiceId}&status=OPEN` after every resolution to know what's left.

`decision: "REJECT"` always closes the exception (`status: "REJECTED"`) without releasing anything —
the invoice stays `EXCEPTION` and payment stays blocked. There is no separate endpoint to re-open a
rejected exception or retry matching; a rejected mismatch is a terminal human call for that invoice in
this MVP.

### Resolving an already-decided exception

An exception's `status` is terminal once it leaves `OPEN`/`UNDER_REVIEW` — resolving it again, with
the same decision or a different one, is a `409 INVALID_STATE`; the endpoint does not replay the
stored resolution as a `200`. Disable the resolve UI once `status` is `RESOLVED` or `REJECTED`, and
treat a `409` here as "someone else already decided this, refetch it" rather than an error to retry.

This is what makes resolution safe under a double-click or a retried request: the backend's guard is
a single conditional update on `status IN (OPEN, UNDER_REVIEW)`, so a duplicate call can never open a
second `PAYMENT_APPROVED`/`EXCEPTION_RESOLVED` audit row, re-enqueue payment, or move the invoice
twice — it just gets the 409 instead.

### An exception can come back

"Terminal" applies to *deciding* it, not to the row for all time. There is at most one exception per
`(organizationId, type, entityId)`, so if the same failure genuinely happens again after a human
resolved it — the invoice is re-matched and mismatches the same way — that row is **reopened**: back
to `OPEN`, with `resolution`, `resolutionReason`, `resolvedAt` and `resolvedBy` cleared, and a fresh
audit row recording the reopen and the status it came from.

Without this the entity would be stranded: it sits in `EXCEPTION`, the payment gate refuses it for
having an exception, and resolve refuses to re-decide a closed row. A re-drive that changes nothing
does *not* reopen anything — a row still `OPEN` or `UNDER_REVIEW` is left exactly as it is, so a
decision in progress is never disturbed. For the UI this means: don't cache an exception as
permanently decided; `RESOLVED` can legitimately become `OPEN` again on a later poll.

## Exception types

The `type` field on every exception. Not all of these originate from this stage — some are opened
earlier in the pipeline and are only reachable through this API now that it exists.

| `type` | Raised by | `entityType` / `entityId` |
| --- | --- | --- |
| `NO_SUPPLIER_FOUND` | Supplier discovery, when no supplier is eligible | `Requisition` |
| `INVOICE_EXTRACTION_FAILED` | Invoice worker, after 3 failed Gemini Vision attempts | `Invoice` |
| `QUANTITY_MISMATCH` | Matching — `ORDERED_QUANTITY`, `RECEIVED_QUANTITY`, or `INVOICED_QUANTITY` check failed | `Invoice` |
| `PRICE_MISMATCH` | Matching — `UNIT_PRICE` or `SUBTOTAL` check failed | `Invoice` |
| `SUPPLIER_MISMATCH` | Matching — invoice's stated supplier doesn't match the PO's | `Invoice` |
| `DUPLICATE_INVOICE` | Matching — invoice number already recorded for this org. Also raised by the **payment gate** when a *different* invoice against the same purchase order has already been paid: that second document passes every three-way check (its number is genuinely new) but is refused settlement, so the order can never be paid twice. | `Invoice` |
| `TAX_MISMATCH` | Matching — `TAX` check failed | `Invoice` |
| `TOTAL_MISMATCH` | Matching — `TOTAL` or `CURRENCY` check failed | `Invoice` |
| `PAYMENT_FAILURE` | Payment worker, after 3 failed provider attempts | `Invoice` |
| `SYSTEM_FAILURE` | Either worker, after 3 failed *technical* (non-business) attempts, or an unmapped check | `Invoice` (or `Requisition`) |
| `PO_APPROVAL_REQUIRED` | PO worker, when a generated PO's total is at or above the auto-approve threshold. **Not resolvable here** — decide it on the purchase order with `POST /purchase-orders/:id/approve` or `/reject`, which closes this exception itself. Posting it to `/exceptions/:id/resolve` returns `409 INVALID_STATE`, because resolving it here would close the exception while leaving the order stuck in `PENDING_APPROVAL` with nothing open against it. | `PurchaseOrder` |
| `REQUIREMENT_INCOMPLETE` | **Reserved — deliberately not raised.** A requisition missing required fields does not open an exception; it stays in a conversational `NEEDS_CLARIFICATION` loop instead (`clarificationMessage` + `missingFields` on the requisition, driven by `POST /api/v1/requisitions/:id/messages` — see `api-docs/requisitions-api.md`). That loop is the better UX for something an ordinary back-and-forth with the requester can resolve; an exceptions-inbox entry is for something only an approver, not the requester, can decide. | — |

An invoice can accumulate several exceptions at once (one per distinct failing check group — see
`architecture/matching-and-payment.md`), so always filter/group by `entityId` rather than assuming one
exception per invoice.

`metadata.checks` (present on matching-originated exceptions) carries the raw `MatchCheckResult` rows
that were grouped into this exception — `checkType`, `expected`, `actual`, `variance` — useful for a
detail view that wants to show the specific numbers rather than just the prose `description`.

## Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `decision` missing/invalid, or `reason` under 10 or over 1000 characters |
| 404 | `NOT_FOUND` | Unknown exception, or one owned by another organization |
| 409 | `INVALID_STATE` | Exception is already `RESOLVED` or `REJECTED`, or its type is `PO_APPROVAL_REQUIRED` (decide that on the purchase order — see the type table above). `details` carries `{ exceptionId, status }` or `{ exceptionId, type, entityId }` respectively. |

## Not yet available

- No `GET /payments` or `GET /payments/:id` — a payment's progress is only visible indirectly through
  `Invoice.status` (`APPROVED` → processing, `PAID` → settled). There is no way today to fetch
  `providerReference`, `blockedReason`, or `failureReason` directly.
- No `GET` endpoint for `ThreeWayMatch`/`MatchCheck` — the full 12-check breakdown of a *passing*
  match is not exposed anywhere; only failed checks surface, via the exception's `metadata.checks`.
- No Socket.IO events (`exception.created`, `exception.resolved`, `payment.completed`, etc.) — poll
  `GET /invoices/:id` for status and `GET /exceptions?entityId=...&status=OPEN` for what's blocking it.
- No bulk-resolve. Each exception is resolved individually, even when several were opened by the same
  mismatch.

`EXCEPTION_CREATED`/`EXCEPTION_RESOLVED`/`PAYMENT_APPROVED`/`PAYMENT_COMPLETED` audit rows *are*
queryable — see [`audit-logs-api.md`](./audit-logs-api.md). Note that exception audits are filed under
`entityType: "Exception"`, not the invoice/requisition they concern — see that doc's "entity-targeting
quirks" section before filtering by `entityId`.
