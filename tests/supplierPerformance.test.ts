import { describe, expect, it } from "vitest";
import { SUPPLIER_PERFORMANCE } from "../src/config/constants.js";
import {
  applyDeliveryOutcome,
  computeReliabilityScore,
  type DeliveryLine,
  type DeliveryObservation,
  deliveryDeltas,
  isInFull,
  isOnTime,
  leadTimeDays,
  nextAverageLeadTime,
  type SupplierPerformance,
  toScorecard,
} from "../src/rules/supplierPerformance.js";

const ORDERED = new Date("2026-08-01T00:00:00.000Z");
const PROMISED = new Date("2026-08-08T00:00:00.000Z");

function line(overrides: Partial<DeliveryLine> = {}): DeliveryLine {
  const orderedQuantity = overrides.orderedQuantity ?? 100;
  const receivedQuantity = overrides.receivedQuantity ?? orderedQuantity;
  const damagedQuantity = overrides.damagedQuantity ?? 0;
  return {
    orderedQuantity,
    receivedQuantity,
    damagedQuantity,
    acceptedQuantity: overrides.acceptedQuantity ?? receivedQuantity - damagedQuantity,
  };
}

function observation(overrides: Partial<DeliveryObservation> = {}): DeliveryObservation {
  return {
    expectedDeliveryDate: PROMISED,
    deliveredAt: new Date("2026-08-07T00:00:00.000Z"),
    orderedAt: ORDERED,
    lines: [line()],
    ...overrides,
  };
}

/** A supplier onboarded at 0.9 with nothing delivered yet. */
function fresh(overrides: Partial<SupplierPerformance> = {}): SupplierPerformance {
  return {
    totalDeliveries: 0,
    onTimeDeliveries: 0,
    inFullDeliveries: 0,
    orderedUnits: 0,
    acceptedUnits: 0,
    damagedUnits: 0,
    avgLeadTimeDays: null,
    lastDeliveryAt: null,
    reliabilityScore: 0.9,
    ...overrides,
  };
}

describe("isOnTime", () => {
  it("counts a delivery on the promised day as on time", () => {
    expect(isOnTime(observation({ deliveredAt: PROMISED }))).toBe(true);
  });

  it("counts a delivery after the promised day as late", () => {
    expect(isOnTime(observation({ deliveredAt: new Date("2026-08-09T00:00:00.000Z") }))).toBe(
      false,
    );
  });

  it("does not punish a supplier for a purchase order that promised nothing", () => {
    // A gap in our own paperwork must never read as the supplier's failure.
    expect(
      isOnTime(
        observation({
          expectedDeliveryDate: null,
          deliveredAt: new Date("2027-01-01T00:00:00.000Z"),
        }),
      ),
    ).toBe(true);
  });
});

describe("isInFull", () => {
  it("is true only when every ordered unit was accepted", () => {
    expect(isInFull([line()])).toBe(true);
  });

  it("is false for a short delivery", () => {
    expect(isInFull([line({ receivedQuantity: 98 })])).toBe(false);
  });

  it("is false when everything arrived but some of it was damaged", () => {
    // Damaged units arrived and were rejected — the order is not filled.
    expect(isInFull([line({ receivedQuantity: 100, damagedQuantity: 2 })])).toBe(false);
  });

  it("is false when there are no lines at all", () => {
    expect(isInFull([])).toBe(false);
  });
});

describe("leadTimeDays", () => {
  it("measures whole and fractional days from order to delivery", () => {
    expect(leadTimeDays(observation())).toBe(6);
  });

  it("returns null when there is no start of clock", () => {
    expect(leadTimeDays(observation({ orderedAt: null }))).toBeNull();
  });

  it("returns null rather than zero when a delivery predates its order", () => {
    expect(
      leadTimeDays(observation({ deliveredAt: new Date("2026-07-01T00:00:00.000Z") })),
    ).toBeNull();
  });
});

describe("computeReliabilityScore", () => {
  const perfect = {
    totalDeliveries: 1,
    onTimeDeliveries: 1,
    inFullDeliveries: 1,
    orderedUnits: 100,
    acceptedUnits: 100,
    damagedUnits: 0,
  };

  it("returns the prior untouched when nothing has been delivered", () => {
    expect(computeReliabilityScore({ ...perfect, totalDeliveries: 0 }, 0.9)).toBe(0.9);
  });

  it("does not let a single delivery reach the raw observed score", () => {
    // Without the shrinkage prior this would be a flat 1.0 after one delivery.
    const score = computeReliabilityScore(perfect, 0.9);
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThan(1);
  });

  it("does not let a single failure destroy a supplier", () => {
    const disaster = {
      totalDeliveries: 1,
      onTimeDeliveries: 0,
      inFullDeliveries: 0,
      orderedUnits: 100,
      acceptedUnits: 0,
      damagedUnits: 100,
    };

    const score = computeReliabilityScore(disaster, 0.9);
    expect(score).toBeLessThan(0.9);
    // The raw observation is 0; the prior holds most of the weight at n = 1.
    expect(score).toBeGreaterThan(0.9 * (SUPPLIER_PERFORMANCE.PRIOR_WEIGHT / 6) - 0.01);
  });

  it("lets sustained evidence eventually outweigh the prior", () => {
    const sustained = {
      totalDeliveries: 100,
      onTimeDeliveries: 0,
      inFullDeliveries: 0,
      orderedUnits: 10_000,
      acceptedUnits: 10_000,
      damagedUnits: 0,
    };

    // Always late, always short, never damaged: only the quality term survives.
    expect(computeReliabilityScore(sustained, 0.9)).toBeCloseTo(
      (SUPPLIER_PERFORMANCE.PRIOR_WEIGHT * 0.9 + 100 * SUPPLIER_PERFORMANCE.QUALITY_WEIGHT) / 105,
      3,
    );
  });

  it("never leaves the 0-1 range, even given a nonsense prior", () => {
    expect(computeReliabilityScore(perfect, 5)).toBeLessThanOrEqual(1);
    expect(computeReliabilityScore(perfect, -5)).toBeGreaterThanOrEqual(0);
  });

  it("treats a zero ordered-unit counter as undamaged rather than dividing by zero", () => {
    const score = computeReliabilityScore({ ...perfect, orderedUnits: 0, acceptedUnits: 0 }, 0.9);
    expect(Number.isFinite(score)).toBe(true);
  });
});

describe("deliveryDeltas", () => {
  it("produces the increments a good delivery adds", () => {
    expect(deliveryDeltas(observation())).toEqual({
      totalDeliveries: 1,
      onTimeDeliveries: 1,
      inFullDeliveries: 1,
      orderedUnits: 100,
      acceptedUnits: 100,
      damagedUnits: 0,
    });
  });

  it("scores a late, short, damaged delivery on none of the three", () => {
    expect(
      deliveryDeltas(
        observation({
          deliveredAt: new Date("2026-08-20T00:00:00.000Z"),
          lines: [line({ receivedQuantity: 98, damagedQuantity: 2 })],
        }),
      ),
    ).toEqual({
      totalDeliveries: 1,
      onTimeDeliveries: 0,
      inFullDeliveries: 0,
      orderedUnits: 100,
      acceptedUnits: 96,
      damagedUnits: 2,
    });
  });

  it("sums across every line of a multi-line delivery", () => {
    const deltas = deliveryDeltas(
      observation({ lines: [line({ orderedQuantity: 10 }), line({ orderedQuantity: 5 })] }),
    );
    expect(deltas.orderedUnits).toBe(15);
    expect(deltas.inFullDeliveries).toBe(1);
  });
});

describe("nextAverageLeadTime", () => {
  it("takes the first measurement as the average", () => {
    expect(nextAverageLeadTime(null, 0, observation())).toBe(6);
  });

  it("weights the running mean by the deliveries behind it", () => {
    expect(nextAverageLeadTime(10, 3, observation())).toBe(9);
  });

  it("leaves the average alone when this delivery could not be measured", () => {
    expect(nextAverageLeadTime(10, 3, observation({ orderedAt: null }))).toBe(10);
  });
});

describe("applyDeliveryOutcome", () => {
  it("agrees with the atomic increment path it exists alongside", () => {
    const applied = applyDeliveryOutcome(fresh(), observation());
    const deltas = deliveryDeltas(observation());

    expect(applied.totalDeliveries).toBe(deltas.totalDeliveries);
    expect(applied.acceptedUnits).toBe(deltas.acceptedUnits);
    expect(applied.reliabilityScore).toBe(computeReliabilityScore(deltas, 0.9));
  });

  it("shrinks toward the baseline it is given, not the supplier's current score", () => {
    const drifted = fresh({ totalDeliveries: 4, reliabilityScore: 0.4 });

    const towardsCurrent = applyDeliveryOutcome(drifted, observation());
    const towardsSeed = applyDeliveryOutcome(drifted, observation(), 0.9);

    expect(towardsSeed.reliabilityScore).toBeGreaterThan(towardsCurrent.reliabilityScore);
  });

  it("stamps the delivery date", () => {
    const applied = applyDeliveryOutcome(fresh(), observation());
    expect(applied.lastDeliveryAt).toEqual(new Date("2026-08-07T00:00:00.000Z"));
  });

  it("counts twice when called twice — the caller owns idempotency", () => {
    const once = applyDeliveryOutcome(fresh(), observation());
    const twice = applyDeliveryOutcome(once, observation());
    expect(twice.totalDeliveries).toBe(2);
  });
});

describe("toScorecard", () => {
  it("reports nulls, not zeroes, for a supplier that has never delivered", () => {
    // "No data" and "never on time" are opposite facts and must not both render as 0.
    const scorecard = toScorecard(fresh());
    expect(scorecard.onTimeRate).toBeNull();
    expect(scorecard.otifRate).toBeNull();
    expect(scorecard.damageRate).toBeNull();
    expect(scorecard.totalDeliveries).toBe(0);
  });

  it("derives the rates a buyer reads", () => {
    const scorecard = toScorecard(
      fresh({
        totalDeliveries: 4,
        onTimeDeliveries: 3,
        inFullDeliveries: 2,
        orderedUnits: 400,
        acceptedUnits: 390,
        damagedUnits: 10,
        avgLeadTimeDays: 6.5,
      }),
    );

    expect(scorecard.onTimeRate).toBe(0.75);
    expect(scorecard.inFullRate).toBe(0.5);
    expect(scorecard.otifRate).toBe(0.375);
    expect(scorecard.damageRate).toBe(0.025);
    expect(scorecard.avgLeadTimeDays).toBe(6.5);
  });
});
