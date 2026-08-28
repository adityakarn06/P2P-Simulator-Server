import type { Request, Response } from "express";
import {
  getProductById,
  getSupplierById,
  listProducts,
  listSupplierProducts,
  listSuppliers,
} from "../services/supplier.service.js";
import { AppError } from "../utils/AppError.js";
import { sendSuccess } from "../utils/response.js";
import {
  listProductsQuerySchema,
  listSuppliersQuerySchema,
  productIdParamSchema,
  supplierIdParamSchema,
} from "../zod/supplier.schema.js";

function requireTenant(req: Request): { organizationId: string } {
  if (!req.auth) {
    throw AppError.unauthorized();
  }
  return { organizationId: req.auth.organizationId };
}

export async function getSuppliers(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listSuppliersQuerySchema.parse(req.query);

  sendSuccess(res, await listSuppliers({ organizationId, query }));
}

export async function getSupplier(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = supplierIdParamSchema.parse(req.params);

  sendSuccess(res, await getSupplierById({ organizationId, supplierId: id }));
}

export async function getSupplierProducts(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = supplierIdParamSchema.parse(req.params);

  sendSuccess(res, await listSupplierProducts({ organizationId, supplierId: id }));
}

export async function getProducts(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const query = listProductsQuerySchema.parse(req.query);

  sendSuccess(res, await listProducts({ organizationId, query }));
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const { organizationId } = requireTenant(req);
  const { id } = productIdParamSchema.parse(req.params);

  sendSuccess(res, await getProductById({ organizationId, productId: id }));
}
