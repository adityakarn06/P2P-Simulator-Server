import "./src/config/env.js";
import { prisma } from "./src/config/prisma.js";
import { enqueueMatching } from "./src/queues/matching.queue.js";
import { enqueuePayment } from "./src/queues/payment.queue.js";

async function snapshot(invoiceId: string) {
  const inv = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { status: true, threeWayMatch: { select: { id: true } }, payments: { select: { id: true, settlementKey: true, status: true, providerReference: true } } },
  });
  return {
    invoice: inv.status,
    matchId: inv.threeWayMatch?.id ?? null,
    paymentId: inv.payments.at(0)?.id ?? null,
    paymentStatus: inv.payments.at(0)?.status ?? null,
    providerRef: inv.payments.at(0)?.providerReference ?? null,
    matches: await prisma.threeWayMatch.count({ where: { invoiceId } }),
    checks: await prisma.matchCheck.count({ where: { threeWayMatch: { invoiceId } } }),
    payments: await prisma.payment.count({ where: { invoiceId } }),
    exceptions: await prisma.exception.count({ where: { entityId: invoiceId } }),
    audits: await prisma.auditLog.count({ where: { entityId: invoiceId } }),
  };
}

async function main() {
  const invoiceId = process.argv[2];
  const org = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { organizationId: true } })).organizationId;

  const before = await snapshot(invoiceId);
  console.log("BEFORE:", JSON.stringify(before));

  await enqueueMatching({ invoiceId, organizationId: org });
  await enqueuePayment({ invoiceId, organizationId: org });
  await new Promise((r) => setTimeout(r, 8000));

  const after = await snapshot(invoiceId);
  console.log("AFTER :", JSON.stringify(after));

  const drift = Object.keys(before).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]));
  console.log(drift.length === 0 ? "\nIDEMPOTENT: nothing changed." : `\nDRIFT in: ${drift.join(", ")}`);
  await prisma.$disconnect();
  process.exit(0);
}
main();
