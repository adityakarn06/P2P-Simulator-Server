import type { JobsOptions } from "bullmq";

// Job payloads must carry IDs only — workers
// re-fetch current state from PostgreSQL rather than trusting queued data.
export const QUEUE_NAMES = {
  REQUISITION: "requisition",
  SUPPLIER_DISCOVERY: "supplier-discovery",
  PURCHASE_ORDER: "purchase-order",
  INVOICE: "invoice",
  MATCHING: "matching",
  PAYMENT: "payment",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// Retry transient technical failures (Gemini timeout, Cloudinary hiccups, Redis/DB blips).
// Business failures (mismatch, duplicate invoice, no eligible supplier) must not be retried, will handle those as terminal state
// transitions inside the processor instead.
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000,
  },
  removeOnComplete: 100,
  removeOnFail: 500,
};

// Supplier ranking weights. Deterministic TypeScript only — never ask Gemini to rank suppliers numerically.
export const SUPPLIER_SCORE_WEIGHTS = {
  PRICE: 0.3,
  DELIVERY: 0.25,
  RELIABILITY: 0.2,
  RATING: 0.15,
  STOCK: 0.1,
} as const;

// GST applied to every purchase order, in basis points (1800 = 18%).
// Deterministic TypeScript owns every money calculation — Gemini never sees one.
export const DEFAULT_TAX_RATE_BPS = 1800;

// MVP demo: every purchase order waits for a human approval, so the thresholds
// below are inert. Flip this to true to let src/rules/approvalRules.ts apply them.
export const PO_AUTO_APPROVE_ENABLED = false;

// PO approval thresholds, in paise.
export const APPROVAL_THRESHOLDS_PAISE = {
  AUTO_APPROVE_BELOW: 100_000_00,
  TRUSTED_SUPPLIER_AUTO_APPROVE_BELOW: 1_000_000_00,
} as const;

/**
 * How long a payment attempt may hold its PROCESSING claim before another
 * attempt is allowed to take it over.
 *
 * A PROCESSING row means "somebody is inside the provider call". Re-claiming it
 * unconditionally lets a concurrent job charge the same invoice twice; never
 * re-claiming it strands the payment forever when a worker is killed mid-charge.
 * The lease resolves both: only a claim older than this is considered abandoned.
 * Comfortably longer than any provider call the worker will make.
 */
export const PAYMENT_CLAIM_LEASE_MS = 120_000;

// Three-way match tolerances.
export const MATCH_TOLERANCES = {
  QUANTITY: 0,
  PRICE_PERCENTAGE: 0.02,
  TAX_PERCENTAGE: 0.01,
  TOTAL_PERCENTAGE: 0.01,
} as const;

/**
 * Supplier delivery-performance scoring (src/rules/supplierPerformance.ts).
 *
 * The three weights sum to 1 and produce the 0-1 reliabilityScore that carries
 * the RELIABILITY weight in SUPPLIER_SCORE_WEIGHTS above — so a supplier's
 * measured behaviour feeds directly back into who wins the next requisition.
 */
export const SUPPLIER_PERFORMANCE = {
  ON_TIME_WEIGHT: 0.5,
  IN_FULL_WEIGHT: 0.3,
  QUALITY_WEIGHT: 0.2,
  /**
   * Shrinkage prior, in pseudo-deliveries. The seeded score counts for this
   * many observations, so one bad delivery moves the score without destroying
   * the supplier and sustained evidence still wins. Five keeps the demo's
   * ranking legible: a single short delivery is visible but not catastrophic.
   */
  PRIOR_WEIGHT: 5,
} as const;

/**
 * Thresholds for the advisory anomaly signals (src/rules/anomalyDetection.ts).
 *
 * These gate *observations*, never decisions: no signal can block a payment or
 * change a match verdict, so a threshold set too loosely costs noise on a
 * dashboard rather than money.
 */
export const ANOMALY_THRESHOLDS = {
  /**
   * A distribution needs enough history to mean anything. Below this many prior
   * observations no outlier signal fires at all — with two samples every third
   * one looks like an outlier.
   */
  MIN_HISTORY: 3,
  /** |z| above which a price or quantity is called an outlier. */
  Z_SCORE: 2,
  /**
   * A σ of zero (every prior identical) makes a z-score infinite, so identical
   * history falls back to a relative-deviation test at this ratio instead.
   */
  FLAT_HISTORY_DEVIATION: 0.15,
  /** A first-ever order with a supplier above this is worth a second look. */
  NEW_SUPPLIER_VALUE_PAISE: 500_000_00,
  /** Window for the fuzzy duplicate-invoice signal, in days. */
  NEAR_DUPLICATE_WINDOW_DAYS: 30,
  /**
   * How far measured lead time may exceed the quoted delivery before a late
   * delivery is predicted, as a ratio of the quote. 0.2 = 20% slower than promised.
   */
  LATE_DELIVERY_RATIO: 0.2,
  /** Drop in reliabilityScore against the seeded baseline that counts as degradation. */
  DEGRADATION_DROP: 0.15,
} as const;
