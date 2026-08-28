import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/AppError.js";
import type { ListProductsQuery, ListSuppliersQuery } from "../zod/supplier.schema.js";
import { getSupplierScorecards } from "./analytics.service.js";

/**
 * Read-only access to the enterprise catalog that sourcing ranks against.
 *
 * Nothing here mutates: supplier and product rows are reference data seeded
 * into the organization, and the only writer is recordGoodsReceipt maintaining
 * the OTIF counters. An endpoint that could edit a supplier's price or stock
 * would change what the next requisition buys, with no audit trail behind it.
 */

const supplierSelect = {
  id: true,
  organizationId: true,
  name: true,
  email: true,
  phone: true,
  rating: true,
  reliabilityScore: true,
  baselineReliability: true,
  isActive: true,
  totalDeliveries: true,
  onTimeDeliveries: true,
  inFullDeliveries: true,
  orderedUnits: true,
  acceptedUnits: true,
  damagedUnits: true,
  avgLeadTimeDays: true,
  lastDeliveryAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SupplierSelect;

const offerSelect = {
  id: true,
  unitPricePaise: true,
  currency: true,
  stockQuantity: true,
  deliveryDays: true,
  minOrderQuantity: true,
  updatedAt: true,
} satisfies Prisma.SupplierProductSelect;

const productSelect = {
  id: true,
  organizationId: true,
  sku: true,
  name: true,
  category: true,
  description: true,
  unit: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

export async function listSuppliers(params: { organizationId: string; query: ListSuppliersQuery }) {
  const { organizationId, query } = params;

  const suppliers = await prisma.supplier.findMany({
    where: {
      organizationId,
      ...(query.q ? { name: { contains: query.q, mode: "insensitive" as const } } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.minRating === undefined ? {} : { rating: { gte: query.minRating } }),
    },
    select: { ...supplierSelect, _count: { select: { supplierProducts: true } } },
    // Name is unique per organization, so it alone is a stable page boundary —
    // but id is carried anyway so the cursor stays valid if a supplier is
    // renamed between pages.
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const page = suppliers.slice(0, query.limit);

  return {
    suppliers: page,
    nextCursor: suppliers.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/**
 * A supplier plus the scorecard that explains its sourcing rank.
 *
 * The scorecard is reused from analytics rather than recomputed here: OTIF and
 * the reliability delta are already derived in one place, and a second
 * implementation would be free to disagree with the one the ranking uses.
 */
export async function getSupplierById(params: { organizationId: string; supplierId: string }) {
  const supplier = await prisma.supplier.findFirst({
    where: { id: params.supplierId, organizationId: params.organizationId },
    select: supplierSelect,
  });

  if (!supplier) {
    throw AppError.notFound("Supplier not found");
  }

  const [{ suppliers: scorecards }, offers] = await Promise.all([
    getSupplierScorecards({ organizationId: params.organizationId, query: { limit: 100 } }),
    prisma.supplierProduct.findMany({
      where: { supplierId: supplier.id },
      select: { ...offerSelect, product: { select: productSelect } },
      orderBy: { product: { name: "asc" } },
    }),
  ]);

  return {
    supplier,
    scorecard: scorecards.find((row) => row.supplierId === supplier.id) ?? null,
    products: offers,
  };
}

export async function listSupplierProducts(params: { organizationId: string; supplierId: string }) {
  // Scoped through the supplier so a foreign id is a 404, not an empty list —
  // an empty list reads as "this supplier stocks nothing".
  const supplier = await prisma.supplier.findFirst({
    where: { id: params.supplierId, organizationId: params.organizationId },
    select: { id: true },
  });

  if (!supplier) {
    throw AppError.notFound("Supplier not found");
  }

  const products = await prisma.supplierProduct.findMany({
    where: { supplierId: supplier.id },
    select: { ...offerSelect, product: { select: productSelect } },
    orderBy: { product: { name: "asc" } },
  });

  return { products };
}

export async function listProducts(params: { organizationId: string; query: ListProductsQuery }) {
  const { organizationId, query } = params;

  const products = await prisma.product.findMany({
    where: {
      organizationId,
      ...(query.category ? { category: query.category } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" as const } },
              { sku: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: { ...productSelect, _count: { select: { supplierProducts: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const page = products.slice(0, query.limit);

  return {
    products: page,
    nextCursor: products.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** One product with every supplier offering it, cheapest first — the sourcing view. */
export async function getProductById(params: { organizationId: string; productId: string }) {
  const product = await prisma.product.findFirst({
    where: { id: params.productId, organizationId: params.organizationId },
    select: productSelect,
  });

  if (!product) {
    throw AppError.notFound("Product not found");
  }

  const offers = await prisma.supplierProduct.findMany({
    where: { productId: product.id, supplier: { organizationId: params.organizationId } },
    select: { ...offerSelect, supplier: { select: supplierSelect } },
    orderBy: [{ unitPricePaise: "asc" }, { deliveryDays: "asc" }],
  });

  return { product, offers };
}
