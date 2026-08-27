-- AlterTable
ALTER TABLE "InvoiceItem" ALTER COLUMN "unitPricePaise" DROP NOT NULL,
ALTER COLUMN "lineTotalPaise" DROP NOT NULL;
