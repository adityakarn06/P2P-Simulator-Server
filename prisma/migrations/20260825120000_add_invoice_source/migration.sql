-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'INVOICE_GENERATED';

-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('UPLOADED', 'GENERATED');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "source" "InvoiceSource" NOT NULL DEFAULT 'UPLOADED',
ADD COLUMN     "generatedForPurchaseOrderId" TEXT;

-- CreateIndex
CREATE INDEX "Invoice_organizationId_source_idx" ON "Invoice"("organizationId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_generatedForPurchaseOrderId_key" ON "Invoice"("generatedForPurchaseOrderId");
