# p2p-simulator

Standalone backend for an AI-powered Procure-to-Pay (P2P) hackathon MVP. A natural-language purchase
request goes in; a matched, paid (or human-reviewed) invoice comes out the other end, end to end:

```text
"I need 100 wireless keyboards under ₹2000 each within 7 days"
        │
        ▼  POST /api/v1/requisitions
Requirement extraction (Gemini)  →  Supplier discovery + ranking (deterministic)
        │
        ▼  automatic
Purchase Order  →  Approval  →  Shipment  →  Simulated goods receipt
        │
        ▼  POST /api/v1/invoices (multipart upload)
Invoice OCR (Gemini Vision)  →  Three-way match (deterministic)
        │
        ├─ MATCHED     → automatic simulated payment → PAID
        └─ MISMATCHED  → Exception → POST /api/v1/exceptions/:id/resolve → payment or reject
```

See `CLAUDE.md` for the full architecture, non-negotiable rules, and coding conventions this repo is
built against. See `api-docs/README.md` for the frontend-facing contract (start there if you're
building a UI against this backend).

## Stack

Node.js, TypeScript, Express, PostgreSQL (Prisma), Redis (BullMQ), Zod, Gemini API, Cloudinary.
No authentication yet — see [Auth](#auth-mvp) below.

## Setup

```bash
pnpm install
cp .env.example .env   # fill in DATABASE_URL, CLOUDINARY_*, GEMINI_API_KEY, etc.
docker compose up -d redis
pnpm run prisma:generate
pnpm run prisma:migrate
pnpm run prisma:seed     # optional: sample suppliers/products for local testing
pnpm run dev              # API server on http://localhost:4000
pnpm run dev:worker       # worker process (separate terminal — required for anything to progress)
```

The API and the worker process are **two separate processes**. The API only ever persists and
enqueues; every AI call, OCR pass, matching run, and payment charge happens in `pnpm run dev:worker`.
If nothing seems to progress past an initial `202`/`201` response, check that the worker process is
running and pointed at the same Redis/Postgres.

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm run dev` | API server with hot reload (`tsx watch`) |
| `pnpm run dev:worker` | Worker process with hot reload |
| `pnpm run dev:all` | Both, in parallel |
| `pnpm run build` | Compile to `dist/` |
| `pnpm start` / `pnpm run start:worker` | Run compiled output |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm run lint` / `pnpm run lint:fix` | Biome |
| `pnpm test` / `pnpm run test:watch` | Vitest |
| `pnpm run prisma:generate` / `:migrate` / `:seed` / `:studio` | Prisma CLI shortcuts |

## Health checks

- `GET /health` — liveness, always 200, no dependency calls.
- `GET /ready` — readiness, checks Postgres + Redis, returns 503 if either is unreachable.

## Auth (MVP)

There is no real authentication yet. `src/middleware/auth.ts` attaches a fixed
`DEV_ORGANIZATION_ID` / `DEV_USER_ID` (from `.env`) to every `/api/v1` request as `req.auth`, so
tenant-scoped queries can be written now and Clerk can be dropped in later without touching
controllers or services. Every response is still scoped as if multi-tenant: a record belonging to
another `organizationId` is a `404`, never a `403` — do not build a UI that assumes a single global
tenant. Pass `x-organization-id` explicitly if you need to exercise more than one dev tenant locally.

## Testing

```bash
pnpm test
```

Unit tests cover the deterministic rule modules directly (`supplierRanking`, `approvalRules`,
`threeWayMatch`, `paymentRules`, `receiptRules`, `supplierPerformance`, `anomalyDetection`) plus
worker- and service-level tests for each queue consumer (`tests/*.worker.test.ts`), the analytics
endpoints (`tests/analytics.api.test.ts`), and the exception resolution flow
(`tests/exceptionResolution.test.ts`). Gemini, Cloudinary, and the payment provider are mocked in
every automated test — nothing in `pnpm test` calls a live external service.

Thinnest coverage today is the conversational requisition flow: `tests/requisition.worker.test.ts`
has four cases, there is no API-level test for `POST /requisitions` or `POST /:id/messages`, and
`src/rules/requirementRules.ts` (`mergeDraft`, correction and conflict handling) is untested.

## Supplier performance and analytics

Two loops sit on top of the core workflow.

**The OTIF loop.** Every goods receipt folds a delivery into the supplier's record — on time, in
full, damage rate, lead time — and recomputes `Supplier.reliabilityScore`
(`src/rules/supplierPerformance.ts`). That score carries 20% of the sourcing weight in
`src/rules/supplierRanking.ts`, so a supplier that delivers late or short ranks lower on the *next*
requisition without anybody editing a row. The score is shrunk toward `baselineReliability` — what
the supplier was onboarded with — so one bad delivery moves it without destroying the vendor.
Counters move through atomic increments inside the receipt's own transaction, and only on the branch
that actually creates the receipt, so a replayed delivery cannot be counted twice.

**Advisory anomaly signals.** `src/rules/anomalyDetection.ts` compares each purchase order and
invoice against the organization's own history — price outliers, quantity outliers, large first
orders, predicted late delivery, near-duplicate invoices, supplier degradation. Deterministic
statistics (mean and σ), not a model.

These signals are advisory and that is load-bearing: they live in their own `AnomalySignal` table
and can never block a payment, raise an `Exception`, or change a match verdict.
`src/rules/threeWayMatch.ts` stays the only financial gate and `src/rules/paymentRules.ts` the only
payment one — filing a heuristic as an `Exception` would silently block money, because
`evaluatePayment` refuses to pay while one is open.

Both surface through `GET /api/v1/analytics/{summary,suppliers,anomalies}` — see
[`api-docs/analytics-api.md`](./api-docs/analytics-api.md). The summary's headline touchless rate is
**invoice-side**: PO approval is deliberately a human step in this build
(`PO_AUTO_APPROVE_ENABLED` is `false`), so an end-to-end figure would be zero by construction and
would say nothing about how well the automation works. Label it that way in any UI.

## Known gaps

Deliberate, but worth knowing before you build on them.

- **`x-organization-id` is trusted verbatim.** `src/middleware/auth.ts` reads the header with no
  verification, so any client can act as any tenant. Every tenant-scoping guarantee downstream rests
  on that header — this is fine for the no-auth MVP and is the first thing to fix when auth lands.
- **`CLAUDE.md` describes some things this repo deliberately did not build**: S3 (the code is
  Cloudinary-only, behind `StorageProvider`), Clerk, Socket.IO, and a structured logger. Polling and
  `console.log` are the reality; see the note at the top of `CLAUDE.md`.
- **A purchase order never closes.** `PurchaseOrderStatus.SHIPPED` and `COMPLETED` are never
  written — a PO stops at `RECEIVED` even after its invoice is paid. In supply-chain terms that
  means there is no open-commitment figure.
- **`ShipmentStatus.CREATED` is never written** — approval inserts the shipment directly at
  `IN_TRANSIT`. `ExceptionType.REQUIREMENT_INCOMPLETE` is likewise never raised; incomplete
  requirements are handled conversationally instead.
- **`PO_NUMBER` and `PRODUCT` match failures fall through to `SYSTEM_FAILURE`**, because no
  `ExceptionType` describes them. Documented in `threeWayMatch.ts`, but it does mislabel a business
  problem as a technical one on the exceptions screen.
- **Exception `REJECT` is a dead end.** The invoice stays `EXCEPTION` with a `BLOCKED` payment and
  no further path — no re-match, no partial settlement, no credit note.
- **Requisitions are single-line.** `src/zod/requisition.schema.ts` carries one `productName` and
  one `quantity`. Purchase orders, receipts and three-way matching all already handle multiple
  lines; only intake is constrained.
