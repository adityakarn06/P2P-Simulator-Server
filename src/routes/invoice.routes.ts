import { Router } from "express";
import {
  getInvoiceById,
  getInvoicePdf,
  getInvoices,
  postInvoice,
} from "../controllers/invoice.controller.js";
import { uploadInvoiceFile } from "../middleware/upload.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const invoiceRouter: Router = Router();

// multipart/form-data: the document as "file", the purchase order as "purchaseOrderId".
invoiceRouter.post("/", uploadInvoiceFile, asyncHandler(postInvoice));
invoiceRouter.get("/", asyncHandler(getInvoices));
invoiceRouter.get("/:id", asyncHandler(getInvoiceById));
invoiceRouter.get("/:id/pdf", asyncHandler(getInvoicePdf));
