# Shipments API Reference (Frontend)

How a client lists and reads shipments. See `architecture/goods-receipt.md` for the backend design,
`api-docs/purchase-orders-api.md` for the stage that precedes this, and `api-docs/receipts-api.md`
for simulating delivery and listing goods receipts.

Conventions (headers, envelope, error codes) are identical to the requisitions API — see
`api-docs/requisitions-api.md`. Every request carries `x-organization-id`.

## The stage in one picture

```text
POST /purchase-orders/:id/approve  ──▶ PO APPROVED + shipment IN_TRANSIT
        │
        ▼
GET /shipments/:id                 ──▶ status IN_TRANSIT, goodsReceipt null
GET /shipments                     ──▶ list, newest first
        │
        ▼
POST /receipts/simulate            (see receipts-api.md) ──▶ shipment DELIVERED, PO RECEIVED
```

The shipment id comes from `GET /purchase-orders/:id`, which returns `{ purchaseOrder, shipment }`.

## GET /api/v1/shipments

Query: `status` (any `ShipmentStatus`: `CREATED` | `IN_TRANSIT` | `DELIVERED`), `purchaseOrderId`,
`limit` (1–100, default 20), `cursor`.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "ship_123",
        "purchaseOrderId": "po_xyz789",
        "poNumber": "PO-20260824-K3F9QZ0V8B2M",
        "trackingNumber": "TRK-0000000ABCDEFG",
        "carrier": null,
        "status": "IN_TRANSIT",
        "shippedAt": "2026-08-24T09:00:00.000Z",
        "deliveredAt": null,
        "expectedDeliveryDate": "2026-08-29T00:00:00.000Z",
        "createdAt": "2026-08-24T09:00:00.000Z"
      }
    ],
    "nextCursor": null
  },
  "error": null
}
```

Newest first. Pass `nextCursor` back as `cursor` for the following page. `poNumber` is included on
every row so the list page can render a human-readable identifier without a second round-trip to
`GET /purchase-orders/:id` per shipment. This endpoint does not include `goodsReceipt` — check
`GET /shipments/:id` or `GET /receipts` for delivery status.

## GET /api/v1/shipments/:id

```json
{
  "success": true,
  "data": {
    "shipment": {
      "id": "ship_123",
      "purchaseOrderId": "po_xyz789",
      "trackingNumber": "TRK-0000000ABCDEFG",
      "carrier": null,
      "status": "IN_TRANSIT",
      "shippedAt": "2026-08-24T09:00:00.000Z",
      "deliveredAt": null,
      "expectedDeliveryDate": "2026-08-29T00:00:00.000Z",
      "createdAt": "2026-08-24T09:00:00.000Z"
    },
    "goodsReceipt": null
  },
  "error": null
}
```

`goodsReceipt` is `null` until the delivery is recorded, and then carries the same shape documented
in `api-docs/receipts-api.md`, including line items. A shipment belonging to another organization is
a `404`.

### Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Unknown `status`, or `limit` out of range |
| 404 | `NOT_FOUND` | Unknown shipment, or one owned by another organization |
