import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNamedFields, normalizeReportRequest } from "../lib/report-fields.mjs";

test("normalizeNamedFields turns names into {name} objects and keeps objects", () => {
  assert.deepEqual(normalizeNamedFields(["country", { name: "city" }, " date "], "dimensions"), [{ name: "country" }, { name: "city" }, { name: "date" }]);
  assert.equal(normalizeNamedFields(undefined, "metrics"), undefined);
});

test("normalizeNamedFields refuses empty names and other values", () => {
  for (const badValue of [[""], ["  "], [3], [null], [["a"]]]) {
    assert.throws(() => normalizeNamedFields(badValue, "metrics"), (error) => error.kind === "invalid_input" && /metrics\[0\]/.test(error.message), JSON.stringify(badValue));
  }
});

test("normalizeReportRequest converts dimensions and metrics and leaves the rest alone", () => {
  const request = { dimensions: ["country"], metrics: ["activeUsers"], dateRanges: [{ startDate: "7daysAgo", endDate: "today" }], limit: 5 };
  assert.deepEqual(normalizeReportRequest(request, "requests[0]"), { dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }], dateRanges: [{ startDate: "7daysAgo", endDate: "today" }], limit: 5 });
  assert.deepEqual(normalizeReportRequest({ limit: 1 }, "requests[0]"), { limit: 1 });
});

test("normalizeReportRequest refuses a non-object request", () => {
  assert.throws(() => normalizeReportRequest("x", "requests[1]"), (error) => error.kind === "invalid_input" && /requests\[1\]/.test(error.message));
});
