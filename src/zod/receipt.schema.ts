import { z } from "zod";
import { GoodsReceiptStatus, ShipmentStatus } from "../generated/prisma/enums.js";

export const shipmentIdParamSchema = z.object({
  id: z.string().min(1),
});

export const goodsReceiptIdParamSchema = z.object({
  id: z.string().min(1),
});

export const listShipmentsQuerySchema = z.object({
  status: z.enum(ShipmentStatus).optional(),
  purchaseOrderId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListShipmentsQuery = z.infer<typeof listShipmentsQuerySchema>;

export const listGoodsReceiptsQuerySchema = z.object({
  status: z.enum(GoodsReceiptStatus).optional(),
  purchaseOrderId: z.string().min(1).optional(),
  shipmentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListGoodsReceiptsQuery = z.infer<typeof listGoodsReceiptsQuerySchema>;

/**
 * One physically received purchase-order line. `damagedQuantity` is a subset of
 * `receivedQuantity` — units that arrived but cannot be accepted.
 */
const receiptLineSchema = z.object({
  purchaseOrderItemId: z.string().min(1),
  receivedQuantity: z.number().int().nonnegative(),
  damagedQuantity: z.number().int().nonnegative().default(0),
});

/**
 * Simulated IoT goods receipt.
 *
 * Two shapes, never both: the flat form for the single-line purchase orders the
 * MVP generates, and an explicit `items[]` for a multi-line purchase order — the
 * shape a real IoT integration would post.
 */
export const simulateReceiptSchema = z
  .object({
    shipmentId: z.string().min(1),
    receivedQuantity: z.number().int().nonnegative().optional(),
    damagedQuantity: z.number().int().nonnegative().optional(),
    items: z.array(receiptLineSchema).min(1).optional(),
    receivedBy: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((value) => (value.items === undefined) !== (value.receivedQuantity === undefined), {
    message: "Provide either receivedQuantity (single-line purchase order) or items[], not both",
    path: ["items"],
  })
  .refine((value) => value.items === undefined || value.damagedQuantity === undefined, {
    message: "damagedQuantity belongs on each entry of items[]",
    path: ["damagedQuantity"],
  });

export type SimulateReceiptInput = z.infer<typeof simulateReceiptSchema>;
