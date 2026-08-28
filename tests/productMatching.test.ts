import { describe, expect, it } from "vitest";
import {
  findBestProduct,
  PRODUCT_MATCH_THRESHOLD,
  type ProductLike,
  scoreProductName,
  tokenize,
} from "../src/rules/productMatching.js";

// The real seeded catalog (prisma/seed.ts) — matching must work against the
// exact data the demo runs on, not a simplified stand-in.
const CATALOG: ProductLike[] = [
  {
    id: "prod-wireless-keyboard",
    sku: "PRPH-KB-001",
    name: "Wireless Keyboard",
    category: "PERIPHERALS",
  },
  {
    id: "prod-wireless-mouse",
    sku: "PRPH-MS-001",
    name: "Wireless Mouse",
    category: "PERIPHERALS",
  },
  { id: "prod-hd-webcam", sku: "PRPH-WC-001", name: "HD Webcam", category: "PERIPHERALS" },
  { id: "prod-headset", sku: "PRPH-HS-001", name: "USB Headset", category: "PERIPHERALS" },
  { id: "prod-laptop-14", sku: "CMPT-LT-001", name: '14" Laptop', category: "COMPUTING" },
  { id: "prod-monitor-24", sku: "CMPT-MN-001", name: '24" Monitor', category: "COMPUTING" },
  {
    id: "prod-usbc-dock",
    sku: "CMPT-DK-001",
    name: "USB-C Docking Station",
    category: "COMPUTING",
  },
  { id: "prod-ssd-1tb", sku: "CMPT-SSD-001", name: "1TB External SSD", category: "COMPUTING" },
  { id: "prod-projector", sku: "CMPT-PJ-001", name: "HD Projector", category: "COMPUTING" },
  {
    id: "prod-office-chair",
    sku: "FURN-CH-001",
    name: "Ergonomic Office Chair",
    category: "FURNITURE",
  },
  { id: "prod-standing-desk", sku: "FURN-DK-001", name: "Standing Desk", category: "FURNITURE" },
  { id: "prod-a4-paper", sku: "STNY-PP-001", name: "A4 Paper Ream", category: "STATIONERY" },
  {
    id: "prod-printer-toner",
    sku: "STNY-TN-001",
    name: "Printer Toner Cartridge",
    category: "STATIONERY",
  },
  {
    id: "prod-ethernet-cable",
    sku: "NETW-CB-001",
    name: "Ethernet Cable (5m)",
    category: "NETWORKING",
  },
  { id: "prod-ups-600va", sku: "NETW-UPS-001", name: "600VA UPS", category: "NETWORKING" },
];

describe("tokenize", () => {
  it("lowercases, strips punctuation and drops stopwords", () => {
    expect(tokenize('24" Monitor')).toEqual(["24", "monitor"]);
    expect(tokenize("USB-C Docking Station")).toEqual(["usb", "c", "docking", "station"]);
    expect(tokenize("100 units of A4 paper")).toEqual(["100", "a4", "paper"]);
  });

  it("singularizes plurals without mangling short or -ss words", () => {
    expect(tokenize("keyboards")).toEqual(["keyboard"]);
    expect(tokenize("cartridges")).toEqual(["cartridge"]);
    expect(tokenize("batteries")).toEqual(["battery"]);
    expect(tokenize("boxes")).toEqual(["box"]);
    // "wireless" must survive; "ups" and "hd" are acronyms, not plurals.
    expect(tokenize("wireless UPS HD")).toEqual(["wireless", "ups", "hd"]);
  });

  it("returns nothing for input made only of stopwords or punctuation", () => {
    expect(tokenize("the units of")).toEqual([]);
    expect(tokenize("!!! ---")).toEqual([]);
  });
});

describe("scoreProductName", () => {
  it("scores an exact token set as a perfect match", () => {
    expect(scoreProductName(tokenize("wireless keyboards"), "Wireless Keyboard")).toBe(1);
  });

  it("keeps a half-overlapping sibling product below the threshold", () => {
    // "Wireless Mouse" shares only "wireless" — 0.7*0.5 + 0.3*0.5 = 0.5.
    const score = scoreProductName(tokenize("wireless keyboards"), "Wireless Mouse");
    expect(score).toBeCloseTo(0.5, 10);
    expect(score).toBeLessThan(PRODUCT_MATCH_THRESHOLD);
  });

  it("scores an unrelated product at zero", () => {
    expect(scoreProductName(tokenize("wireless keyboards"), "HD Projector")).toBe(0);
  });

  it("rewards a narrower product over a broader one for the same query", () => {
    const narrow = scoreProductName(tokenize("keyboard"), "Wireless Keyboard");
    const broad = scoreProductName(tokenize("keyboard"), "Wireless Keyboard And Mouse Combo Kit");
    expect(narrow).toBeGreaterThan(broad);
  });
});

/** Narrows to the matched product id, failing loudly on NO_MATCH/AMBIGUOUS. */
function matchedId(result: ReturnType<typeof findBestProduct>): string {
  if (result.status !== "MATCHED") {
    throw new Error(`expected a match, got ${result.status}`);
  }
  return result.product.id;
}

describe("findBestProduct", () => {
  it("matches the plural free-text wording from the demo requisition", () => {
    const match = findBestProduct("wireless keyboards", null, CATALOG);
    expect(match).toMatchObject({ status: "MATCHED", score: 1 });
    expect(matchedId(match)).toBe("prod-wireless-keyboard");
  });

  it("matches a bare noun", () => {
    expect(matchedId(findBestProduct("keyboard", null, CATALOG))).toBe("prod-wireless-keyboard");
    expect(matchedId(findBestProduct("chairs", null, CATALOG))).toBe("prod-office-chair");
    expect(matchedId(findBestProduct("projector", null, CATALOG))).toBe("prod-projector");
  });

  it("ignores quantities, stopwords and punctuation in the wording", () => {
    expect(matchedId(findBestProduct("100 units of A4 paper", null, CATALOG))).toBe(
      "prod-a4-paper",
    );
    expect(matchedId(findBestProduct('24" monitors', null, CATALOG))).toBe("prod-monitor-24");
  });

  it("treats an exact SKU as an unambiguous identifier", () => {
    const match = findBestProduct("PRPH-KB-001", null, CATALOG);
    expect(match).toMatchObject({ status: "MATCHED", score: 1 });
    expect(matchedId(match)).toBe("prod-wireless-keyboard");
  });

  it("never confuses two products sharing a qualifier", () => {
    expect(matchedId(findBestProduct("wireless mouse", null, CATALOG))).toBe("prod-wireless-mouse");
    expect(matchedId(findBestProduct("hd webcam", null, CATALOG))).toBe("prod-hd-webcam");
    expect(matchedId(findBestProduct("hd projector", null, CATALOG))).toBe("prod-projector");
  });

  it("reports NO_MATCH rather than guessing when nothing clears the threshold", () => {
    expect(findBestProduct("industrial forklift", null, CATALOG).status).toBe("NO_MATCH");
    expect(findBestProduct("qwertyuiop", null, CATALOG).status).toBe("NO_MATCH");
  });

  it("refuses to coin-flip between products a shared qualifier cannot separate", () => {
    // "wireless" scores 0.85 against both the keyboard and the mouse. Letting
    // the SKU tie-break decide would silently buy the wrong product.
    const result = findBestProduct("wireless", null, CATALOG);
    expect(result.status).toBe("AMBIGUOUS");
    if (result.status !== "AMBIGUOUS") throw new Error("unreachable");
    expect(result.candidates.map((p) => p.id).sort()).toEqual([
      "prod-wireless-keyboard",
      "prod-wireless-mouse",
    ]);
  });

  it("reports NO_MATCH for empty or stopword-only wording", () => {
    expect(findBestProduct("", null, CATALOG).status).toBe("NO_MATCH");
    expect(findBestProduct("   ", null, CATALOG).status).toBe("NO_MATCH");
    expect(findBestProduct("the units of", null, CATALOG).status).toBe("NO_MATCH");
  });

  it("reports NO_MATCH for an empty catalog", () => {
    expect(findBestProduct("wireless keyboards", null, []).status).toBe("NO_MATCH");
  });

  it("uses category to break a tie, never to filter", () => {
    const tied: ProductLike[] = [
      { id: "b", sku: "B-1", name: "Widget", category: "FURNITURE" },
      { id: "a", sku: "A-1", name: "Widget", category: "COMPUTING" },
    ];

    // Both score identically; the category resolves it.
    expect(matchedId(findBestProduct("widget", "FURNITURE", tied))).toBe("b");
    expect(matchedId(findBestProduct("widget", "COMPUTING", tied))).toBe("a");
    // With no category — or one that matches neither — nothing separates them.
    expect(findBestProduct("widget", null, tied).status).toBe("AMBIGUOUS");
    expect(findBestProduct("widget", "STATIONERY", tied).status).toBe("AMBIGUOUS");
  });

  it("is deterministic regardless of catalog order", () => {
    const reversed = [...CATALOG].reverse();
    for (const query of ["wireless keyboards", "a4 paper", "24 inch monitor", "office chair"]) {
      expect(findBestProduct(query, null, reversed)).toEqual(findBestProduct(query, null, CATALOG));
    }
  });
});

/**
 * Purchase-order lines are described as "<name> (<sku>)", and that is what a
 * supplier prints and what generateInvoiceForPurchaseOrder renders. Three-way
 * matching resolves those printed lines back to a product with this same
 * function, so a line quoting the SKU must never be harder to identify than the
 * bare name.
 */
describe("findBestProduct — a description that quotes the SKU", () => {
  const catalog = [
    { id: "p1", sku: "PRPH-KB-001", name: "Wireless Keyboard", category: "Peripherals" },
    { id: "p2", sku: "PRPH-MS-002", name: "Wireless Mouse", category: "Peripherals" },
  ];

  it("resolves a purchase-order line description", () => {
    const result = findBestProduct("Wireless Keyboard (PRPH-KB-001)", null, catalog);

    expect(result).toMatchObject({ status: "MATCHED", product: { id: "p1" } });
  });

  it("lets the SKU decide when the name alone would be ambiguous", () => {
    // "Wireless" scores identically against both products; the SKU does not.
    const result = findBestProduct("Wireless (PRPH-MS-002)", null, catalog);

    expect(result).toMatchObject({ status: "MATCHED", product: { id: "p2" } });
  });

  it("accepts the SKU in any punctuation form", () => {
    for (const text of ["PRPH KB 001", "prph-kb-001", "Item prph_kb_001 shipped"]) {
      expect(findBestProduct(text, null, catalog)).toMatchObject({
        status: "MATCHED",
        product: { id: "p1" },
      });
    }
  });

  it("does not let a short SKU match by coincidence inside other wording", () => {
    const shortSku = [{ id: "p3", sku: "KB1", name: "Keyboard Tray", category: "Furniture" }];

    // "kb1" appears inside the normalized text, but a three-character SKU is
    // not distinctive enough to be treated as an identifier.
    expect(findBestProduct("Backup Battery KB1000 Rack", null, shortSku)).toMatchObject({
      status: "NO_MATCH",
    });
  });
});
