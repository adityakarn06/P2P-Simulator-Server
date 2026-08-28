This project runs on Node.js, not Bun.

- Use `pnpm` for package management (`pnpm install`, `pnpm run <script>`, `pnpm exec <cmd>`).
- Use `tsx` for running/watching TypeScript directly (`pnpm run dev`, `pnpm run dev:worker`), and `tsc` for production builds (`pnpm run build`).
- Use `express` for the HTTP server. Use `ioredis` for Redis (required by BullMQ's connection layer) and `pg` (via `@prisma/adapter-pg`) for Postgres.
- Use `dotenv` (loaded in `src/config/env.ts`) — Node does not auto-load `.env`.
- Use Cloudinary for document storage, not S3.
- There is no authentication yet for the MVP — `src/middleware/auth.ts` attaches a fixed dev tenant to every request; do not add Clerk without being asked.
- No logging library is used; `console.log`/`console.error` only.

## Testing

Use `pnpm test` (Vitest) to run tests.

```ts
import { describe, expect, it } from "vitest";

it("hello world", () => {
  expect(1).toBe(1);
});
```


# Procurement AI Backend

> **Where this document and the code differ, the code is right.** Several sections below describe an
> intended design that was deliberately not built:
>
> - **Storage is Cloudinary, not S3.** `src/storage/storage.interface.ts` is the seam; there is no
>   `S3StorageProvider` and no AWS SDK dependency. Read "S3" below as "the storage provider".
> - **There is no authentication and no Clerk.** `src/middleware/auth.ts` attaches a fixed dev
>   tenant from an unverified `x-organization-id` header. Tenant scoping is enforced per query.
> - **There is no Socket.IO.** Clients poll; `api-docs/` documents the polling contract.
> - **There is no structured logger.** `console.log` / `console.error` only.
>
> Everything else — the deterministic/AI boundary, the queue topology, integer-paise money, the
> state machines, idempotency, and audit logging — matches the implementation.

## Mission

Standalone backend for an AI-powered Procure-to-Pay (P2P) hackathon MVP.

Core workflow:

Natural Language Request → Zod → Express API → Redis/BullMQ → Requirement Worker → Gemini → Structured Requirements → Supplier Discovery → Supplier Ranking → Supplier Selection → Purchase Order → PO Approval → Shipment → Simulated Goods Receipt → Invoice Upload → Invoice Worker → Gemini Vision/OCR → Structured Invoice → 3-Way Matching → MATCHED → Payment / MISMATCHED → Exception → Human Approval.

This is a **4-day hackathon MVP**. Optimize for a working end-to-end flow, reliability, demoability, and a credible enterprise scalability story.

Do not over-engineer.

---

## Architecture

This is ONE standalone backend repository.

There is NO Turborepo, monorepo, or backend microservice architecture.

```text
procurement-backend/
├── src/
│   ├── config/
│   ├── middleware/
│   ├── routes/
│   ├── controllers/
│   ├── services/
│   ├── workers/
│   ├── queues/
│   ├── ai/
│   ├── rules/
│   ├── storage/
│   ├── validators/
│   └── utils/
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── tests/
├── .env.example
├── Dockerfile
├── package.json
└── CLAUDE.md
```

Runtime:

```text
Next.js Frontend
      │ HTTPS / REST
      ▼
Express API
      │
 ┌────┴────┐
 ▼         ▼
Postgres  Redis/BullMQ
            │
      ┌─────┼──────────────┐
      ▼     ▼              ▼
   Req.   Invoice       Matching
  Worker   Worker         Worker
      │     │              │
      └─────┼──────────────┘
            ▼
          Gemini
            │
            ▼
        PostgreSQL

S3 stores documents.
Socket.IO provides workflow updates.
```

---

## Stack

Use:

- Node.js
- TypeScript
- Express
- PostgreSQL
- Prisma
- Redis
- BullMQ
- Zod
- Gemini API
- AWS S3
- Clerk
- Socket.IO
- Pino or equivalent structured logger
- Vitest or Jest

Use strict TypeScript.

Do not add dependencies without a reason.

---

## Non-negotiable architecture rules

1. Express handles authentication, authorization, validation, persistence, commands, and job enqueueing.
2. Workers handle expensive/asynchronous processing.
3. PostgreSQL is the source of truth.
4. Redis/BullMQ is the asynchronous processing backbone.
5. S3 stores documents.
6. Gemini interprets unstructured information only.
7. Deterministic TypeScript controls financial and business-critical decisions.
8. Every AI response must be parsed and validated with Zod.
9. API requests must never wait for long-running AI/OCR workflows.
10. Workers must be retryable and idempotent.
11. Important state transitions must be audited.
12. Every organization-owned record must be tenant-scoped.
13. Never introduce Kafka, Kubernetes, microservices, GraphQL, or similar infrastructure for the MVP.
14. Keep one backend repository and independently scalable worker processes.
15. Prefer simple code that can ship in four days.

Core principle:

> AI interprets. Deterministic code decides.

---

## API responsibility

Every API request should follow:

```text
Request → Authentication → Authorization → Validation → Controller → Service → Database / Queue → Response
```

API should generally:

- authenticate
- authorize
- validate
- persist
- enqueue
- respond quickly

API should NOT:

- call Gemini for long-running processing
- perform OCR synchronously
- perform large supplier ranking synchronously
- perform 3-way matching synchronously
- process payments synchronously
- execute the whole P2P workflow inside one HTTP request

---

## API response contract

Success:

```json
{
  "success": true,
  "data": {},
  "error": null
}
```

Failure:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": {}
  }
}
```

Use proper HTTP status codes:

- 200 success
- 201 synchronous creation
- 202 asynchronous accepted
- 400 malformed input
- 401 unauthenticated
- 403 unauthorized
- 404 not found
- 409 conflict
- 422 semantic validation error
- 429 rate limited
- 500 unexpected error
- 503 dependency unavailable

---

## Authentication and multi-tenancy

Use Clerk.

Authenticated context should provide:

```text
userId
organizationId
```

Never trust `organizationId` from request bodies.

Every tenant-owned query must be scoped by organization.

Bad:

```ts
prisma.invoice.findUnique({ where: { id } });
```

Preferred:

```ts
prisma.invoice.findFirst({ where: { id, organizationId } });
```

Cross-organization access must never be possible.

---

## Environment variables

Use `.env.example`.

```env
NODE_ENV=development
PORT=4000
DATABASE_URL=
REDIS_URL=
GEMINI_API_KEY=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
AWS_S3_BUCKET=
CLERK_SECRET_KEY=
FRONTEND_URL=http://localhost:3000
```

Validate environment variables with Zod.

Never commit real secrets. Never log secrets.

---

## Database

Core models:

```text
Organization
User
Supplier
Product
SupplierProduct
Requisition
Requirement
SourcingDecision
SupplierCandidate
PurchaseOrder
PurchaseOrderItem
Shipment
GoodsReceipt
ReceiptItem
Invoice
InvoiceItem
ThreeWayMatch
MatchCheck
Payment
Exception
AuditLog
AIProcessingLog
AnomalySignal
```

Every organization-owned model should contain `organizationId`.

Use indexes on organizationId, status, foreign keys, and commonly queried fields.

Use unique constraints to prevent duplicate business records.

---

## Money

Never use floating point for money.

Use integer minor units.

For INR:

```text
₹1,820 → 182000 paise
```

Use:

```text
unitPricePaise
subtotalPaise
taxPaise
totalPaise
```

Always store currency.

Never let Gemini calculate financial totals.

---

## State machines

Do not allow arbitrary status mutation.

### Requisition

```text
CREATED → PROCESSING → REQUIREMENTS_EXTRACTED → SUPPLIER_SELECTED → PO_CREATED
```

Possible: `NEEDS_CLARIFICATION`, `FAILED`

### Purchase Order

```text
DRAFT → PENDING_APPROVAL → APPROVED → SHIPPED → RECEIVED → COMPLETED
```

### Shipment

```text
CREATED → IN_TRANSIT → DELIVERED
```

### Goods Receipt

```text
PENDING → PARTIAL → COMPLETED
```

### Invoice

```text
UPLOADED → PROCESSING → EXTRACTED → MATCHING → APPROVED → PAID
```

Alternative:

```text
MATCHING → EXCEPTION → UNDER_REVIEW → APPROVED / REJECTED
```

### Payment

```text
PENDING → PROCESSING → COMPLETED
```

or `BLOCKED`, `FAILED`.

### Exception

```text
OPEN → UNDER_REVIEW → RESOLVED / REJECTED
```

Invalid transitions must fail with `INVALID_STATE`.

---

## Validation

Use Zod at every external boundary:

- API request bodies
- query params
- route params
- environment variables
- queue payloads
- AI responses
- uploaded file metadata
- external provider responses where appropriate

Frontend validation is for UX. Backend validation is authoritative.

Never bypass validation with `as SomeType` for untrusted data.

---

# Procurement workflow

## 1. Requisition API

```http
POST /api/v1/requisitions
```

Input:

```json
{"input":"I need 100 wireless keyboards under ₹2000 each within 7 days"}
```

Flow:

```text
Auth → Organization → Zod → Create Requisition → status=PROCESSING → AuditLog → enqueue requisition job → 202
```

Do NOT call Gemini from the API.

---

## 2. Requisition worker

Queue: `requisition`

Job: `extract-requirements`

Payload:

```json
{"requisitionId":"req_123","organizationId":"org_123"}
```

Flow:

```text
Load requisition → verify state → versioned system prompt → Gemini → JSON.parse → Zod → Requirement → update Requisition → AIProcessingLog → AuditLog → supplier-discovery job
```

Prompt requirements:

```text
You are an enterprise procurement requirement extraction engine.

Extract only information explicitly present.

Never invent quantity, price, delivery deadline, location, or specifications.
Use null for missing values.
Return JSON only.
Follow the required schema.
```

If required information is missing, use `NEEDS_CLARIFICATION`. Do not hallucinate.

---

## 3. Supplier discovery

Queue: `supplier-discovery`

Flow:

```text
Requirement → Find products → Find supplier-product relationships → Filter eligible suppliers → Calculate deterministic scores → Rank → Select → SourcingDecision → AuditLog → purchase-order job
```

Eligibility:

```text
stock >= requested quantity
price <= maximum price
delivery <= deadline
```

Initial ranking:

```text
Price          30%
Delivery       25%
Reliability    20%
Rating         15%
Stock          10%
```

Supplier ranking is deterministic TypeScript. Do not use Gemini for numerical ranking.

If no supplier qualifies:

```text
Requisition = FAILED
Exception = NO_SUPPLIER_FOUND
```

---

## 4. Purchase Order worker

Queue: `purchase-order`

Flow:

```text
Load requisition → requirement → sourcing decision → supplier → supplier product → validate → generate PO number → create PO → create items → calculate subtotal → calculate tax → calculate total → approval rules → audit
```

MVP approval:

```text
< ₹1,00,000 → auto approve
>= ₹1,00,000 → PENDING_APPROVAL
```

Approval rules belong in `src/rules/approvalRules.ts`.

Never let an LLM calculate totals.

---

## 5. Shipment / simulated IoT receipt

After PO approval:

```text
PO APPROVED → Shipment → IN_TRANSIT
```

Receipt endpoint:

```http
POST /api/v1/receipts/simulate
```

Input:

```json
{"shipmentId":"ship_123","receivedQuantity":98,"damagedQuantity":2}
```

Flow:

```text
Auth → Zod → shipment validation → GoodsReceipt → Shipment update → PO update → AuditLog → realtime event
```

This is simulated IoT. Do not build real hardware.

---

## 6. S3 document storage

Never store raw invoice PDFs in PostgreSQL.

Use:

```ts
interface StorageProvider {
  upload(...)
  download(...)
  delete(...)
  getSignedUrl(...)
}
```

Implement `S3StorageProvider`.

Path:

```text
organizations/{organizationId}/invoices/{invoiceId}/original.pdf
```

Bucket must be private. Use signed URLs.

---

## 7. Invoice upload API

```http
POST /api/v1/invoices
```

Content type: `multipart/form-data`

Fields:

```text
file
purchaseOrderId
```

Flow:

```text
Auth → organization → validate PO → validate file → create Invoice → S3 upload → AuditLog → invoice queue → 202
```

Allowed initial files: PDF, PNG, JPEG.

Never perform OCR in the request handler.

---

## 8. Invoice worker

Queue: `invoice`

Job: `process-invoice`

Flow:

```text
Load invoice → S3 download → Gemini Vision → JSON.parse → Zod → deterministic consistency checks → save invoice → AIProcessingLog → AuditLog → matching job
```

Extract:

```text
invoiceNumber
invoiceDate
supplierName
poNumber
items
quantity
unitPrice
subtotal
tax
total
currency
```

AI must never modify the PO or approve payment.

After final extraction failure:

```text
Invoice = FAILED
Exception = INVOICE_EXTRACTION_FAILED
```

---

## 9. Three-way matching

Create `src/rules/threeWayMatch.ts`.

Inputs:

```text
PurchaseOrder
GoodsReceipt
Invoice
```

Checks:

```text
Supplier
PO Number
Product
Ordered Quantity
Received Quantity
Invoiced Quantity
Unit Price
Subtotal
Tax
Total
Currency
Duplicate Invoice
```

Each check returns:

```ts
{
  checkType,
  expected,
  actual,
  passed,
  variance,
  severity
}
```

Overall: `MATCHED` or `MISMATCHED`.

Example:

```text
PO = 100
Receipt = 98
Invoice = 100
→ QUANTITY_MISMATCH
→ payment blocked
```

Do not use AI here.

---

## 10. Matching worker

Queue: `matching`

Flow:

```text
Load Invoice → Load PO → Load Receipt → organization check → threeWayMatch() → save ThreeWayMatch → save MatchChecks → AuditLog
```

If matched:

```text
Invoice = APPROVED
→ payment job
```

If mismatched:

```text
Invoice = EXCEPTION
Payment = BLOCKED
Exception created
No payment job
AuditLog
```

Must be idempotent.

---

## 11. Payment worker

Payment is simulated.

Use:

```text
PaymentProvider
└── SimulatedPaymentProvider
```

Flow:

```text
Invoice APPROVED → verify successful match → verify no existing payment → Payment PROCESSING → simulated success → Payment COMPLETED → Invoice PAID → AuditLog
```

Never pay exception invoices, failed matches, blocked payments, or already-paid invoices.

---

## 12. Exceptions

Types:

```text
REQUIREMENT_INCOMPLETE
NO_SUPPLIER_FOUND
PO_APPROVAL_REQUIRED
INVOICE_EXTRACTION_FAILED
QUANTITY_MISMATCH
PRICE_MISMATCH
SUPPLIER_MISMATCH
DUPLICATE_INVOICE
TAX_MISMATCH
TOTAL_MISMATCH
PAYMENT_FAILURE
SYSTEM_FAILURE
```

Endpoints:

```http
GET /api/v1/exceptions
GET /api/v1/exceptions/:id
POST /api/v1/exceptions/:id/resolve
```

Resolution:

```json
{"decision":"APPROVE","reason":"Supplier confirmed the remaining quantity."}
```

Every resolution needs a reason and AuditLog.

---

# Queue architecture

Queues:

```text
requisition
supplier-discovery
purchase-order
invoice
matching
payment
```

Job payloads should contain IDs, not entire database objects:

```json
{"invoiceId":"inv_123","organizationId":"org_123"}
```

Workers load fresh state from PostgreSQL.

---

# Idempotency and retries

Assume every BullMQ job can run more than once.

Use:

- unique constraints
- state checks
- transactions
- idempotency keys
- existence checks

Prevent duplicate POs, matches, exceptions, and payments.

Retry transient failures such as Gemini timeout, S3 timeout, network error, or temporary DB/Redis failure.

Do not endlessly retry business failures such as quantity mismatch, price mismatch, duplicate invoice, or no supplier.

Default:

```text
maxAttempts = 3
exponential backoff
```

After final technical failure:

```text
Create SYSTEM_FAILURE exception
Update entity
AuditLog
```

---

# Database transactions

Use Prisma transactions for atomic state changes:

- PO creation
- PO approval
- invoice persistence
- matching persistence
- exception resolution
- payment creation

Never keep a DB transaction open while waiting for Gemini, S3, or external HTTP.

---

# Audit logging

Important events:

```text
REQUISITION_CREATED
REQUIREMENTS_EXTRACTED
SUPPLIERS_DISCOVERED
SUPPLIER_SELECTED
PO_CREATED
PO_APPROVED
SHIPMENT_CREATED
GOODS_RECEIVED
INVOICE_UPLOADED
INVOICE_EXTRACTED
MATCH_STARTED
MATCH_COMPLETED
EXCEPTION_CREATED
EXCEPTION_RESOLVED
PAYMENT_APPROVED
PAYMENT_COMPLETED
WORKFLOW_FAILED
```

Actor types:

```text
USER
SYSTEM
AI
WORKER
SUPPLIER
```

Audit records are immutable through normal APIs.

---

# Realtime

Use Socket.IO for workflow updates.

Events:

```text
requisition.created
requirements.extracted
supplier.selected
purchase-order.created
purchase-order.approved
shipment.created
goods.received
invoice.uploaded
invoice.extracted
matching.completed
exception.created
exception.resolved
payment.completed
```

Every event should include:

```text
organizationId
entityType
entityId
eventType
timestamp
metadata
```

Realtime is not the source of truth. PostgreSQL is.

---

# API routes

Initial routes:

```text
/api/v1/requisitions
/api/v1/requisitions/:id
/api/v1/suppliers
/api/v1/suppliers/:id
/api/v1/purchase-orders
/api/v1/purchase-orders/:id
/api/v1/purchase-orders/:id/approve
/api/v1/purchase-orders/:id/reject
/api/v1/shipments/:id
/api/v1/receipts/simulate
/api/v1/invoices
/api/v1/invoices/:id
/api/v1/exceptions
/api/v1/exceptions/:id
/api/v1/exceptions/:id/resolve
/api/v1/audit-logs
/api/v1/analytics/summary
/api/v1/analytics/suppliers
/api/v1/analytics/anomalies
/health
/ready
```

Avoid generic status mutation endpoints.

---

# Service architecture

Controllers must be thin:

```text
Route → Controller → Service → Prisma / Queue
```

Do not put business logic in controllers.

Workers should also be thin:

```text
Queue → Processor → Service → Database → Next Queue
```

---

# AI abstraction

Do not scatter Gemini SDK calls across the codebase.

Use:

```ts
interface AIProvider {
  generateStructured<T>(...)
  analyzeDocument<T>(...)
}
```

Implement `GeminiProvider`.

Prompts should be versioned:

```text
src/ai/prompts/
  requisition.v1.ts
  invoice.v1.ts
```

AIProcessingLog records:

```text
model
promptVersion
jobType
entityId
success
latencyMs
error
```

---

# Security

Check:

- authentication
- authorization
- organization isolation
- IDOR
- input validation
- file validation
- S3 privacy
- CORS
- rate limiting
- secrets
- error leakage
- queue payload validation
- Socket.IO organization isolation

Users must not be able to:

- access another organization's records
- mark invoices paid
- bypass matching
- approve arbitrary POs
- resolve another organization's exceptions
- edit audit logs

---

# Testing

Minimum unit tests:

```text
supplier ranking
approval rules
three-way matching
payment rules
state transitions
```

Integration tests:

```text
requisition API
PO approval
receipt simulation
invoice upload
exception resolution
```

End-to-end scenarios:

### Success

```text
Requisition → AI → Supplier → PO → Receipt → Invoice → Match → Payment
```

### Quantity mismatch

```text
PO = 100
Receipt = 98
Invoice = 100
→ Exception
→ Payment blocked
```

### Price mismatch

```text
PO = ₹1820
Invoice = ₹2100
→ Exception
→ Payment blocked
```

Mock Gemini, S3 and payment provider in automated tests.

Never make automated tests depend on live external AI.

---

# Four-day implementation priority

## Day 1

```text
Project setup
→ Prisma
→ PostgreSQL
→ Redis
→ Express
→ Zod
→ Requisition API
→ Requisition Worker
→ Gemini
→ Supplier Discovery
```

## Day 2

```text
Supplier Ranking
→ PO Worker
→ PO API
→ Approval
→ Shipment
→ Simulated Receipt
```

## Day 3

```text
S3
→ Invoice Upload
→ Invoice Worker
→ Gemini Vision
→ 3-Way Matching
→ Payment
→ Exception
```

## Day 4

```text
Realtime
→ Audit Logs
→ Integration Tests
→ Security
→ Reliability
→ Frontend integration
→ Demo hardening
```

If time gets tight, prioritize the successful transaction and one mismatch transaction over additional features.

---

# Explicitly out of scope

Do NOT add unless explicitly requested:

- Turborepo
- monorepo
- Kafka
- Kubernetes
- microservices
- GraphQL
- Elasticsearch
- custom ML models
- RAG
- real payment gateway
- real IoT hardware
- SAP integration
- Oracle integration
- complex event sourcing
- machine-learned or model-based anomaly detection

  Note: *deterministic statistical* anomaly signals are in scope and implemented
  (`src/rules/anomalyDetection.ts`) — `problemStatement.md` names predictive anomaly detection as a
  required capability. They are mean/σ comparisons against the organization's own history, they are
  advisory only, and they can never block a payment or change a match verdict. What stays out of
  scope is anything model-based.
- multi-region infrastructure
- complicated RBAC
- workflow designer

---

# Coding agent rules

When implementing a task:

1. Read this CLAUDE.md first.
2. Inspect the repository before editing.
3. Understand existing architecture.
4. Keep changes scoped.
5. Reuse existing abstractions.
6. Do not rewrite unrelated code.
7. Do not add dependencies unnecessarily.
8. Never hardcode secrets.
9. Never bypass Zod.
10. Never bypass organization isolation.
11. Never bypass state machines.
12. Never make AI the final financial authority.
13. Never perform long-running AI work inside Express.
14. Make every worker idempotent.
15. Add tests for important business logic.
16. Run typecheck, lint, tests and build.
17. Report files changed.
18. Report manual configuration required.
19. If a request conflicts with this architecture, explain the conflict before implementing it.

---

# Definition of Done

A feature is complete only when:

- TypeScript passes
- lint passes
- tests pass
- build passes
- Prisma is valid
- migrations exist when needed
- input is validated
- authorization is enforced
- organization isolation is enforced
- state transitions are valid
- important actions are audited
- async work is queued where appropriate
- jobs are retry-safe
- secrets are not exposed
- errors are handled
- unrelated functionality remains intact

---

# Final principle

Preserve this boundary:

```text
API:
Accept → Authenticate → Authorize → Validate → Persist → Enqueue → Respond

Worker:
Consume → Load → Process → Validate → Apply Rules → Persist → Enqueue

AI:
Interpret unstructured information

Business Rules:
Make deterministic decisions

PostgreSQL:
Source of truth

Redis:
Asynchronous coordination

Cloudinary:
Document storage
```

The goal is not to build the biggest backend.

The goal is to build a **credible, autonomous, high-volume P2P backend that works end-to-end within four days**.
