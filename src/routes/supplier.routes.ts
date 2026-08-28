import { Router } from "express";
import {
  getProduct,
  getProducts,
  getSupplier,
  getSupplierProducts,
  getSuppliers,
} from "../controllers/supplier.controller.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Read-only. The catalog is reference data the sourcing worker ranks against —
 * a mutable price or stock level here would silently change what the next
 * requisition buys, with nothing in the audit log to explain it.
 */
export const supplierRouter: Router = Router();

supplierRouter.get("/", asyncHandler(getSuppliers));
supplierRouter.get("/:id", asyncHandler(getSupplier));
supplierRouter.get("/:id/products", asyncHandler(getSupplierProducts));

export const productRouter: Router = Router();

productRouter.get("/", asyncHandler(getProducts));
productRouter.get("/:id", asyncHandler(getProduct));
