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
`threeWayMatch`, `paymentRules`, `receiptRules`) plus worker- and service-level tests for each queue
consumer (`tests/*.worker.test.ts`) and the exception resolution flow
(`tests/exceptionResolution.test.ts`). Gemini, Cloudinary, and the payment provider are mocked in
every automated test — nothing in `pnpm test` calls a live external service.
