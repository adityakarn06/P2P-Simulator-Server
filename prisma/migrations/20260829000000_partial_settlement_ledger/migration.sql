-- Partial settlement ledger.
--
-- Payment stops being "one row per invoice for the whole purchase order" and
-- becomes a tranche: an invoice may be settled across several payments, and a
-- purchase order across several invoices, capped at the order total.
--
-- Every statement below backfills before it constrains, so an existing database
-- with completed payments migrates without losing a row.

-- 1. New enums / enum values ------------------------------------------------

CREATE TYPE "PaymentKind" AS ENUM ('FULL', 'PARTIAL');

ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_PAID' BEFORE 'PAID';

-- 2. Payment: tranche identity ----------------------------------------------

ALTER TABLE "Payment" ADD COLUMN "settlementKey" TEXT;
UPDATE "Payment" SET "settlementKey" = 'auto' WHERE "settlementKey" IS NULL;
ALTER TABLE "Payment" ALTER COLUMN "settlementKey" SET NOT NULL;

ALTER TABLE "Payment" ADD COLUMN "kind" "PaymentKind" NOT NULL DEFAULT 'FULL';
ALTER TABLE "Payment" ADD COLUMN "authorizedBy" TEXT;
ALTER TABLE "Payment" ADD COLUMN "authorizationReason" TEXT;
ALTER TABLE "Payment" ADD COLUMN "authorizingExceptionId" TEXT;

-- 3. Payment.purchaseOrderId becomes a real, required relation ---------------
-- It was a nullable bare string with no foreign key, so it could not be
-- queried per order — which the cumulative cap depends on.

UPDATE "Payment" p
SET "purchaseOrderId" = i."purchaseOrderId"
FROM "Invoice" i
WHERE i."id" = p."invoiceId" AND p."purchaseOrderId" IS NULL;

DELETE FROM "Payment" WHERE "purchaseOrderId" IS NULL;

ALTER TABLE "Payment" ALTER COLUMN "purchaseOrderId" SET NOT NULL;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. One payment per invoice becomes one payment per (invoice, tranche) ------

DROP INDEX IF EXISTS "Payment_invoiceId_key";

CREATE UNIQUE INDEX "Payment_invoiceId_settlementKey_key"
  ON "Payment"("invoiceId", "settlementKey");

CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");
CREATE INDEX "Payment_organizationId_kind_idx" ON "Payment"("organizationId", "kind");
CREATE INDEX "Payment_organizationId_purchaseOrderId_idx"
  ON "Payment"("organizationId", "purchaseOrderId");
