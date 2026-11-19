import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { describeKeyModeMismatch } from "../lib/key-mode-hint.mjs";
import { pluginDefinition } from "../definition.mjs";

const unauthorized = { status: 401, body: { status_code: "401", status_message: "Transaction cannot be authorized with the current client/server key." } };

async function runExpectingError(environment) {
  const runner = createOperationRunner(pluginDefinition, environment, { fetchImpl: createRecordingFetch([unauthorized]) });
  return runner("get_transaction_status", { order_id: "A" }, { source: "tool" }).then(() => assert.fail("expected auth_error"), (error) => error);
}

test("describeKeyModeMismatch compares the SB- prefix with MIDTRANS_ENV", () => {
  assert.match(describeKeyModeMismatch({ MIDTRANS_ENV: "production", MIDTRANS_SERVER_KEY: "SB-Mid-server-x" }), /sandbox key/);
  assert.match(describeKeyModeMismatch({ MIDTRANS_SERVER_KEY: "Mid-server-x" }), /set MIDTRANS_ENV=production/);
  assert.equal(describeKeyModeMismatch({ MIDTRANS_SERVER_KEY: "SB-Mid-server-x" }), null);
  assert.equal(describeKeyModeMismatch({ MIDTRANS_ENV: "production", MIDTRANS_SERVER_KEY: "Mid-server-x" }), null);
});

test("auth errors carry the mismatch hint without the key", async () => {
  const error = await runExpectingError({ MIDTRANS_ENV: "production", MIDTRANS_SERVER_KEY: "SB-Mid-server-secretvalue" });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /looks like a sandbox key/);
  assert.equal(error.message.includes("secretvalue"), false);
  const matching = await runExpectingError({ MIDTRANS_SERVER_KEY: "SB-Mid-server-secretvalue" });
  assert.equal(/looks like/.test(matching.message), false);
});
