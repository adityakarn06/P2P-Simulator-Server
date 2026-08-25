import { Router } from "express";
import {
  getPurchaseOrderById,
  getPurchaseOrderPdf,
  getPurchaseOrders,
  postGenerateInvoice,
  postPurchaseOrderApproval,
  postPurchaseOrderRejection,
} from "../controllers/purchaseOrder.controller.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const purchaseOrderRouter: Router = Router();

purchaseOrderRouter.get("/", asyncHandler(getPurchaseOrders));
purchaseOrderRouter.get("/:id", asyncHandler(getPurchaseOrderById));
purchaseOrderRouter.get("/:id/pdf", asyncHandler(getPurchaseOrderPdf));
// Explicit transitions only — there is deliberately no generic status endpoint.
purchaseOrderRouter.post("/:id/approve", asyncHandler(postPurchaseOrderApproval));
purchaseOrderRouter.post("/:id/reject", asyncHandler(postPurchaseOrderRejection));
purchaseOrderRouter.post("/:id/generate-invoice", asyncHandler(postGenerateInvoice));
