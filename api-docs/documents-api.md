# Documents API Reference (Frontend)

PDFKit-rendered documents: a downloadable purchase order, a downloadable goods receipt, and a
generated supplier invoice a demo operator can download and then re-upload through
`POST /invoices` (see `api-docs/invoices-api.md`) to drive the OCR → three-way-matching → payment
pipeline without needing a real invoice PDF from somewhere else.

Conventions (headers, envelope, error codes) are identical to the requisitions API for the JSON
endpoint — see `api-docs/requisitions-api.md`. Every request carries `x-organization-id`. The three
download endpoints below return a binary PDF body, not the `{ success, data, error }` envelope.

## The stage in one picture

```text
PO APPROVED                        ──▶ GET /purchase-orders/:id/pdf   (download any time)
        │
        ▼
POST /receipts/simulate            ──▶ GET /receipts/:id/pdf          (download any time)
        │
        ▼
POST /purchase-orders/:id/generate-invoice  ──▶ invoice, source: GENERATED, status: EXTRACTED
        │
        ▼
GET /invoices/:id/pdf              ──▶ download the rendered PDF
        │
        ▼
POST /invoices  (that same file, or any other)  ──▶ the real, matched pipeline — see invoices-api.md
```

## POST /api/v1/purchase-orders/:id/generate-invoice

Renders a supplier invoice from the purchase order's own data (its supplier, currency, tax rate,
and line items) and stores it as an `Invoice` row with `source: "GENERATED"`. This is a convenience
document for the demo operator — it is **never** the document three-way matching acts on. See
`api-docs/invoices-api.md`'s "`Invoice.source`: GENERATED vs UPLOADED" section for the full
distinction.

Body — everything optional; with no body the invoice bills exactly what the PO ordered:

```json
{ "items": [ { "purchaseOrderItemId": "poi_1", "quantity": 98 } ] }
```

Any line item omitted from `items[]` bills its full ordered quantity. Use the override to bill less
than what shipped — e.g. matching a partial goods receipt so the re-uploaded invoice `MATCHES`, or
deliberately over-billing to demo a `QUANTITY_MISMATCH` exception on stage.

An override `quantity` must be **1 or more**. Zero is rejected rather than rendering a ₹0 line: a
zero-total line compares equal against anything in three-way matching's `UNIT_PRICE` check, so it
would pass on no money at all. To leave a line off the invoice entirely, that is not yet supported —
every purchase-order line is billed.

The purchase order must be `APPROVED`, `SHIPPED`, `RECEIVED` or `COMPLETED` — the same rule as
`POST /invoices`.

Response — `201` on the first call for this purchase order, `200` on a repeat call (idempotent: it
returns the invoice already on file rather than rendering a second one):

```json
{
  "success": true,
  "data": {
    "invoice": {
      "id": "inv_generated_1",
      "purchaseOrderId": "po_xyz789",
      "supplierId": "sup_techsource",
      "status": "EXTRACTED",
      "source": "GENERATED",
      "fileMimeType": "application/pdf",
      "invoiceNumber": "INV-20260824-ABC123",
      "invoiceDate": "2026-08-26T12:00:00.000Z",
      "subtotalPaise": 18200000,
      "taxPaise": 3276000,
      "totalPaise": 21476000,
      "currency": "INR",
      "items": [
        {
          "lineNumber": 1,
          "description": "Wireless Keyboard (PRPH-KB-001)",
          "quantity": 100,
          "unitPricePaise": 182000,
          "lineTotalPaise": 18200000
        }
      ]
    }
  },
  "error": null
}
```

Unlike an `UPLOADED` invoice, `status` is `EXTRACTED` immediately — there is no `UPLOADED` /
`PROCESSING` spinner state, because nothing needs to be read off the document; it was rendered from
already-known numbers. Download it with `GET /invoices/:id/pdf` (below).

### Errors

| Status | Code | When |
| --- | --- | --- |
| 404 | `NOT_FOUND` | Unknown purchase order, or one owned by another organization; unknown `purchaseOrderItemId` in `items[]` |
| 400 | `VALIDATION_ERROR` | An override `quantity` that is zero, negative, fractional or out of range; the same `purchaseOrderItemId` repeated in `items[]` |
| 409 | `INVALID_STATE` | Purchase order is `DRAFT`, `PENDING_APPROVAL` or `REJECTED` |
| 503 | `DEPENDENCY_UNAVAILABLE` | Cloudinary unreachable while storing the rendered PDF |

## GET /api/v1/invoices/:id/pdf

Streams the invoice document's stored bytes — works the same for a `GENERATED` invoice (always a
PDF) and an `UPLOADED` one (PDF, PNG or JPEG). `Content-Type` follows the file's own stored MIME
type, not a hardcoded `application/pdf`.

```js
const response = await fetch(`/api/v1/invoices/${invoiceId}/pdf`, {
  headers: { "x-organization-id": orgId },
});
const blob = await response.blob(); // hand this to the browser's download flow
```

`404 NOT_FOUND` for an unknown invoice or one owned by another organization.

## GET /api/v1/purchase-orders/:id/pdf

Renders the purchase order (supplier, line items, subtotal/tax/total, approval details) as a PDF
and streams it straight back — nothing is stored, nothing is cached; every call re-renders from the
current row. `404 NOT_FOUND` for an unknown purchase order or one owned by another organization.

## GET /api/v1/receipts/:id/pdf

Renders the goods receipt (ordered / received / damaged / accepted quantities per line) as a PDF
and streams it straight back — same no-storage behavior as the purchase order PDF above.
`404 NOT_FOUND` for an unknown goods receipt or one owned by another organization.

## Notes for all three download endpoints

- Response headers: `Content-Type`, `Content-Disposition: attachment; filename="..."`, and
  `Content-Length`. There is no JSON envelope on a `200` — a binary body has no JSON
  representation. A `404` or other error before rendering starts still returns the normal
  `{ success: false, error }` envelope.
- Rendered with PDFKit's built-in Helvetica font. Money is printed as `INR 1,820.00` (currency
  code, not the `₹` symbol) — Helvetica has no Rupee glyph.
- These documents are not legally binding and say so in their footer; they exist for demo
  convenience.
