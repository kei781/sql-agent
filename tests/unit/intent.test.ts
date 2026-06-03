import assert from "node:assert/strict";
import test from "node:test";

import { validateIntentSpec, type IntentSpec } from "../../src/core/intent/index.js";

const baseSpec: IntentSpec = {
  metrics: [],
  groupings: [],
  filters: [],
};

test("intent spec requires business slots and requester confirmation", () => {
  const missing = validateIntentSpec(baseSpec);

  assert.deepEqual(
    missing.map((slot) => slot.slot),
    ["metrics", "period", "confirmation"],
  );
});

test("intent spec rejects inverted periods", () => {
  const missing = validateIntentSpec({
    ...baseSpec,
    metrics: ["paid_revenue"],
    startDate: new Date("2026-06-02T00:00:00.000Z"),
    endDate: new Date("2026-06-01T00:00:00.000Z"),
    confirmedBy: "U123",
    confirmedAt: "2026-06-03T00:00:00.000Z",
  });

  assert.deepEqual(
    missing.map((slot) => slot.slot),
    ["period"],
  );
});

test("complete intent spec passes", () => {
  const missing = validateIntentSpec({
    ...baseSpec,
    metrics: ["paid_revenue"],
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    endDate: new Date("2026-06-02T00:00:00.000Z"),
    confirmedBy: "U123",
    confirmedAt: "2026-06-03T00:00:00.000Z",
  });

  assert.deepEqual(missing, []);
});
