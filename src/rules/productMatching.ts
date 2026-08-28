/**
 * Deterministic product matching. Pure functions, no I/O — `Requirement.productName`
 * is free text the user typed ("100 wireless keyboards"), while the catalog holds
 * canonical names ("Wireless Keyboard"). Bridging the two is a lookup, not a
 * judgement call, so Gemini is never involved (CLAUDE.md: "AI interprets.
 * Deterministic code decides.").
 */

/** Minimum blended coverage a product must reach to be considered a match. */
export const PRODUCT_MATCH_THRESHOLD = 0.6;

/**
 * How much each direction of coverage counts. Query coverage dominates ("did we
 * account for everything the user asked for?"), but product coverage still
 * matters so that "keyboard" prefers "Wireless Keyboard" over a hypothetical
 * "Wireless Keyboard And Mouse Combo Bundle".
 */
const QUERY_COVERAGE_WEIGHT = 0.7;
const PRODUCT_COVERAGE_WEIGHT = 0.3;

/** Words that carry no product identity. Quantities and units are already extracted elsewhere. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "with",
  "and",
  "or",
  "in",
  "per",
  "each",
  "unit",
  "units",
  "piece",
  "pieces",
  "pcs",
  "nos",
]);

/** Tokens this short are acronyms or sizes ("hd", "ups", "a4"), never plurals. */
const MIN_SINGULARIZE_LENGTH = 4;

export interface ProductLike {
  id: string;
  sku: string;
  name: string;
  category: string;
}

/**
 * AMBIGUOUS is deliberately distinct from NO_MATCH. "wireless" scores identically
 * against Wireless Keyboard and Wireless Mouse; picking one by SKU order would be
 * a silent coin-flip on what the organization actually buys, so the caller is
 * told to ask instead.
 */
export type ProductMatchResult =
  | { status: "MATCHED"; product: ProductLike; score: number }
  | { status: "NO_MATCH" }
  | { status: "AMBIGUOUS"; candidates: ProductLike[] };

/**
 * Naive English singularization. Deliberately not a stemmer — the catalog is
 * short product nouns, and an aggressive stemmer would collide unrelated items.
 */
function singularize(token: string): string {
  if (token.length < MIN_SINGULARIZE_LENGTH || !token.endsWith("s")) {
    return token;
  }
  if (token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (/(?:x|s|z|ch|sh)es$/.test(token)) {
    return token.slice(0, -2);
  }
  // "wireless" must survive intact.
  if (token.endsWith("ss")) {
    return token;
  }
  return token.slice(0, -1);
}

/** Lowercases, strips punctuation, drops stopwords, and singularizes. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    .map(singularize);
}

/** Punctuation-insensitive SKU comparison, so "prph-kb-001" matches "PRPH KB 001". */
function normalizeSku(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Shortest normalized SKU allowed to be recognised inside a longer string.
 *
 * A whole-string SKU equality check is safe at any length, but finding a SKU
 * *within* free text needs the identifier to be distinctive enough that the hit
 * cannot be a coincidence. A three-character SKU like "KB1" would collide with
 * ordinary wording; "prphkb001" cannot.
 */
const MIN_EMBEDDED_SKU_LENGTH = 6;

/**
 * True when `text` names this SKU — either it *is* the SKU, or it quotes the SKU
 * alongside other wording.
 *
 * The embedded case is what makes a printed invoice line resolvable. Purchase
 * order lines are described as "Wireless Keyboard (PRPH-KB-001)" — name plus
 * SKU — and that is exactly what a supplier prints and what
 * generateInvoiceForPurchaseOrder renders. Scored on name tokens alone, the SKU
 * is three extra tokens the catalog name does not have, so it *lowers* the
 * score: "Wireless Keyboard (PRPH-KB-001)" scores 0.58 against the product
 * "Wireless Keyboard" and falls under the 0.6 threshold, while the bare name
 * scores 1.0. Quoting the unique identifier must never make a line harder to
 * identify, so a SKU found in the text is treated as the identifier it is.
 */
function namesSku(normalizedText: string, sku: string): boolean {
  const normalizedSku = normalizeSku(sku);

  if (normalizedSku.length === 0) {
    return false;
  }

  if (normalizedText === normalizedSku) {
    return true;
  }

  return normalizedSku.length >= MIN_EMBEDDED_SKU_LENGTH && normalizedText.includes(normalizedSku);
}

/**
 * Blended two-way token coverage in [0, 1]. Penalises both an under-specific
 * match (the query asked for things the product does not have) and an
 * over-broad one (the product is mostly words the query never mentioned).
 */
export function scoreProductName(queryTokens: string[], productName: string): number {
  const productTokens = tokenize(productName);

  if (queryTokens.length === 0 || productTokens.length === 0) {
    return 0;
  }

  const productSet = new Set(productTokens);
  const querySet = new Set(queryTokens);

  const matchedQuery = [...querySet].filter((token) => productSet.has(token)).length;
  const matchedProduct = [...productSet].filter((token) => querySet.has(token)).length;

  return (
    QUERY_COVERAGE_WEIGHT * (matchedQuery / querySet.size) +
    PRODUCT_COVERAGE_WEIGHT * (matchedProduct / productSet.size)
  );
}

/**
 * Resolves free-text requirement wording to a single catalog product.
 *
 * At most one product is returned so that downstream sourcing can never produce
 * two candidate rows for the same supplier (`SupplierCandidate` is unique on
 * [requisitionId, supplierId]). Anything short of a confident, unique winner is
 * reported rather than guessed — the caller turns it into an exception.
 *
 * `category` is a tie-breaker only, never a filter: the requisition worker does
 * not currently populate `Requirement.category`, so filtering on it would
 * discard the whole catalog.
 */
export function findBestProduct(
  productName: string,
  category: string | null,
  products: ProductLike[],
): ProductMatchResult {
  const queryTokens = tokenize(productName);
  if (queryTokens.length === 0) {
    return { status: "NO_MATCH" };
  }

  const skuQuery = normalizeSku(productName);
  const normalizedCategory = category?.trim().toLowerCase() ?? null;

  const scored = products.map((product) => ({
    product,
    // A SKU is an unambiguous identifier — it outranks any name overlap.
    score: namesSku(skuQuery, product.sku) ? 1 : scoreProductName(queryTokens, product.name),
    categoryMatch:
      normalizedCategory !== null && product.category.toLowerCase() === normalizedCategory,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.categoryMatch !== b.categoryMatch) {
      return a.categoryMatch ? -1 : 1;
    }
    // Final tie-break so the same catalog always yields the same answer.
    return a.product.sku.localeCompare(b.product.sku);
  });

  const best = scored[0];
  if (!best || best.score < PRODUCT_MATCH_THRESHOLD) {
    return { status: "NO_MATCH" };
  }

  // A runner-up that neither score nor category could separate means the
  // wording genuinely does not identify one product. Refuse rather than let the
  // SKU tie-break decide what gets purchased.
  const tied = scored.filter(
    (entry) => entry.score === best.score && entry.categoryMatch === best.categoryMatch,
  );
  if (tied.length > 1) {
    return { status: "AMBIGUOUS", candidates: tied.map((entry) => entry.product) };
  }

  return { status: "MATCHED", product: best.product, score: best.score };
}
