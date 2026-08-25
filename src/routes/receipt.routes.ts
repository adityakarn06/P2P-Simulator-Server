import { Router } from "express";
import {
  getGoodsReceiptPdf,
  getGoodsReceipts,
  postSimulatedReceipt,
} from "../controllers/receipt.controller.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const receiptRouter: Router = Router();

receiptRouter.get("/", asyncHandler(getGoodsReceipts));
receiptRouter.get("/:id/pdf", asyncHandler(getGoodsReceiptPdf));
// Simulated IoT goods receipt — there is deliberately no generic status endpoint.
receiptRouter.post("/simulate", asyncHandler(postSimulatedReceipt));
