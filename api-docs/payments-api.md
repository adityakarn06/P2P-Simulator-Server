# Payments API

Read-only. Two endpoints, both scoped to the caller's organization.

```text
GET /api/v1/payments
GET /api/v1/payments/:id
```

There is deliberately no `POST`, `PATCH` or `DELETE`. A payment is created by the payment worker
after the three-way match, or authorized by resolving an exception — an HTTP endpoint that could
mark an invoice paid would bypass matching and the settlement caps entirely.

## The settlement model

An invoice is **not** paid all-or-nothing, and a purchase order is **not** limited to one invoice.

- A `Payment` row is one **tranche**: `(invoiceId, settlementKey)` is unique.
  `settlementKey` is `"auto"` for the automatic settlement that follows a clean match, and
  `"exc-<exceptionId>"` for an amount a human approved while resolving an exception.
- `kind` is `FULL` when the tranche clears the invoice outright, `PARTIAL` when it does not.
- Two caps are enforced before any money moves:
  1. a **human-approved** amount never exceeds what the invoice still owes, and
  2. the tranches against a purchase order never exceed the order total — no matter how many
     invoices are raised against it.
- The **automatic** settlement pays the purchase order's remaining balance, not the invoice's. The
  order total is the buyer's own deterministically calculated figure; the invoice total was
  transcribed off a document by OCR and never decides how much money moves. Three-way matching has
  already proved the two agree within tolerance.

Cap (2) is what stops a supplier splitting one order across two invoices and being paid twice. It
also means the **remainder of a short-paid order stays available**: pay for the 96 units that
arrived now, and a follow-up invoice for the 4 backordered units can still be matched and settled.

Invoice statuses follow the ledger: `PARTIALLY_PAID` while tranches remain outstanding, `PAID` once
they add up to the invoice total **or** the purchase order is settled in full. The second case
matters because matching tolerates 1% on the total: an invoice that billed marginally above the
order is settled for the order's figure and is then finished, not left permanently short over a
rounding difference.

## `GET /api/v1/payments`

Query parameters, all optional:

| Param | Type | Notes |
| --- | --- | --- |
| `status` | `PENDING` \| `PROCESSING` \| `COMPLETED` \| `FAILED` \| `BLOCKED` | |
| `kind` | `FULL` \| `PARTIAL` | `kind=PARTIAL` is the settlement-review view |
| `invoiceId` | string | every tranche of one invoice |
| `purchaseOrderId` | string | every tranche against one order |
| `supplierId` | string | matched through the invoice |
| `from`, `to` | ISO date | filters on `createdAt` |
| `limit` | 1–100, default 20 | |
| `cursor` | string | the previous page's `nextCursor` |

```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "id": "pay_1",
        "invoiceId": "inv_1",
        "settlementKey": "exc-exc_1",
        "purchaseOrderId": "po_1",
        "amountPaise": 20616960,
        "currency": "INR",
        "status": "COMPLETED",
        "kind": "PARTIAL",
        "provider": "SIMULATED",
        "providerReference": "SIM-9f2c1a0b4e6d8135",
        "blockedReason": null,
        "failureReason": null,
        "authorizedBy": "dev-user",
        "authorizationReason": "Supplier confirmed the 4-unit shortfall; pay for what arrived.",
        "authorizingExceptionId": "exc_1",
        "invoiceSettledPaise": 20616960,
        "shortfallPaise": 859040,
        "processedAt": "2026-08-28T10:00:00.000Z",
        "completedAt": "2026-08-28T10:00:01.000Z",
        "createdAt": "2026-08-28T10:00:00.000Z",
        "updatedAt": "2026-08-28T10:00:01.000Z",
        "invoice": {
          "invoiceNumber": "INV-2026-0042",
          "status": "PARTIALLY_PAID",
          "totalPaise": 21476000,
          "supplier": { "id": "sup_1", "name": "TechSource Distributors" }
        },
        "purchaseOrder": {
          "poNumber": "PO-20260824-ABC123",
          "totalPaise": 21476000,
          "currency": "INR"
        }
      }
    ],
    "nextCursor": null
  },
  "error": null
}
```

`invoiceSettledPaise` is everything `COMPLETED` against this payment's **invoice**, across all its
tranches. `shortfallPaise` is `invoice.totalPaise - invoiceSettledPaise`, floored at zero — what the
supplier billed minus what the invoice has actually been paid in total.

Both are properties of the invoice, not of the row, so **every tranche of one invoice reports the
same figures**. An invoice paid 40% and then 30% shows a 30% shortfall on both rows, not 60% and
70%; one eventually topped up to its full amount shows `0` on both. `shortfallPaise` is `0` (not a
guess) when the invoice total was never extracted.

**Building a partial-payments page:** `GET /api/v1/payments?kind=PARTIAL&status=COMPLETED` returns
exactly the rows an SCM manager needs, each already carrying the supplier, the PO number, the
shortfall, the written reason and the approver.

## `GET /api/v1/payments/:id`

Adds the order-level ledger and the other tranches settling the same purchase order — a partial
payment only means something next to what else has been paid against the same commitment.

```json
{
  "success": true,
  "data": {
    "payment": { "...": "as above" },
    "ledger": {
      "poNumber": "PO-20260824-ABC123",
      "invoiceTotalPaise": 21476000,
      "invoiceSettledPaise": 20616960,
      "invoiceOutstandingPaise": 859040,
      "purchaseOrderTotalPaise": 21476000,
      "purchaseOrderSettledPaise": 20616960,
      "purchaseOrderOutstandingPaise": 859040,
      "fullySettled": false
    },
    "siblings": [
      {
        "id": "pay_2",
        "invoiceId": "inv_2",
        "settlementKey": "auto",
        "amountPaise": 859040,
        "status": "PENDING",
        "kind": "FULL"
      }
    ]
  },
  "error": null
}
```

404 when the payment belongs to another organization.

## Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | unknown `status`/`kind`, `limit` over 100, unparseable date |
| 404 | `NOT_FOUND` | no such payment in this organization |
