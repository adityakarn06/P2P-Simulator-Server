import { z } from "zod";

export const supplierIdParamSchema = z.object({ id: z.string().min(1) });
export const productIdParamSchema = z.object({ id: z.string().min(1) });

/**
 * The catalog the sourcing worker ranks against, exposed read-only.
 *
 * `q` is a case-insensitive substring match, not a search engine — the seeded
 * catalog is small, and src/rules/productMatching.ts already owns the only
 * matching that has to be clever (the one that decides what a requisition
 * actually asked for).
 */
export const listSuppliersQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;

export const listProductsQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
