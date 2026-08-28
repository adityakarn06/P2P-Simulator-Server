# Sourcing API Reference (Frontend)

How a client observes supplier discovery — the stage that runs automatically once a requisition's
requirements are complete. See `architecture/supplier-discovery.md` for the backend design, and
`api-docs/requisitions-api.md` for the conversational intake endpoints that precede this.

**Supplier discovery adds no new endpoints.** It is a background worker, and everything it produces
is read through the existing `GET /api/v1/requisitions/:id`. Conventions (headers, envelope, error
codes) are identical to the requisitions API — see that doc.

## The stage in one picture

```text
POST /requisitions              ──▶ conversation until requirements are complete
        │
        ▼  (automatic, no client call)
requisition worker              ──▶ status REQUIREMENTS_EXTRACTED
        │
        ▼  (automatic, no client call)
supplier-discovery worker       ──▶ SUPPLIER_SELECTED   sourcing + supplierCandidates populated
                                └─▶ FAILED              failureReason + supplierCandidates populated
        │
        ▼
GET /requisitions/:id           ──▶ client polls for the outcome
```

The client never triggers discovery. After `POST /requisitions` (or `.../messages`) returns
`status: "REQUIREMENTS_EXTRACTED"` (equivalently, `requirements != null`), poll
`GET /requisitions/:id` until `status` leaves `REQUIREMENTS_EXTRACTED`.

## Status lifecycle

| `status` | What the client should show |
| --- | --- |
| `NEEDS_CLARIFICATION` | The chat is still open — render `clarificationMessage`, keep the composer active |
| `REQUIREMENTS_EXTRACTED` | Sourcing is running — spinner. **Keep polling.** |
| `SUPPLIER_SELECTED` | Done — render `sourcing` + the `supplierCandidates` table |
| `PO_CREATED` | Purchase order exists — see `api-docs/purchase-orders-api.md`; `sourcing` still populated |
| `FAILED` | Render `failureReason` and the rejected `supplierCandidates` |

Discovery normally completes in a few seconds, most of it the Gemini call that writes the rationale.
Poll every ~1s, and give up after ~30s with a "still working" state rather than an error — the job
retries on its own.

> `REQUIREMENTS_EXTRACTED` is a transient state, not a resting one. If it persists for more than a
> few seconds the worker is down or backed up; it is never a terminal outcome the user should see.

## `GET /api/v1/requisitions/:id`

The full response shape is in `api-docs/requisitions-api.md`. Supplier discovery adds two fields:

```ts
interface RequisitionDetail {
  // ... all existing fields (status, requirement, messages, failureReason, …)

  /** The committed decision. null until a supplier is selected, and on FAILED. */
  sourcing: Sourcing | null;

  /** Every supplier evaluated, ranked. Empty until discovery runs. */
  supplierCandidates: SupplierCandidate[];
}

interface Sourcing {
  selectedSupplier: {
    id: string;
    /** Resolved server-side; null only if the candidate row is missing. */
    name: string | null;
  };
  selectedSupplierProductId: string;
  totalScore: number;              // 0–100, 2dp
  candidatesEvaluated: number;     // includes ineligible suppliers
  rationale: string | null;        // 1–3 sentences, ready to render verbatim
  decidedAt: string;               // ISO 8601
}

interface SupplierCandidate {
  supplierId: string;
  supplierName: string;
  rank: number;                    // 1..n across ALL candidates, eligible first
  eligible: boolean;
  /** Why this supplier lost. null when eligible. Human-readable, safe to render. */
  ineligibleReason: string | null;
  unitPricePaise: number;          // integer minor units — never a float
  deliveryDays: number;
  availableStock: number;
  scores: {
    price: number;                 // each 0–100, 2dp
    delivery: number;
    reliability: number;
    rating: number;
    stock: number;
    total: number;                 // weighted sum of the five above
  };
}
```

### Reading the data correctly

- **`supplierCandidates` includes losers.** Filter on `eligible` to split the table. Ineligible rows
  carry real `unitPricePaise` / `deliveryDays` / `availableStock` (useful for a comparison view) but
  **all five `scores` are `0`** — they were never scored. Do not render those zeros as ratings; show
  `ineligibleReason` instead.
- **`rank` spans the whole list.** Eligible candidates come first in score order, then ineligible
  ones. `rank: 1` is always the winner when one exists.
- **The winner is `sourcing.selectedSupplier.id`.** It matches the candidate with `rank: 1`; prefer
  the `sourcing` object as the source of truth.
- **`rationale` is display text only.** It is written by Gemini *after* the decision is final and no
  backend logic reads it. Never parse it — every fact in it is available as a typed field. It may
  fall back to a terser deterministic sentence if Gemini was unavailable, and is `null` only on very
  old rows.
- **Money is integer paise.** Divide by 100 for display; never use floats for arithmetic.
  `182000` → `₹1,820.00`.

### Example — `SUPPLIER_SELECTED`

Trimmed to the sourcing fields; the usual `messages`, `requirement`, etc. are still present.

```json
{
  "success": true,
  "data": {
    "id": "cmt6acrpy000y5llor9dl25ag",
    "status": "SUPPLIER_SELECTED",
    "failureReason": null,
    "sourcing": {
      "selectedSupplier": { "id": "sup-techsource", "name": "TechSource Distributors" },
      "selectedSupplierProductId": "sp-keyboard-techsource",
      "totalScore": 97.8,
      "candidatesEvaluated": 3,
      "rationale": "TechSource Distributors was selected because they met all requirements, providing the required 100 units at ₹1,820.00 per unit within 5 days. BudgetBulk Traders was excluded despite a lower price because their stock of 40 units fell short of the order, and Global Office Supplies was disqualified for exceeding the 7-day delivery deadline.",
      "decidedAt": "2026-08-23T22:02:24.576Z"
    },
    "supplierCandidates": [
      {
        "supplierId": "sup-techsource",
        "supplierName": "TechSource Distributors",
        "rank": 1,
        "eligible": true,
        "ineligibleReason": null,
        "unitPricePaise": 182000,
        "deliveryDays": 5,
        "availableStock": 500,
        "scores": { "price": 100, "delivery": 100, "reliability": 95, "rating": 92, "stock": 100, "total": 97.8 }
      },
      {
        "supplierId": "sup-budget-bulk",
        "supplierName": "BudgetBulk Traders",
        "rank": 2,
        "eligible": false,
        "ineligibleReason": "Stock 40 is below the required 100",
        "unitPricePaise": 170000,
        "deliveryDays": 4,
        "availableStock": 40,
        "scores": { "price": 0, "delivery": 0, "reliability": 0, "rating": 0, "stock": 0, "total": 0 }
      },
      {
        "supplierId": "sup-global-office",
        "supplierName": "Global Office Supplies",
        "rank": 3,
        "eligible": false,
        "ineligibleReason": "Delivery in 8 days exceeds the 7-day deadline",
        "unitPricePaise": 195000,
        "deliveryDays": 8,
        "availableStock": 300,
        "scores": { "price": 0, "delivery": 0, "reliability": 0, "rating": 0, "stock": 0, "total": 0 }
      }
    ]
  },
  "error": null
}
```

Note that the cheapest *and* fastest supplier lost: eligibility is a hard gate, not a score. This is
worth making obvious in the UI, because it is the most common "why didn't it pick the cheap one?"
question.

### Example — `FAILED`

```json
{
  "success": true,
  "data": {
    "status": "FAILED",
    "failureReason": "No supplier met every requirement: Global Office Supplies — Stock 0 is below the required 10; TechSource Distributors — Stock 3 is below the required 10",
    "sourcing": null,
    "supplierCandidates": [
      {
        "supplierId": "sup-global-office", "supplierName": "Global Office Supplies",
        "rank": 1, "eligible": false, "ineligibleReason": "Stock 0 is below the required 10",
        "unitPricePaise": 3900000, "deliveryDays": 12, "availableStock": 0,
        "scores": { "price": 0, "delivery": 0, "reliability": 0, "rating": 0, "stock": 0, "total": 0 }
      }
    ]
  },
  "error": null
}
```

`FAILED` is a **successful HTTP response** (`200`, `success: true`) describing a business outcome —
not a transport error. Always branch on `data.status`, never on HTTP status alone.

Failure is terminal: the requisition does not retry itself and no longer accepts chat messages
(`POST /:id/messages` returns `409 INVALID_STATE`). The user must start a new requisition.

## Why sourcing failed

`failureReason` is always a complete, renderable sentence. The three shapes:

| Cause | `failureReason` |
| --- | --- |
| No supplier passed every rule | `No supplier met every requirement: <Supplier> — <reason>; …` |
| Product not in the catalog | `No catalog product matches "<what the user asked for>"` |
| Request too vague to source | `"<wording>" matches more than one catalog product (Wireless Keyboard, Wireless Mouse) — the request is not specific enough to source` |

Only the first populates `supplierCandidates`; the other two fail before any supplier is evaluated,
so the table will be empty. The ambiguity case is the one worth a tailored UI — it is recoverable by
asking the user to be more specific, in a new requisition.

## Rendering suggestions

- Lead with `sourcing.rationale`. It is the single most demo-legible field and already explains the
  trade-off in business English.
- Render the candidate table as two groups — *Selected / considered* and *Not eligible* — with
  `ineligibleReason` as the row's explanation rather than a score.
- Show the five `scores` on eligible rows only, as bars out of 100. The weights are fixed: price 30%,
  delivery 25%, reliability 20%, rating 15%, stock 10%.
- `scores` are peer-relative for price, delivery and stock: `100` means "best among the eligible
  candidates for this requisition", not "best possible". A lone eligible supplier scores 100 on all
  three. Reliability and rating are absolute, so they are comparable across requisitions.

## Not yet available

These are planned but **not implemented** — do not build against them yet:

- Socket.IO events; polling is the only mechanism today

Three things this doc previously listed here are now live and safe to build against:

- **The supplier and product catalog.** `GET /api/v1/suppliers`, `GET /api/v1/suppliers/:id`,
  `GET /api/v1/suppliers/:id/products`, `GET /api/v1/products` and `GET /api/v1/products/:id` are
  implemented, read-only. See `api-docs/suppliers-api.md`.

- **Purchase orders.** `SUPPLIER_SELECTED` queues a purchase-order job that a worker consumes —
  `status` does progress to `PO_CREATED`. See `api-docs/purchase-orders-api.md`.
- **Exceptions.** `GET /api/v1/exceptions` and `POST /api/v1/exceptions/:id/resolve` are
  implemented. A `NO_SUPPLIER_FOUND` exception row is written on sourcing failure and is fetchable
  via `GET /exceptions?entityId={requisitionId}` in addition to `failureReason` on the requisition.
  See `api-docs/exceptions-api.md`.
