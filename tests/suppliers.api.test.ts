import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";

const db = {
  organization: { findUnique: vi.fn() },
  supplier: { findMany: vi.fn(), findFirst: vi.fn() },
  supplierProduct: { findMany: vi.fn() },
  product: { findMany: vi.fn(), findFirst: vi.fn() },
  purchaseOrder: { groupBy: vi.fn() },
};

vi.mock("../src/config/prisma.js", () => ({
  prisma: db,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../src/config/redis.js", () => ({
  redis: { ping: vi.fn() },
  createRedisConnection: vi.fn(),
}));

const { createApp } = await import("../src/app.js");
const request = (await import("supertest")).default;

const app = createApp();
const ORG = "dev-org";

const get = (path: string) => request(app).get(path).set("x-organization-id", ORG);

function buildSupplier(overrides: Record<string, unknown> = {}) {
  return {
    id: "sup-1",
    organizationId: ORG,
    name: "Keyboard Co",
    email: "sales@keyboard.example",
    phone: null,
    rating: 4.5,
    reliabilityScore: 0.92,
    baselineReliability: 0.9,
    isActive: true,
    totalDeliveries: 4,
    onTimeDeliveries: 4,
    inFullDeliveries: 3,
    orderedUnits: 400,
    acceptedUnits: 396,
    damagedUnits: 4,
    avgLeadTimeDays: 5.5,
    lastDeliveryAt: new Date("2026-08-25T00:00:00.000Z"),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
    ...overrides,
  };
}

function buildProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod-kb",
    organizationId: ORG,
    sku: "KB-WL-001",
    name: "Wireless Keyboard",
    category: "Peripherals",
    description: null,
    unit: "unit",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: "sp-1",
    unitPricePaise: 182_000,
    currency: "INR",
    stockQuantity: 500,
    deliveryDays: 5,
    minOrderQuantity: 1,
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.organization.findUnique.mockResolvedValue({ id: ORG, currency: "INR" });
  db.supplier.findMany.mockResolvedValue([]);
  db.supplier.findFirst.mockResolvedValue(buildSupplier());
  db.supplierProduct.findMany.mockResolvedValue([]);
  db.product.findMany.mockResolvedValue([]);
  db.product.findFirst.mockResolvedValue(buildProduct());
  db.purchaseOrder.groupBy.mockResolvedValue([]);
});

describe("GET /api/v1/suppliers", () => {
  it("lists the catalog for the caller's organization", async () => {
    db.supplier.findMany.mockResolvedValue([
      { ...buildSupplier(), _count: { supplierProducts: 3 } },
    ]);

    const res = await get("/api/v1/suppliers");

    expect(res.status).toBe(200);
    expect(res.body.data.suppliers[0]).toMatchObject({ id: "sup-1", name: "Keyboard Co" });
    expect(db.supplier.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG },
    });
  });

  it("filters by name, activity and rating", async () => {
    await get("/api/v1/suppliers?q=keyboard&isActive=true&minRating=4");

    expect(db.supplier.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        organizationId: ORG,
        name: { contains: "keyboard", mode: "insensitive" },
        isActive: true,
        rating: { gte: 4 },
      },
    });
  });

  it("paginates with a cursor when another page exists", async () => {
    db.supplier.findMany.mockResolvedValue([
      { ...buildSupplier({ id: "sup-1" }), _count: { supplierProducts: 1 } },
      { ...buildSupplier({ id: "sup-2" }), _count: { supplierProducts: 1 } },
    ]);

    const res = await get("/api/v1/suppliers?limit=1");

    expect(res.body.data.suppliers).toHaveLength(1);
    expect(res.body.data.nextCursor).toBe("sup-1");
  });

  it("rejects a rating outside the 0-5 scale", async () => {
    expect((await get("/api/v1/suppliers?minRating=9")).status).toBe(400);
  });
});

describe("GET /api/v1/suppliers/:id", () => {
  it("returns the supplier with the scorecard that explains its sourcing rank", async () => {
    db.supplier.findMany.mockResolvedValue([buildSupplier()]);
    db.supplierProduct.findMany.mockResolvedValue([{ ...buildOffer(), product: buildProduct() }]);

    const res = await get("/api/v1/suppliers/sup-1");

    expect(res.status).toBe(200);
    expect(res.body.data.supplier.id).toBe("sup-1");
    // Reused from analytics rather than recomputed, so the figure here is the
    // same one supplier ranking uses.
    expect(res.body.data.scorecard).toMatchObject({ supplierId: "sup-1" });
    expect(res.body.data.products).toHaveLength(1);
  });

  it("treats a supplier in another organization as missing", async () => {
    db.supplier.findFirst.mockResolvedValue(null);

    const res = await get("/api/v1/suppliers/sup-elsewhere");

    expect(res.status).toBe(404);
    expect(db.supplier.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "sup-elsewhere", organizationId: ORG },
    });
  });
});

describe("GET /api/v1/suppliers/:id/products", () => {
  it("returns the offers the sourcing worker ranks", async () => {
    db.supplierProduct.findMany.mockResolvedValue([{ ...buildOffer(), product: buildProduct() }]);

    const res = await get("/api/v1/suppliers/sup-1/products");

    expect(res.status).toBe(200);
    expect(res.body.data.products[0]).toMatchObject({
      unitPricePaise: 182_000,
      stockQuantity: 500,
      deliveryDays: 5,
    });
  });

  it("is a 404 for a foreign supplier, not an empty catalog", async () => {
    // An empty list reads as "this supplier stocks nothing", which is a
    // different and misleading answer.
    db.supplier.findFirst.mockResolvedValue(null);

    expect((await get("/api/v1/suppliers/sup-elsewhere/products")).status).toBe(404);
  });
});

describe("GET /api/v1/products", () => {
  it("searches by name or SKU", async () => {
    await get("/api/v1/products?q=KB-WL");

    expect(db.product.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        organizationId: ORG,
        OR: [
          { name: { contains: "KB-WL", mode: "insensitive" } },
          { sku: { contains: "KB-WL", mode: "insensitive" } },
        ],
      },
    });
  });

  it("returns one product with every offer, cheapest first", async () => {
    db.supplierProduct.findMany.mockResolvedValue([{ ...buildOffer(), supplier: buildSupplier() }]);

    const res = await get("/api/v1/products/prod-kb");

    expect(res.status).toBe(200);
    expect(res.body.data.product.sku).toBe("KB-WL-001");
    expect(res.body.data.offers[0].supplier.name).toBe("Keyboard Co");
    expect(db.supplierProduct.findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: [{ unitPricePaise: "asc" }, { deliveryDays: "asc" }],
    });
  });

  it("treats a product in another organization as missing", async () => {
    db.product.findFirst.mockResolvedValue(null);

    expect((await get("/api/v1/products/prod-elsewhere")).status).toBe(404);
  });
});

describe("catalog API surface", () => {
  it.each([
    ["post", "/api/v1/suppliers"],
    ["patch", "/api/v1/suppliers/sup-1"],
    ["post", "/api/v1/products"],
  ] as const)("refuses to %s — the catalog is reference data", async (method, path) => {
    const res = await request(app)[method](path).set("x-organization-id", ORG);

    expect(res.status).toBe(404);
  });
});
