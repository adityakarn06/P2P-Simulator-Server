import { SUPPLIER_PERFORMANCE } from "../config/constants.js";

/**
 * Deterministic supplier delivery performance (OTIF — on time, in full).
 *
 * Pure functions, no I/O, no Prisma imports — the score this module produces is
 * 20% of every future sourcing decision (src/rules/supplierRanking.ts), so it
 * must be exhaustively unit-testable and must never involve Gemini.
 *
 * This is the feedback loop that makes sourcing a supply-chain system rather
 * than a lookup: a supplier that delivers late, short, or damaged scores lower
 * on the next requisition without anybody editing a row by hand.
 */

/** The counters stored on Supplier, plus the derived score they explain. */
export interface SupplierPerformance {
  totalDeliveries: number;
  onTimeDeliveries: number;
  inFullDeliveries: number;
  orderedUnits: number;
  acceptedUnits: number;
  damagedUnits: number;
  /** Null until the first delivery, or when no lead time could be measured. */
  avgLeadTimeDays: number | null;
  lastDeliveryAt: Date | null;
  /** 0-1. */
  reliabilityScore: number;
}

/** One completed delivery, as observed by the goods receipt that recorded it. */
export interface DeliveryObservation {
  /** Null when the purchase order never carried a promise — see onTime below. */
  expectedDeliveryDate: Date | null;
  deliveredAt: Date;
  /** Start of the lead-time clock. Null skips the lead-time update only. */
  orderedAt: Date | null;
  lines: DeliveryLine[];
}

/** Mirrors ReceiptLine in src/rules/receiptRules.ts — the same accepted-quantity semantics. */
export interface DeliveryLine {
  orderedQuantity: number;
  receivedQuantity: number;
  damagedQuantity: number;
  /** receivedQuantity - damagedQuantity, as computed by receiptRules.buildReceiptLines. */
  acceptedQuantity: number;
}

const MS_PER_DAY = 86_400_000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Scores are display and ranking values, not money. Four decimals is stable and plenty. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Was the delivery on time?
 *
 * A purchase order with no promised date counts as on time. The alternative —
 * treating a missing promise as a miss — would punish a supplier for a gap in
 * *our* paperwork, which is the same reasoning `checkEligibility` uses when a
 * requirement carries no deadline.
 */
export function isOnTime(observation: DeliveryObservation): boolean {
  return (
    observation.expectedDeliveryDate === null ||
    observation.deliveredAt.getTime() <= observation.expectedDeliveryDate.getTime()
  );
}

/**
 * Was the delivery in full?
 *
 * Measured against *accepted* units, not received ones: a crate that arrived
 * and was rejected as damaged did not fill the order. This is the same
 * distinction three-way matching draws when it bills against acceptedQuantity.
 */
export function isInFull(lines: DeliveryLine[]): boolean {
  return lines.length > 0 && lines.every((line) => line.acceptedQuantity === line.orderedQuantity);
}

/** Days from purchase-order approval to delivery. Null when the clock has no start. */
export function leadTimeDays(observation: DeliveryObservation): number | null {
  if (observation.orderedAt === null) {
    return null;
  }

  const elapsed = observation.deliveredAt.getTime() - observation.orderedAt.getTime();

  // A delivery recorded before its own order is a clock problem, not a
  // zero-day lead time — better to measure nothing than to record a fiction.
  return elapsed < 0 ? null : round4(elapsed / MS_PER_DAY);
}

/**
 * The reliability score behind the 20% RELIABILITY weight in supplier ranking.
 *
 * Blended from three rates a buyer would actually name: did it turn up on time,
 * did all of it turn up, and how much of it was unusable.
 *
 * The shrinkage prior is the important part. Without it a supplier's first
 * delivery moves the score from its seeded value to a raw 0 or 1, one late
 * shipment permanently destroys a vendor, and the ranking becomes impossible to
 * explain. Blending toward the seeded score with a weight of
 * SUPPLIER_PERFORMANCE.PRIOR_WEIGHT pseudo-deliveries means early evidence
 * nudges the score and sustained evidence eventually owns it.
 */
export function computeReliabilityScore(
  counters: Pick<
    SupplierPerformance,
    | "totalDeliveries"
    | "onTimeDeliveries"
    | "inFullDeliveries"
    | "orderedUnits"
    | "acceptedUnits"
    | "damagedUnits"
  >,
  priorScore: number,
): number {
  if (counters.totalDeliveries === 0) {
    return round4(clamp01(priorScore));
  }

  const onTimeRate = counters.onTimeDeliveries / counters.totalDeliveries;
  const inFullRate = counters.inFullDeliveries / counters.totalDeliveries;
  // Guarded: a receipt can only exist with at least one received unit
  // (receiptRules rejects an empty one), but orderedUnits is a stored counter
  // and must not be trusted to be non-zero.
  const damageRate =
    counters.orderedUnits === 0 ? 0 : counters.damagedUnits / counters.orderedUnits;

  const observed =
    SUPPLIER_PERFORMANCE.ON_TIME_WEIGHT * onTimeRate +
    SUPPLIER_PERFORMANCE.IN_FULL_WEIGHT * inFullRate +
    SUPPLIER_PERFORMANCE.QUALITY_WEIGHT * (1 - clamp01(damageRate));

  const weight = SUPPLIER_PERFORMANCE.PRIOR_WEIGHT;
  const blended =
    (weight * clamp01(priorScore) + counters.totalDeliveries * observed) /
    (weight + counters.totalDeliveries);

  return round4(clamp01(blended));
}

/**
 * What one delivery adds to each counter.
 *
 * Returned as plain deltas so the caller can hand them straight to Prisma's
 * atomic `increment`. Two goods receipts for different shipments of the same
 * supplier can commit concurrently, and a read-modify-write of these columns
 * would silently lose one of them.
 */
export type PerformanceDeltas = Pick<
  SupplierPerformance,
  | "totalDeliveries"
  | "onTimeDeliveries"
  | "inFullDeliveries"
  | "orderedUnits"
  | "acceptedUnits"
  | "damagedUnits"
>;

export function deliveryDeltas(observation: DeliveryObservation): PerformanceDeltas {
  const { lines } = observation;

  return {
    totalDeliveries: 1,
    onTimeDeliveries: isOnTime(observation) ? 1 : 0,
    inFullDeliveries: isInFull(lines) ? 1 : 0,
    orderedUnits: sum(lines, (line) => line.orderedQuantity),
    acceptedUnits: sum(lines, (line) => line.acceptedQuantity),
    damagedUnits: sum(lines, (line) => line.damagedQuantity),
  };
}

/**
 * Running mean over the deliveries that could actually be measured.
 *
 * Weighted by the delivery count rather than by a separate counter: a delivery
 * with no measurable lead time simply leaves the average where it was, which
 * drifts the weighting slightly and is not worth a second column for.
 */
export function nextAverageLeadTime(
  previousAverage: number | null,
  previousDeliveries: number,
  observation: DeliveryObservation,
): number | null {
  const measured = leadTimeDays(observation);

  if (measured === null) {
    return previousAverage;
  }
  if (previousAverage === null || previousDeliveries <= 0) {
    return measured;
  }

  return round4((previousAverage * previousDeliveries + measured) / (previousDeliveries + 1));
}

/**
 * Folds one delivery into a supplier's running performance.
 *
 * The whole-object form, used by the tests and by any caller that already holds
 * an exclusive view of the supplier. Callers writing through Prisma should
 * prefer `deliveryDeltas` + `computeReliabilityScore` so the counters move
 * atomically; this function and that pair produce the same answer.
 *
 * Counting is not idempotent — invoking this twice for one delivery counts it
 * twice. `recordGoodsReceipt` must call it only on the branch that actually
 * creates the goods receipt, never on an idempotent replay.
 */
export function applyDeliveryOutcome(
  prior: SupplierPerformance,
  observation: DeliveryObservation,
  /** The score to shrink toward: the supplier's seeded baseline, not its current score. */
  baselineScore: number = prior.reliabilityScore,
): SupplierPerformance {
  const deltas = deliveryDeltas(observation);

  const counters: PerformanceDeltas = {
    totalDeliveries: prior.totalDeliveries + deltas.totalDeliveries,
    onTimeDeliveries: prior.onTimeDeliveries + deltas.onTimeDeliveries,
    inFullDeliveries: prior.inFullDeliveries + deltas.inFullDeliveries,
    orderedUnits: prior.orderedUnits + deltas.orderedUnits,
    acceptedUnits: prior.acceptedUnits + deltas.acceptedUnits,
    damagedUnits: prior.damagedUnits + deltas.damagedUnits,
  };

  return {
    ...counters,
    avgLeadTimeDays: nextAverageLeadTime(prior.avgLeadTimeDays, prior.totalDeliveries, observation),
    lastDeliveryAt: observation.deliveredAt,
    reliabilityScore: computeReliabilityScore(counters, baselineScore),
  };
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

/** Display figures for the supplier scorecard. Rates are 0-1, never percentages. */
export interface SupplierScorecard {
  onTimeRate: number | null;
  inFullRate: number | null;
  otifRate: number | null;
  damageRate: number | null;
  avgLeadTimeDays: number | null;
  totalDeliveries: number;
  reliabilityScore: number;
}

/**
 * Derives the rates a buyer reads from the stored counters.
 *
 * A supplier with no deliveries yet returns nulls, not zeroes: "no data" and
 * "never delivered on time" look identical as 0 and mean opposite things.
 *
 * OTIF is approximated as onTimeRate x inFullRate rather than measured jointly.
 * The counters do not record which deliveries were both, and a second pair of
 * columns to capture it is not worth the write path for the MVP.
 */
export function toScorecard(performance: SupplierPerformance): SupplierScorecard {
  if (performance.totalDeliveries === 0) {
    return {
      onTimeRate: null,
      inFullRate: null,
      otifRate: null,
      damageRate: null,
      avgLeadTimeDays: performance.avgLeadTimeDays,
      totalDeliveries: 0,
      reliabilityScore: round4(performance.reliabilityScore),
    };
  }

  const onTimeRate = round4(performance.onTimeDeliveries / performance.totalDeliveries);
  const inFullRate = round4(performance.inFullDeliveries / performance.totalDeliveries);

  return {
    onTimeRate,
    inFullRate,
    otifRate: round4(onTimeRate * inFullRate),
    damageRate:
      performance.orderedUnits === 0
        ? null
        : round4(performance.damagedUnits / performance.orderedUnits),
    avgLeadTimeDays: performance.avgLeadTimeDays,
    totalDeliveries: performance.totalDeliveries,
    reliabilityScore: round4(performance.reliabilityScore),
  };
}
