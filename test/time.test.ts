import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseNaturalTimeWindow, resolveTimeFilter } from "../src/time.ts";

const NOW = new Date(2026, 6, 2, 12, 0, 0, 0);

describe("parseNaturalTimeWindow", () => {
  test("turns last week into the previous calendar week", () => {
    const window = parseNaturalTimeWindow("last week", NOW);
    assert.deepEqual(window, {
      since: new Date(2026, 5, 22, 0, 0, 0, 0).toISOString(),
      until: new Date(2026, 5, 29, 0, 0, 0, 0).toISOString(),
    });
  });

  test("turns rolling windows into now-relative bounds", () => {
    const window = parseNaturalTimeWindow("past 7 days", NOW);
    assert.deepEqual(window, {
      since: new Date(2026, 5, 25, 12, 0, 0, 0).toISOString(),
      until: NOW.toISOString(),
    });
  });

  test("normalizes explicit date ranges to full-day exclusive bounds", () => {
    const window = parseNaturalTimeWindow("Sep 12-13", NOW);
    assert.deepEqual(window, {
      since: new Date(2026, 8, 12, 0, 0, 0, 0).toISOString(),
      until: new Date(2026, 8, 14, 0, 0, 0, 0).toISOString(),
    });
  });

  test("normalizes split range phrases to full-day exclusive bounds", () => {
    const window = parseNaturalTimeWindow("between June 1 and June 3", NOW);
    assert.deepEqual(window, {
      since: new Date(2026, 5, 1, 0, 0, 0, 0).toISOString(),
      until: new Date(2026, 5, 4, 0, 0, 0, 0).toISOString(),
    });
  });
});

describe("resolveTimeFilter", () => {
  test("lets explicit ISO bounds override the natural-language window", () => {
    const resolved = resolveTimeFilter(
      {
        time: "last week",
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-01-02T00:00:00.000Z",
      },
      NOW,
    );
    assert.deepEqual(resolved, {
      filter: {
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-01-02T00:00:00.000Z",
      },
    });
  });

  test("rejects inverted bounds", () => {
    const resolved = resolveTimeFilter({ since: "2026-01-02T00:00:00.000Z", until: "2026-01-01T00:00:00.000Z" }, NOW);
    assert.equal(resolved.error, "`since` must be earlier than `until`.");
  });
});
