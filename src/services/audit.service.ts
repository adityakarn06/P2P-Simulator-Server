import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ActorType, AuditAction } from "../generated/prisma/enums.js";

/** Prisma client or an interactive-transaction client — audits must be able to join a transaction. */
type PrismaLike = Pick<Prisma.TransactionClient, "auditLog">;

/**
 * The entities a workflow audit can be filed against. Single source of truth —
 * `entityType` is a free `String` in the schema, so a typo in a call site would
 * otherwise silently desync the `[entityType, entityId]` index lookup.
 */
export const AUDIT_ENTITY_TYPES = [
  "Requisition",
  "PurchaseOrder",
  "Shipment",
  "GoodsReceipt",
  "Invoice",
  "Exception",
  "Supplier",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

// Individually-named exports for call sites, so `entityType: INVOICE_ENTITY`
// reads the same as it always did while staying tied to the one array above.
export const [
  REQUISITION_ENTITY,
  PURCHASE_ORDER_ENTITY,
  SHIPMENT_ENTITY,
  GOODS_RECEIPT_ENTITY,
  INVOICE_ENTITY,
  EXCEPTION_ENTITY,
  SUPPLIER_ENTITY,
] = AUDIT_ENTITY_TYPES;

export interface AuditInput {
  organizationId: string;
  actorType: ActorType;
  actorId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Writes an audit row. Pass the transaction client when the audit must commit
 * atomically with the state change it describes (CLAUDE.md: important state
 * transitions must be audited).
 */
export async function recordAudit(db: PrismaLike, input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// API: read
// ---------------------------------------------------------------------------

const auditLogViewSelect = {
  id: true,
  organizationId: true,
  actorType: true,
  actorId: true,
  action: true,
  entityType: true,
  entityId: true,
  metadata: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;

export type AuditLogView = Prisma.AuditLogGetPayload<{ select: typeof auditLogViewSelect }>;

/**
 * Cursor-paginated, newest-first audit trail for one organization.
 *
 * The `id` tiebreaker is required, not cosmetic: several audits are written
 * inside one transaction (e.g. EXCEPTION_RESOLVED + PAYMENT_APPROVED) and
 * share a `createdAt` down to the millisecond, so ordering on `createdAt`
 * alone could skip or repeat a row across a page boundary landing in a tie.
 */
export async function listAuditLogs(params: {
  organizationId: string;
  action?: AuditAction;
  actorType?: ActorType;
  entityType?: string;
  entityId?: string;
  limit: number;
  cursor?: string;
}): Promise<{ auditLogs: AuditLogView[]; nextCursor: string | null }> {
  const { organizationId, action, actorType, entityType, entityId, limit, cursor } = params;

  const auditLogs = await prisma.auditLog.findMany({
    where: {
      organizationId,
      ...(action ? { action } : {}),
      ...(actorType ? { actorType } : {}),
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
    },
    select: auditLogViewSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row tells us whether another page exists without a second query.
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const page = auditLogs.slice(0, limit);

  return {
    auditLogs: page,
    nextCursor: auditLogs.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
