# Requisitions API Reference

Covers the conversational requisition-intake endpoints added in Phase 4. Base path:
`/api/v1/requisitions`. See `architecture/conversational-requirements.md` for the backend design
behind these endpoints.

## Conventions

### Headers

Every request must include:

| Header | Required | Description |
| --- | --- | --- |
| `x-organization-id` | Yes (in production use; falls back to `DEV_ORGANIZATION_ID` if omitted) | Tenant identifier. All data is scoped to this org; a requisition belonging to another org returns `404 NOT_FOUND`, never its data. |
| `content-type: application/json` | Yes, on `POST` requests | |

There is no authentication yet (hackathon MVP) — `x-organization-id` is trusted as-is.

### Response envelope

Every response, success or failure, has this exact shape:

```ts
// success
{ "success": true, "data": T, "error": null }

// failure
{ "success": false, "data": null, "error": { "code": string, "message": string, "details"?: unknown } }
```

Always branch on `success`, not on HTTP status alone.

### Errors

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Request body/query/params failed schema validation (e.g. empty `input`, `input` over 2000 chars, unknown `status` filter). `details` holds the Zod issue list. |
| `UNAUTHORIZED` | 401 | No tenant could be resolved (no header, no `DEV_ORGANIZATION_ID` fallback configured). |
| `NOT_FOUND` | 404 | Unknown `organizationId`, or a requisition id that doesn't exist / doesn't belong to this org. |
| `INVALID_STATE` | 409 | Sent a message to a requisition that's already past the conversational phase. `details.status` holds the current status. |
| `DEPENDENCY_UNAVAILABLE` | 503 | Gemini, Postgres, or Redis unreachable. |
| `INTERNAL_ERROR` | 500 | Unexpected server error. |

Example error body:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": { "issues": [{ "path": ["input"], "message": "Message cannot be empty" }] }
  }
}
```

### Shared types

```ts
type RequisitionStatus =
  | "CREATED"
  | "PROCESSING"               // a chat turn is being processed by the extraction worker
  | "NEEDS_CLARIFICATION"      // waiting on the user for more info
  | "REQUIREMENTS_EXTRACTED"   // conversation done, Requirement created, downstream flow started
  | "SUPPLIER_SELECTED"
  | "PO_CREATED"
  | "FAILED";

type MessageRole = "USER" | "ASSISTANT";

interface RequisitionMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string; // ISO 8601
}

/** Requirement fields extracted from the conversation so far. null = not yet known. */
interface DraftRequirements {
  productName: string | null;
  quantity: number | null;             // positive integer
  maxUnitPricePaise: number | null;    // positive integer, minor currency units
  currency: string | null;             // ISO 4217, e.g. "INR"
  deliveryDays: number | null;         // positive integer, days from now
  location: string | null;
  specifications: Record<string, unknown>;
}

/** Same fields as DraftRequirements, but every field is guaranteed non-null. Only appears once complete. */
interface RequirementCreateInput {
  productName: string;
  quantity: number;
  maxUnitPricePaise: number;
  currency: string;
  deliveryDeadlineDays: number;        // note: renamed from deliveryDays on the draft
  deliveryLocation: string | null;     // optional field — allowed to stay null even when complete
  specifications: Record<string, unknown>;
}
```

`specifications` is a free-form object of any explicitly stated attributes (colour, connectivity,
warranty, etc.) and is not validated beyond "must be an object." Money fields are integer minor
units (paise) — never floats.

---

## `POST /api/v1/requisitions`

Starts a new requisition from a free-form message. Creates the requisition, enqueues extraction,
and waits (up to 20s) for the worker to reply.

### Request

```ts
interface RequestBody {
  input: string; // required, 1–2000 chars after trim
}
```

```json
{ "input": "I need 100 wireless keyboards under ₹2000 each within 7 days" }
```

### Response — `200 OK`

`RequisitionChatResult`:

```ts
interface RequisitionChatResult {
  status: RequisitionStatus;                    // the requisition's real status — see below
  requisitionId: string;
  message: string;                              // assistant's natural-language reply, always render
  missingFields?: string[];                     // present when status = NEEDS_CLARIFICATION
  conflicts?: string[];                         // present when status = NEEDS_CLARIFICATION
  requirements?: RequirementCreateInput | null;  // present when status = REQUIREMENTS_EXTRACTED
}
```

`status` is the requisition's actual status, so a `200` and a `202` can be told apart by it:

| `status` | What it means |
| --- | --- |
| `NEEDS_CLARIFICATION` | The assistant asked a question. Render `message`, show `missingFields`, keep the composer open. |
| `REQUIREMENTS_EXTRACTED` | Requirements are in and supplier discovery has been queued. `requirements` is populated. |
| `PROCESSING` | **`202` only** — the worker had not answered within ~20s. Poll `GET /:id`. |
| `SUPPLIER_SELECTED` / `PO_CREATED` / `FAILED` | The requisition had already moved past the conversation when this turn was delivered; nothing was changed. Treat as read-only and render the current state. |

Earlier revisions of this API returned `"PROCESSING"` on the `200` completion branch, so clients
were told to detect completion with `requirements != null` rather than the status string. That is
fixed — `status` is now authoritative, and `"PROCESSING"` appears only on a `202`. The
`requirements != null` check still works and remains a safe thing to keep.

Example — needs clarification:

```json
{ "success": true, "data": {
  "status": "NEEDS_CLARIFICATION",
  "requisitionId": "clx1a2b3c",
  "message": "Almost there — could you also tell me the maximum you'd like to spend per unit and when you need it delivered by?",
  "missingFields": ["maxUnitPricePaise", "deliveryDays"],
  "conflicts": []
}}
```

Example — complete in one turn:

```json
{ "success": true, "data": {
  "status": "REQUIREMENTS_EXTRACTED",
  "requisitionId": "clx1a2b3c",
  "message": "Got it. I have all the requirements and started the procurement process.",
  "requirements": {
    "productName": "wireless keyboard",
    "quantity": 100,
    "maxUnitPricePaise": 200000,
    "currency": "INR",
    "deliveryDeadlineDays": 7,
    "deliveryLocation": null,
    "specifications": {}
  }
}}
```

### Response — `202 Accepted`

Only if the extraction worker hasn't finished within ~20s (Gemini being slow, queue backlog).
Rare in practice.

```json
{ "success": true, "data": {
  "status": "PROCESSING",
  "requisitionId": "clx1a2b3c",
  "message": "Still working on your request — check back in a moment for my reply."
}}
```

No `missingFields`/`conflicts`/`requirements` on this shape. Poll `GET /:id` until `status`
changes.

### Errors

`VALIDATION_ERROR` (empty/too-long `input`), `UNAUTHORIZED`, `NOT_FOUND` (unknown org),
`DEPENDENCY_UNAVAILABLE`, `INTERNAL_ERROR`.

---

## `POST /api/v1/requisitions/:id/messages`

Appends a follow-up user message to an existing requisition's conversation and waits for the
worker's reply, same as the create endpoint. Used for clarifications and corrections.

### Path params

| Param | Type | Description |
| --- | --- | --- |
| `id` | string | Requisition id |

### Request

```ts
interface RequestBody {
  input: string; // required, 1–2000 chars after trim
}
```

### Response

Identical shape to `POST /requisitions` — `RequisitionChatResult`, `200` or `202`.

### Errors

Same as `POST /requisitions`, plus:

| Code | HTTP status | When |
| --- | --- | --- |
| `NOT_FOUND` | 404 | `id` doesn't exist, or belongs to a different `organizationId` |
| `INVALID_STATE` | 409 | Requisition status is already `REQUIREMENTS_EXTRACTED`, `SUPPLIER_SELECTED`, `PO_CREATED`, or `FAILED` — it no longer accepts chat messages. `details: { status }` names the current status. |

---

## `GET /api/v1/requisitions/:id`

Fetches full requisition detail including the entire message transcript. No side effects.

### Path params

| Param | Type | Description |
| --- | --- | --- |
| `id` | string | Requisition id |

### Response — `200 OK`

```ts
interface RequisitionDetail {
  id: string;
  organizationId: string;
  rawInput: string;                          // the very first message that created this requisition
  status: RequisitionStatus;
  failureReason: string | null;              // set only after a technical failure degraded gracefully
  clarificationMessage: string | null;       // last assistant message text (mirrors messages[-1] when role=ASSISTANT)
  missingFields: string[];
  conflicts: string[];
  draftRequirements: DraftRequirements;
  turnCount: number;
  createdAt: string;                         // ISO 8601
  updatedAt: string;                         // ISO 8601
  requirement: RequirementCreateInput | null; // null until status = REQUIREMENTS_EXTRACTED
  messages: RequisitionMessage[];             // full transcript, ascending createdAt

  // Supplier discovery (Phase 5) — see api-docs/sourcing-api.md for full types
  sourcing: Sourcing | null;                  // the committed decision; null until SUPPLIER_SELECTED
  supplierCandidates: SupplierCandidate[];    // every supplier evaluated, ranked; [] until discovery runs

  // Purchase order (Phase 6) — see api-docs/purchase-orders-api.md for the full type and lifecycle
  purchaseOrder: PurchaseOrder | null;        // null until the purchase-order worker has run
}
```

`sourcing` and `supplierCandidates` are populated automatically by the supplier-discovery worker
once requirements are complete — no client call triggers them. Poll this endpoint while `status` is
`REQUIREMENTS_EXTRACTED`. Both fields, the ranking semantics, and the failure shapes are documented
in [`api-docs/sourcing-api.md`](./sourcing-api.md).

`purchaseOrder` is populated automatically once `sourcing` is committed — no second request is
needed to decide whether an approval is pending. It carries `poNumber`, `status`, money fields
(paise), `supplier`, and line `items`; see [`api-docs/purchase-orders-api.md`](./purchase-orders-api.md)
for the full shape and the approve/reject endpoints.

### Errors

`NOT_FOUND` (unknown id or cross-tenant), `UNAUTHORIZED`, `INTERNAL_ERROR`.

---

## `GET /api/v1/requisitions`

Lists requisitions for the current organization, most recent first. Cursor-paginated.

### Query params

| Param | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `status` | `RequisitionStatus` | No | — | Must be one of the enum values |
| `limit` | integer | No | `20` | 1–100 |
| `cursor` | string | No | — | A requisition `id` from a previous page's `nextCursor` |

### Response — `200 OK`

```ts
interface RequisitionListItem {
  id: string;
  rawInput: string;
  status: RequisitionStatus;
  clarificationMessage: string | null;
  missingFields: string[];
  conflicts: string[];
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

interface RequisitionListResponse {
  items: RequisitionListItem[];
  nextCursor: string | null; // pass as `cursor` for the next page; null = last page
}
```

Note: list items do not include `messages`, `requirement`, `sourcing`, or `supplierCandidates` —
fetch `GET /:id` for those.

### Errors

`VALIDATION_ERROR` (bad `status`/`limit`/`cursor`), `UNAUTHORIZED`, `NOT_FOUND` (unknown org),
`INTERNAL_ERROR`.
