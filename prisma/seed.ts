import { prisma } from "../src/config/prisma.js";

// Demo catalog for the P2P MVP. Deterministic ids + upsert so this is safe to
// re-run (`pnpm run prisma:seed`) without producing duplicates.
//
// The organization id below MUST match DEV_ORGANIZATION_ID (src/config/env.ts,
// src/middleware/auth.ts) since there is no real authentication yet.

const ORG_ID = "dev-org";

const SUPPLIERS = {
  techsource: {
    id: "sup-techsource",
    name: "TechSource Distributors",
    email: "sales@techsource.example",
    rating: 4.6,
    reliabilityScore: 0.95,
  },
  globalOffice: {
    id: "sup-global-office",
    name: "Global Office Supplies",
    email: "orders@globaloffice.example",
    rating: 4.2,
    reliabilityScore: 0.88,
  },
  budgetBulk: {
    id: "sup-budget-bulk",
    name: "BudgetBulk Traders",
    email: "hello@budgetbulk.example",
    rating: 3.6,
    reliabilityScore: 0.72,
  },
} as const;

const PRODUCTS = [
  { id: "prod-wireless-keyboard", sku: "PRPH-KB-001", name: "Wireless Keyboard", category: "PERIPHERALS" },
  { id: "prod-wireless-mouse", sku: "PRPH-MS-001", name: "Wireless Mouse", category: "PERIPHERALS" },
  { id: "prod-hd-webcam", sku: "PRPH-WC-001", name: "HD Webcam", category: "PERIPHERALS" },
  { id: "prod-headset", sku: "PRPH-HS-001", name: "USB Headset", category: "PERIPHERALS" },
  { id: "prod-laptop-14", sku: "CMPT-LT-001", name: '14" Laptop', category: "COMPUTING" },
  { id: "prod-monitor-24", sku: "CMPT-MN-001", name: '24" Monitor', category: "COMPUTING" },
  { id: "prod-usbc-dock", sku: "CMPT-DK-001", name: "USB-C Docking Station", category: "COMPUTING" },
  { id: "prod-ssd-1tb", sku: "CMPT-SSD-001", name: "1TB External SSD", category: "COMPUTING" },
  { id: "prod-projector", sku: "CMPT-PJ-001", name: "HD Projector", category: "COMPUTING" },
  { id: "prod-office-chair", sku: "FURN-CH-001", name: "Ergonomic Office Chair", category: "FURNITURE" },
  { id: "prod-standing-desk", sku: "FURN-DK-001", name: "Standing Desk", category: "FURNITURE" },
  { id: "prod-a4-paper", sku: "STNY-PP-001", name: "A4 Paper Ream", category: "STATIONERY" },
  { id: "prod-printer-toner", sku: "STNY-TN-001", name: "Printer Toner Cartridge", category: "STATIONERY" },
  { id: "prod-ethernet-cable", sku: "NETW-CB-001", name: "Ethernet Cable (5m)", category: "NETWORKING" },
  { id: "prod-ups-600va", sku: "NETW-UPS-001", name: "600VA UPS", category: "NETWORKING" },
] as const;

type SupplierProductSeed = {
  id: string;
  supplierId: string;
  productId: string;
  unitPricePaise: number;
  stockQuantity: number;
  deliveryDays: number;
  minOrderQuantity?: number;
};

// Offers are annotated with which demo scenario they support:
//   [SUCCESS]           happy-path procurement (eligible, cheapest wins)
//   [QTY MISMATCH]      demo under-delivers on receipt
//   [PRICE MISMATCH]    demo invoice inflates the unit price
//   [NO SUPPLIER FOUND] every offer fails eligibility (out of stock / too expensive)
const SUPPLIER_PRODUCTS: SupplierProductSeed[] = [
  // --- Wireless Keyboard — [SUCCESS] -----------------------------------
  // "100 wireless keyboards under ₹2000 each within 7 days"
  // TechSource is eligible and cheapest -> wins deterministic ranking.
  {
    id: "sp-keyboard-techsource",
    supplierId: SUPPLIERS.techsource.id,
    productId: "prod-wireless-keyboard",
    unitPricePaise: 182_000, // ₹1,820
    stockQuantity: 500,
    deliveryDays: 5,
  },
  {
    id: "sp-keyboard-global",
    supplierId: SUPPLIERS.globalOffice.id,
    productId: "prod-wireless-keyboard",
    unitPricePaise: 195_000, // ₹1,950
    stockQuantity: 300,
    deliveryDays: 8, // fails delivery deadline
  },
  {
    id: "sp-keyboard-budget",
    supplierId: SUPPLIERS.budgetBulk.id,
    productId: "prod-wireless-keyboard",
    unitPricePaise: 170_000, // ₹1,700 — cheapest, but ineligible on stock
    stockQuantity: 40,
    deliveryDays: 4,
  },

  // --- Wireless Mouse — [QTY MISMATCH] ---------------------------------
  // Demo orders 100; receipt simulates 98 received / 2 damaged.
  {
    id: "sp-mouse-techsource",
    supplierId: SUPPLIERS.techsource.id,
    productId: "prod-wireless-mouse",
    unitPricePaise: 45_000, // ₹450
    stockQuantity: 120,
    deliveryDays: 4,
  },
  {
    id: "sp-mouse-global",
    supplierId: SUPPLIERS.globalOffice.id,
    productId: "prod-wireless-mouse",
    unitPricePaise: 48_000,
    stockQuantity: 200,
    deliveryDays: 6,
  },

  // --- 24" Monitor — [PRICE MISMATCH] -----------------------------------
  // Winning price ₹8,400; demo invoice inflates to ₹9,700 for an obvious variance.
  {
    id: "sp-monitor-techsource",
    supplierId: SUPPLIERS.techsource.id,
    productId: "prod-monitor-24",
    unitPricePaise: 840_000, // ₹8,400
    stockQuantity: 80,
    deliveryDays: 6,
  },
  {
    id: "sp-monitor-global",
    supplierId: SUPPLIERS.globalOffice.id,
    productId: "prod-monitor-24",
    unitPricePaise: 899_000,
    stockQuantity: 60,
    deliveryDays: 5,
  },

  // --- HD Projector — [NO SUPPLIER FOUND] --------------------------------
  // Every offer is either out of stock or too expensive.
  {
    id: "sp-projector-techsource",
    supplierId: SUPPLIERS.techsource.id,
    productId: "prod-projector",
    unitPricePaise: 4_500_000, // ₹45,000 — over typical budget ceilings
    stockQuantity: 3,
    deliveryDays: 10,
  },
  {
    id: "sp-projector-global",
    supplierId: SUPPLIERS.globalOffice.id,
    productId: "prod-projector",
    unitPricePaise: 3_900_000,
    stockQuantity: 0, // out of stock
    deliveryDays: 12,
  },

  // --- Remaining catalog: general-purpose offers across all 3 suppliers ---
  { id: "sp-webcam-techsource", supplierId: SUPPLIERS.techsource.id, productId: "prod-hd-webcam", unitPricePaise: 320_000, stockQuantity: 150, deliveryDays: 4 },
  { id: "sp-webcam-global", supplierId: SUPPLIERS.globalOffice.id, productId: "prod-hd-webcam", unitPricePaise: 350_000, stockQuantity: 90, deliveryDays: 5 },

  { id: "sp-headset-budget", supplierId: SUPPLIERS.budgetBulk.id, productId: "prod-headset", unitPricePaise: 120_000, stockQuantity: 250, deliveryDays: 3 },
  { id: "sp-headset-techsource", supplierId: SUPPLIERS.techsource.id, productId: "prod-headset", unitPricePaise: 135_000, stockQuantity: 180, deliveryDays: 4 },

  { id: "sp-laptop-techsource", supplierId: SUPPLIERS.techsource.id, productId: "prod-laptop-14", unitPricePaise: 3_800_000, stockQuantity: 50, deliveryDays: 7 },
  { id: "sp-laptop-global", supplierId: SUPPLIERS.globalOffice.id, productId: "prod-laptop-14", unitPricePaise: 3_950_000, stockQuantity: 35, deliveryDays: 6 },

  { id: "sp-dock-techsource", supplierId: SUPPLIERS.techsource.id, productId: "prod-usbc-dock", unitPricePaise: 280_000, stockQuantity: 100, deliveryDays: 5 },

  { id: "sp-ssd-techsource", supplierId: SUPPLIERS.techsource.id, productId: "prod-ssd-1tb", unitPricePaise: 550_000, stockQuantity: 75, deliveryDays: 5 },
  { id: "sp-ssd-budget", supplierId: SUPPLIERS.budgetBulk.id, productId: "prod-ssd-1tb", unitPricePaise: 480_000, stockQuantity: 60, deliveryDays: 6 },

  { id: "sp-chair-globaloffice", supplierId: SUPPLIERS.globalOffice.id, productId: "prod-office-chair", unitPricePaise: 650_000, stockQuantity: 40, deliveryDays: 9 },
  { id: "sp-chair-budget", supplierId: SUPPLIERS.budgetBulk.id, productId: "prod-office-chair", unitPricePaise: 520_000, stockQuantity: 30, deliveryDays: 12 },

  { id: "sp-desk-globaloffice", supplierId: SUPPLIERS.globalOffice.id, productId: "prod-standing-desk", unitPricePaise: 1_800_000, stockQuantity: 20, deliveryDays: 10 },

  { id: "sp-paper-budget", supplierId: SUPPLIERS.budgetBulk.id, productId: "prod-a4-paper", unitPricePaise: 24_000, stockQuantity: 1000, deliveryDays: 2, minOrderQuantity: 5 },
  { id: "sp-paper-globaloffice", supplierId: SUPPLIERS.globalOffice.id, productId: "prod-a4-paper", unitPricePaise: 26_000, stockQuantity: 800, deliveryDays: 3 },

  { id: "sp-toner-globaloffice", supplierId: SUPPLIERS.globalOffice.id, productId: "prod-printer-toner", unitPricePaise: 180_000, stockQuantity: 120, deliveryDays: 3 },
  { id: "sp-toner-budget", supplierId: SUPPLIERS.budgetBulk.id, productId: "prod-printer-toner", unitPricePaise: 160_000, stockQuantity: 90, deliveryDays: 4 },

  { id: "sp-ethernet-techsource", supplierId: SUPPLIERS.techsource.id, productId: "prod-ethernet-cable", unitPricePaise: 35_000, stockQuantity: 400, deliveryDays: 3 },
  { id: "sp-ethernet-budget", supplierId: SUPPLIERS.budgetBulk.id, productId: "prod-ethernet-cable", unitPricePaise: 28_000, stockQuantity: 500, deliveryDays: 4 },

  { id: "sp-ups-techsource", supplierId: SUPPLIERS.techsource.id, productId: "prod-ups-600va", unitPricePaise: 420_000, stockQuantity: 65, deliveryDays: 6 },
];

async function main(): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: {
      id: ORG_ID,
      name: "Demo Manufacturing Pvt Ltd",
      currency: "INR",
    },
  });

  for (const supplier of Object.values(SUPPLIERS)) {
    await prisma.supplier.upsert({
      where: { id: supplier.id },
      // Re-seeding resets the whole performance record, not just the score:
      // leaving stale counters behind would make a re-seeded supplier look
      // like it had a delivery history it no longer has, and the shrinkage
      // prior in src/rules/supplierPerformance.ts would weight it accordingly.
      update: {
        name: supplier.name,
        email: supplier.email,
        rating: supplier.rating,
        reliabilityScore: supplier.reliabilityScore,
        baselineReliability: supplier.reliabilityScore,
        totalDeliveries: 0,
        onTimeDeliveries: 0,
        inFullDeliveries: 0,
        orderedUnits: 0,
        acceptedUnits: 0,
        damagedUnits: 0,
        avgLeadTimeDays: null,
        lastDeliveryAt: null,
      },
      create: {
        id: supplier.id,
        organizationId: organization.id,
        name: supplier.name,
        email: supplier.email,
        rating: supplier.rating,
        reliabilityScore: supplier.reliabilityScore,
        baselineReliability: supplier.reliabilityScore,
      },
    });
  }

  for (const product of PRODUCTS) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: {
        name: product.name,
        category: product.category,
      },
      create: {
        id: product.id,
        organizationId: organization.id,
        sku: product.sku,
        name: product.name,
        category: product.category,
      },
    });
  }

  for (const offer of SUPPLIER_PRODUCTS) {
    await prisma.supplierProduct.upsert({
      where: { id: offer.id },
      update: {
        unitPricePaise: offer.unitPricePaise,
        stockQuantity: offer.stockQuantity,
        deliveryDays: offer.deliveryDays,
        minOrderQuantity: offer.minOrderQuantity ?? 1,
      },
      create: {
        id: offer.id,
        supplierId: offer.supplierId,
        productId: offer.productId,
        unitPricePaise: offer.unitPricePaise,
        stockQuantity: offer.stockQuantity,
        deliveryDays: offer.deliveryDays,
        minOrderQuantity: offer.minOrderQuantity ?? 1,
      },
    });
  }

  console.log(
    `Seeded organization "${organization.name}" (${organization.id}) with ` +
      `${Object.keys(SUPPLIERS).length} suppliers, ${PRODUCTS.length} products, ` +
      `${SUPPLIER_PRODUCTS.length} supplier-product offers.`,
  );
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
