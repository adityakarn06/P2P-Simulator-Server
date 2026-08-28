import { randomUUID } from "node:crypto";
import "./src/config/env.js";
import { prisma } from "./src/config/prisma.js";
import { enqueueMatching } from "./src/queues/matching.queue.js";
import { normalizeInvoiceNumber } from "./src/services/matching.service.js";

/**
 * Stands in for a supplier issuing a SECOND, differently-numbered invoice
 * against a purchase order that has already been paid in full. Everything after
 * this — matching, the payment gate, exceptions — runs for real off the queue.
 */
async function main() {
  const [purchaseOrderId, invoiceNumber] = process.argv.slice(2);

  const po = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    select: {
      organizationId: true, poNumber: true, supplierId: true, currency: true,
      subtotalPaise: true, taxPaise: true, totalPaise: true,
      supplier: { select: { name: true } },
      items: { select: { description: true, quantity: true, unitPricePaise: true, lineTotalPaise: true, productId: true } },
    },
  });

  const id = randomUUID();
  await prisma.invoice.create({
    data: {
      id,
      organizationId: po.organizationId,
      purchaseOrderId,
      supplierId: po.supplierId,
      status: "EXTRACTED",
      source: "UPLOADED",
      fileUrl: "seeded://second-invoice",
      filePublicId: `seeded/${id}`,
      fileMimeType: "application/pdf",
      fileSizeBytes: 1,
      invoiceNumber,
      normalizedInvoiceNumber: normalizeInvoiceNumber(invoiceNumber),
      invoiceDate: new Date(),
      supplierNameRaw: po.supplier.name,
      poNumberRaw: po.poNumber,
      subtotalPaise: po.subtotalPaise,
      taxPaise: po.taxPaise,
      totalPaise: po.totalPaise,
      currency: po.currency,
      extractedAt: new Date(),
      items: {
        create: po.items.map((item, index) => ({
          lineNumber: index + 1,
          description: item.description,
          quantity: item.quantity,
          unitPricePaise: item.unitPricePaise,
          lineTotalPaise: item.lineTotalPaise,
        })),
      },
    },
  });

  await enqueueMatching({ invoiceId: id, organizationId: po.organizationId });
  console.log(id);
  await prisma.$disconnect();
  // The queue holds a Redis connection open; nothing else keeps this alive.
  process.exit(0);
}
main();
