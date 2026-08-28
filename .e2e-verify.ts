import "./src/config/env.js";
import { prisma } from "./src/config/prisma.js";

async function main() {
  const invoiceId = process.argv[2];
  const inv = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: {
      status: true, invoiceNumber: true, supplierNameRaw: true, poNumberRaw: true,
      subtotalPaise: true, taxPaise: true, totalPaise: true, currency: true,
      items: { select: { description: true, quantity: true, unitPricePaise: true, lineTotalPaise: true } },
      purchaseOrder: { select: { poNumber: true, totalPaise: true, currency: true } },
      threeWayMatch: {
        select: {
          status: true, totalChecks: true, passedChecks: true, failedChecks: true,
          checks: { select: { checkType: true, passed: true, expected: true, actual: true, variance: true, severity: true }, orderBy: { checkType: "asc" } },
        },
      },
      payments: { select: { settlementKey: true, kind: true, status: true, amountPaise: true, currency: true, provider: true, providerReference: true, blockedReason: true, completedAt: true } },
    },
  });

  console.log("INVOICE      :", inv.status, "|", inv.invoiceNumber, "|", inv.supplierNameRaw, "| PO:", inv.poNumberRaw);
  console.log("EXTRACTED $  : subtotal", inv.subtotalPaise, "tax", inv.taxPaise, "total", inv.totalPaise, inv.currency);
  console.log("PO       $   : total", inv.purchaseOrder.totalPaise, inv.purchaseOrder.currency);
  console.log("ITEMS        :", JSON.stringify(inv.items));
  const m = inv.threeWayMatch;
  console.log("MATCH        :", m ? `${m.status} ${m.passedChecks}/${m.totalChecks} passed, ${m.failedChecks} failed` : "none");
  if (m) for (const c of m.checks) console.log(`   ${c.passed ? "PASS" : "FAIL"}  ${c.checkType.padEnd(18)} expected=${c.expected} actual=${c.actual}`);
  console.log("PAYMENT      :", JSON.stringify(inv.payments));

  const exc = await prisma.exception.findMany({ where: { entityId: invoiceId }, select: { type: true, status: true, severity: true, description: true, resolution: true, resolutionReason: true } });
  console.log("EXCEPTIONS   :", exc.length === 0 ? "none" : "");
  for (const e of exc) console.log(`   ${e.type} [${e.status}] ${e.description.slice(0, 110)}`);

  const audits = await prisma.auditLog.findMany({ where: { entityId: invoiceId }, select: { action: true, actorType: true, createdAt: true }, orderBy: { createdAt: "asc" } });
  console.log("AUDIT        :", audits.map((a) => `${a.action}(${a.actorType})`).join(" -> "));
  await prisma.$disconnect();
}
main();
