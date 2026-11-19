import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { normalizePropertyId } from "../lib/property-id.mjs";
import { pluginDefinition } from "../definition.mjs";

test("normalizePropertyId accepts digits or properties/<digits> and returns the digits", () => {
  assert.equal(normalizePropertyId("123456789"), "123456789");
  assert.equal(normalizePropertyId(" properties/123456789 "), "123456789");
  assert.equal(normalizePropertyId(123456789), "123456789");
  assert.equal(normalizePropertyId("0"), "0");
});

test("normalizePropertyId refuses anything else", () => {
  for (const badId of ["", "abc", "properties/", "properties/12a", "accounts/1", "123/..", "G-ABC123", "properties/1/dataStreams", "-1"]) {
    assert.throws(() => normalizePropertyId(badId), (error) => error.kind === "invalid_input" && /property_id/.test(error.message), JSON.stringify(badId));
  }
});

test("every property operation sends the bare id and refuses bad ids before any request", async () => {
  const recordingFetch = createRecordingFetch([{ body: { rows: [] } }, { body: { name: "properties/42" } }]);
  const run = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: "ya29.ga-token-1" }, { fetchImpl: recordingFetch });
  await run("run_report", { property_id: "properties/42", dimensions: ["country"], metrics: ["activeUsers"] }, { source: "tool" });
  await run("get_property", { property_id: "properties/42" }, { source: "tool" });
  assert.equal(new URL(recordingFetch.calls[0].url).pathname, "/v1beta/properties/42:runReport");
  assert.equal(new URL(recordingFetch.calls[1].url).pathname, "/v1beta/properties/42");
  await assert.rejects(run("get_metadata", { property_id: "G-ABC123" }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(recordingFetch.calls.length, 2);
});
