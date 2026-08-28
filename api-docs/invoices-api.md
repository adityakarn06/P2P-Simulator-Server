# Invoices API Reference (Frontend)

How a client uploads a supplier invoice and watches it get read. See `architecture/invoices.md` for
the backend design, `api-docs/receipts-api.md` for the stage that precedes this, and
`api-docs/documents-api.md` for generating a demo invoice PDF instead of uploading a real one.

## `Invoice.source`: GENERATED vs UPLOADED

Every invoice carries `source`, either `UPLOADED` or `GENERATED`:

- **`UPLOADED`** — a real document a client posted to `POST /invoices` below. This is the only kind
  of invoice OCR reads and three-way matching acts on.
- **`GENERATED`** — a PDFKit document rendered from the purchase order's own data by
  `POST /purchase-orders/:id/generate-invoice` (see `api-docs/documents-api.md`). It exists purely
  so a demo operator has something to download and re-upload; it is created straight at
  `EXTRACTED` with real totals, is never sent to Gemini, and never enters matching. A purchase
  order can therefore have **two** invoice rows: one `GENERATED` (convenience) and one `UPLOADED`
  (the one that actually gets matched and paid). `GET /invoices` accepts `source` as a filter.

Conventions (headers, envelope, error codes) are identical to the requisitions API — see
`api-docs/requisitions-api.md`. Every request carries `x-organization-id`.

## The stage in one picture

```text
POST /receipts/simulate       ──▶ PO RECEIVED
        │
        ▼
POST /invoices                ──▶ 202, invoice UPLOADED   (multipart upload)
        │
        ▼  automatic — invoice worker, a few seconds
GET /invoices/:id             ──▶ EXTRACTED   fields + items populated
                              ──▶ FAILED      extraction gave up, see failureReason
        │
        ▼  automatic — matching worker (deterministic, no AI)
GET /invoices/:id             ──▶ APPROVED    match passed → payment queued automatically
                              ──▶ EXCEPTION   mismatch → see api-docs/exceptions-api.md
        │
        ▼
Payment / Exception resolution  (see api-docs/exceptions-api.md)
```

The purchase order id comes from `GET /purchase-orders/:id` or from `requisition.purchaseOrder`.

## POST /api/v1/invoices

`multipart/form-data`, **not** JSON.

| Field | Type | Notes |
| --- | --- | --- |
| `file` | file | The invoice document. PDF, PNG or JPEG, max 10 MB. |
| `purchaseOrderId` | text | The purchase order being invoiced. |

```js
const body = new FormData();
body.append("file", fileInput.files[0]);
body.append("purchaseOrderId", purchaseOrderId);

await fetch("/api/v1/invoices", {
  method: "POST",
  headers: { "x-organization-id": orgId }, // do NOT set Content-Type — the browser adds the boundary
  body,
});
```

The purchase order must be `APPROVED`, `SHIPPED`, `RECEIVED` or `COMPLETED`. Uploading against a
`DRAFT`, `PENDING_APPROVAL` or `REJECTED` order is a `409`.

Response — `202 Accepted`. The document is stored and the extraction job is queued; **no OCR has
happened yet**:

```json
{
  "success": true,
  "data": {
    "invoice": {
      "id": "inv_abc123",
      "purchaseOrderId": "po_xyz789",
      "supplierId": "sup_techsource",
      "status": "UPLOADED",
      "source": "UPLOADED",
      "fileMimeType": "application/pdf",
      "fileSizeBytes": 48213,
      "invoiceNumber": null,
      "invoiceDate": null,
      "supplierNameRaw": null,
      "poNumberRaw": null,
      "subtotalPaise": null,
      "taxPaise": null,
      "totalPaise": null,
      "currency": null,
      "extractedAt": null,
      "extractionAttempts": 0,
      "failureReason": null,
      "createdAt": "2026-08-26T11:00:00.000Z",
      "updatedAt": "2026-08-26T11:00:00.000Z",
      "items": []
    }
  },
  "error": null
}
```

Every extracted field is `null` and `items` is empty at this point. Poll `GET /invoices/:id` until
`status` leaves `UPLOADED`/`PROCESSING`.

The response carries no document URL. To show or download the document, call
`GET /api/v1/invoices/:id/pdf`, which streams the stored bytes back through a freshly minted,
short-lived link — it works for a `GENERATED` PDF and an `UPLOADED` PDF/PNG/JPEG alike.

## `Invoice.status`

| `status` | Meaning | What the client shows |
| --- | --- | --- |
| `UPLOADED` | Stored, extraction queued | spinner — transient |
| `PROCESSING` | The worker is reading the document | spinner |
| `EXTRACTED` | Fields and line items populated | render the invoice; matching is queued |
| `FAILED` | Extraction gave up after 3 attempts | render `failureReason`; terminal, re-upload the document |
| `MATCHING` | Three-way matching running | spinner — transient, usually resolves quickly (no AI call in this stage) |
| `APPROVED` | Match passed, or a human overrode a mismatch | payment is queued automatically |
| `EXCEPTION` | Match failed | fetch `GET /exceptions?entityId={invoiceId}` — see `api-docs/exceptions-api.md` |
| `PAID` | Settled | terminal, success state |

`extractionAttempts` counts how many times the worker has tried, so a slow extraction can show
"attempt 2 of 3" rather than an indefinite spinner.

## GET /api/v1/invoices/:id

The same invoice fields as the upload response, populated once extraction succeeds — but note the
envelope shape differs: `POST /invoices` nests the invoice under `data.invoice`, while this endpoint
returns it directly as `data`:

```json
{
  "success": true,
  "data": {
    "id": "inv_abc123",
    "purchaseOrderId": "po_xyz789",
    "status": "EXTRACTED",
    "invoiceNumber": "INV-2026-0042",
    "invoiceDate": "2026-08-20T00:00:00.000Z",
    "supplierNameRaw": "TechSource Distributors",
    "poNumberRaw": "PO-20260824-ABC123",
    "subtotalPaise": 18200000,
    "taxPaise": 3276000,
    "totalPaise": 21476000,
    "currency": "INR",
    "extractedAt": "2026-08-26T11:00:07.000Z",
    "extractionAttempts": 1,
    "failureReason": null,
    "items": [
      {
        "id": "ii_1",
        "lineNumber": 1,
        "description": "Wireless Keyboard",
        "quantity": 100,
        "unitPricePaise": 182000,
        "lineTotalPaise": 18200000,
        "productId": null
      }
    ]
  },
  "error": null
}
```

An invoice belonging to another organization is a `404`.

### Reading the extracted fields

Money is integer paise, as everywhere else: `21476000` → `₹2,14,760.00`.

The `*Raw` suffix on `supplierNameRaw` and `poNumberRaw` is meaningful — **these are what the
document claims, not verified facts.** They are deliberately not reconciled against the purchase
order at this stage; that comparison is three-way matching's job. Expect them to disagree sometimes,
and don't render them as though the backend has confirmed them.

Any field can be `null`: the extractor is instructed to return `null` rather than guess at something
it cannot read. A `null` `totalPaise` is a legitimate outcome for a poor scan, not a bug. `items` can
be an empty array if the document has no readable line-item table.

`productId` on a line is always `null` today — matching invoice lines to catalogue products is part
of the matching stage.

## GET /api/v1/invoices

Cursor-paginated list, newest first.

| Query param | Default | Notes |
| --- | --- | --- |
| `status` | — | Any `Invoice.status` value |
| `source` | — | `UPLOADED` or `GENERATED` — see above |
| `purchaseOrderId` | — | Invoices for one purchase order |
| `limit` | `20` | Max `100` |
| `cursor` | — | The `nextCursor` from the previous page |

```json
{
  "success": true,
  "data": { "items": [ { "id": "inv_abc123", "...": "" } ], "nextCursor": null },
  "error": null
}
```

`nextCursor` is `null` on the last page.

## Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | No file, or sent under a field name other than `file`; missing `purchaseOrderId`; file over 10 MB; type other than PDF/PNG/JPEG; file contents don't match the declared type; empty file |
| 404 | `NOT_FOUND` | Unknown purchase order or invoice, or one owned by another organization |
| 409 | `INVALID_STATE` | Purchase order is `DRAFT`, `PENDING_APPROVAL` or `REJECTED` |
| 503 | `DEPENDENCY_UNAVAILABLE` | Cloudinary unreachable during upload |

The type check is on the file's actual bytes, not its declared `Content-Type` — renaming a `.txt` to
`.pdf` is rejected with `400`.

An extraction failure is **not** an HTTP error: the upload already returned `202`. It surfaces as
`status: "FAILED"` with `failureReason` on the next poll.

## Uploading a duplicate

Uploading a second invoice for the same purchase order is accepted, and so is the same invoice
number twice. Detecting that is a three-way match check (`DUPLICATE_INVOICE`), not an upload-time
refusal — the duplicate is meant to be recorded and flagged, not silently rejected. Don't build UI
that assumes one invoice per purchase order.

This check only looks at prior `UPLOADED` invoices. Uploading the same document a `GENERATED`
invoice was rendered from — the intended demo flow — is expected to share its invoice number and
does **not** trigger `DUPLICATE_INVOICE`.

## Not yet available

- No `ThreeWayMatch` / `MatchCheck` read endpoint — a passing match's full 12-check breakdown isn't
  fetchable anywhere; only a *failing* check surfaces, via the resulting exception's `metadata.checks`
  (see `api-docs/exceptions-api.md`).
- No `GET /payments` / `GET /payments/:id` — a payment's progress is only visible indirectly through
  `Invoice.status`.
- No delete or re-upload endpoint. A `FAILED` invoice is re-tried by uploading the document again as
  a new invoice.
- No Socket.IO events — poll `GET /invoices/:id` roughly every second while `status` is `UPLOADED`,
  `PROCESSING`, or `MATCHING`.
