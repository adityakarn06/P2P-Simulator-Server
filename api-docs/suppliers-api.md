# Suppliers & Products API

The enterprise catalog that supplier discovery ranks against, exposed read-only. Base path
`/api/v1`.

```text
GET /suppliers
GET /suppliers/:id
GET /suppliers/:id/products
GET /products
GET /products/:id
```

Read-only on purpose: a mutable price or stock level would silently change what the next requisition
buys, with nothing in the audit log to explain it. Catalog rows are seeded (`prisma/seed.ts`); the
only writer at runtime is `recordGoodsReceipt`, maintaining the OTIF counters on `Supplier`.

## `GET /suppliers`

| Param | Type | Notes |
| --- | --- | --- |
| `q` | string | case-insensitive substring of the supplier name |
| `isActive` | `"true"` \| `"false"` | |
| `minRating` | 0–5 | |
| `limit` | 1–100, default 20 | |
| `cursor` | string | the previous page's `nextCursor` |

```json
{
  "success": true,
  "data": {
    "suppliers": [
      {
        "id": "sup_1",
        "name": "TechSource Distributors",
        "email": "sales@techsource.example",
        "phone": null,
        "rating": 4.5,
        "reliabilityScore": 0.92,
        "baselineReliability": 0.9,
        "isActive": true,
        "totalDeliveries": 4,
        "onTimeDeliveries": 4,
        "inFullDeliveries": 3,
        "orderedUnits": 400,
        "acceptedUnits": 396,
        "damagedUnits": 4,
        "avgLeadTimeDays": 5.5,
        "lastDeliveryAt": "2026-08-25T00:00:00.000Z",
        "_count": { "supplierProducts": 3 }
      }
    ],
    "nextCursor": null
  },
  "error": null
}
```

## `GET /suppliers/:id`

Returns `{ supplier, scorecard, products }`. `scorecard` is the same row
`GET /analytics/suppliers` returns — OTIF rates, the reliability delta against the onboarding
baseline, order count and spend — reused rather than recomputed, so it can never disagree with the
figures supplier ranking actually uses. It is `null` for a supplier with no scorecard yet.

`products` is the supplier's offers, each with the product it is for.

404 when the supplier belongs to another organization.

## `GET /suppliers/:id/products`

Just the offers:

```json
{
  "success": true,
  "data": {
    "products": [
      {
        "id": "sp_1",
        "unitPricePaise": 182000,
        "currency": "INR",
        "stockQuantity": 500,
        "deliveryDays": 5,
        "minOrderQuantity": 1,
        "updatedAt": "2026-08-01T00:00:00.000Z",
        "product": {
          "id": "prod_kb",
          "sku": "KB-WL-001",
          "name": "Wireless Keyboard",
          "category": "Peripherals",
          "description": null,
          "unit": "unit"
        }
      }
    ]
  },
  "error": null
}
```

A foreign supplier id is a 404, not an empty list — an empty list would read as "this supplier
stocks nothing", which is a different and misleading answer.

## `GET /products` and `GET /products/:id`

`GET /products` takes `q` (matches name or SKU), `category`, `limit` and `cursor`.

`GET /products/:id` returns `{ product, offers }`, with every supplier offering it ordered cheapest
first, then fastest — the same ordering supplier discovery starts from. Each offer carries the full
supplier row, so a sourcing screen can show price against reliability without a second request.

## Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `minRating` outside 0–5, `limit` over 100, empty `q` |
| 404 | `NOT_FOUND` | no such supplier or product in this organization |
