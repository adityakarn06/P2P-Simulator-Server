-- CreateEnum
CREATE TYPE "AnomalySignalType" AS ENUM ('PRICE_OUTLIER', 'QUANTITY_OUTLIER', 'NEW_SUPPLIER_HIGH_VALUE', 'NEAR_DUPLICATE_INVOICE', 'PREDICTED_LATE_DELIVERY', 'SUPPLIER_DEGRADATION');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'SUPPLIER_PERFORMANCE_UPDATED';

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "acceptedUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "avgLeadTimeDays" DOUBLE PRECISION,
ADD COLUMN     "baselineReliability" DOUBLE PRECISION,
ADD COLUMN     "damagedUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inFullDeliveries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastDeliveryAt" TIMESTAMP(3),
ADD COLUMN     "onTimeDeliveries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "orderedUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalDeliveries" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AnomalySignal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "signalType" "AnomalySignalType" NOT NULL,
    "severity" "Severity" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "observed" TEXT NOT NULL,
    "baseline" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnomalySignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnomalySignal_organizationId_createdAt_idx" ON "AnomalySignal"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AnomalySignal_organizationId_severity_idx" ON "AnomalySignal"("organizationId", "severity");

-- CreateIndex
CREATE INDEX "AnomalySignal_entityType_entityId_idx" ON "AnomalySignal"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "AnomalySignal_organizationId_signalType_entityType_entityId_key" ON "AnomalySignal"("organizationId", "signalType", "entityType", "entityId");

-- AddForeignKey
ALTER TABLE "AnomalySignal" ADD CONSTRAINT "AnomalySignal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: capture every existing supplier's seeded score as its baseline
-- before any delivery starts moving reliabilityScore away from it. Without
-- this, the first goods receipt would shrink toward whatever the score happens
-- to be at that moment rather than toward what the supplier was onboarded with.
UPDATE "Supplier" SET "baselineReliability" = "reliabilityScore" WHERE "baselineReliability" IS NULL;
