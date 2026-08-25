# Goods Receipts API Reference (Frontend)

How a client simulates a shipment's delivery and reads back the goods receipts it created. See
`architecture/goods-receipt.md` for the backend design, `api-docs/shipments-api.md` for reading and
listing shipments themselves, and `api-docs/invoices-api.md` for the stage that follows.

Conventions (headers, envelope, error codes) are identical to the requisitions API — see
`api-docs/requisitions-api.md`. Every request carries `x-organization-id`.

## The stage in one picture

```text
GET /shipments/:id                 (see shipments-api.md) ──▶ status IN_TRANSIT, goodsReceipt null
        │
        ▼
POST /receipts/simulate            ──▶ shipment DELIVERED, PO RECEIVED, GoodsReceipt created
GET /receipts                      ──▶ list, newest first
        │
        ▼
POST /invoices                     (next stage — see invoices-api.md)
```

The shipment id comes from `GET /purchase-orders/:id`, which returns `{ purchaseOrder, shipment }`.

## POST /api/v1/receipts/simulate

Simulated IoT: a delivery event the frontend triggers by hand. Two payload shapes are accepted,
never both.

Flat form — the single-line purchase orders the MVP generates:

```json
{ "shipmentId": "ship_123", "receivedQuantity": 98, "damagedQuantity": 2 }
```

Explicit form — any purchase order, and the shape a real IoT integration would post:

```json
{
  "shipmentId": "ship_123",
  "items": [
    { "purchaseOrderItemId": "poi_1", "receivedQuantity": 98, "damagedQuantity": 2 }
  ],
  "receivedBy": "Warehouse 2",
  "notes": "Two units crushed in transit"
}
```

`damagedQuantity` defaults to `0`. A line omitted from `items[]` is recorded as nothing received.
`receivedBy` and `notes` are optional on both forms.

Response — `201` on the first call, `200` on a replay:

```json
{
  "success": true,
  "data": {
    "shipment": { "id": "ship_123", "status": "DELIVERED", "deliveredAt": "2026-08-26T10:00:00.000Z", "...": "" },
    "goodsReceipt": {
      "id": "gr_456",
      "purchaseOrderId": "po_xyz789",
      "shipmentId": "ship_123",
      "status": "PARTIAL",
      "receivedAt": "2026-08-26T10:00:00.000Z",
      "receivedBy": "dev-user",
      "notes": null,
      "createdAt": "2026-08-26T10:00:00.000Z",
      "items": [
        {
          "id": "ri_1",
          "purchaseOrderItemId": "poi_1",
          "productId": "prod_kb",
          "orderedQuantity": 100,
          "receivedQuantity": 98,
          "damagedQuantity": 2,
          "acceptedQuantity": 96
        }
      ]
    },
    "purchaseOrder": { "id": "po_xyz789", "status": "RECEIVED", "...": "" }
  },
  "error": null
}
```

### Quantities

- `receivedQuantity` — units that physically arrived, damaged ones included.
- `damagedQuantity` — the subset of those that cannot be accepted.
- `acceptedQuantity` = `receivedQuantity - damagedQuantity`. **This is the number three-way matching
  compares against the invoice.** Show it as "accepted" in the UI; an invoice for more than this is
  what produces a `QUANTITY_MISMATCH` exception at the matching stage.

`status` is `COMPLETED` only when every line was accepted in full; a short delivery or any damage
makes it `PARTIAL`. A partial receipt is not an error and does not block the workflow — matching
decides what it costs.

### Idempotency

Re-posting the **same** delivery returns the receipt already on file with `200` and writes nothing. A
shipment can only ever carry one receipt, and a receipt is immutable: re-posting the same
`shipmentId` with *different* quantities is refused with `409 CONFLICT` rather than silently
answering `200` with the stored numbers. There is no correction endpoint — a wrong receipt is a
matching exception for a human to resolve.

### Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Both payload shapes at once; nothing received; damaged > received; received > ordered; flat form on a multi-line purchase order; unknown or repeated `purchaseOrderItemId` |
| 404 | `NOT_FOUND` | Unknown shipment, or one owned by another organization |
| 409 | `INVALID_STATE` | Shipment still `CREATED`; purchase order not `APPROVED`/`SHIPPED`; shipment `DELIVERED` with no receipt (corrupt state, reported rather than repaired) |
| 409 | `CONFLICT` | A concurrent delivery claimed the shipment first, or a replay reported quantities different from the receipt on file (`details` carries `recorded` vs `submitted`) |

## GET /api/v1/receipts

Query: `status` (any `GoodsReceiptStatus`: `PENDING` | `PARTIAL` | `COMPLETED`), `purchaseOrderId`,
`shipmentId`, `limit` (1–100, default 20), `cursor`.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "gr_456",
        "purchaseOrderId": "po_xyz789",
        "poNumber": "PO-20260824-K3F9QZ0V8B2M",
        "shipmentId": "ship_123",
        "status": "PARTIAL",
        "receivedAt": "2026-08-26T10:00:00.000Z",
        "receivedBy": "dev-user",
        "createdAt": "2026-08-26T10:00:00.000Z"
      }
    ],
    "nextCursor": null
  },
  "error": null
}
```

Newest first. Pass `nextCursor` back as `cursor` for the following page. Rows are **summary only** —
no `items[]`. For the line-item breakdown of a receipt, use `GET /shipments/:id`, whose
`goodsReceipt.items` carries the full per-line quantities documented above.

### Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Unknown `status`, or `limit` out of range |
