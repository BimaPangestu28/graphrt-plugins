import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

async function run(operationName, args, { source = "node", environment = {} } = {}) {
  const recordingFetch = createRecordingFetch([{ body: { id: "inv_1" } }]);
  const runner = createOperationRunner(pluginDefinition, { XENDIT_SECRET_KEY: "xnd_development_fake", ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("currency is trimmed and uppercased, so the agent allowlist and Xendit see IDR", async () => {
  const environment = { XENDIT_TOOL_ALLOW_INVOICES: "1", XENDIT_TOOL_MAX_AMOUNT: "100000", XENDIT_TOOL_ALLOWED_CURRENCIES: "IDR" };
  const { calls } = await run("create_invoice", { external_id: "INV-1", amount: 5000, currency: " idr" }, { source: "tool", environment });
  assert.equal(calls[0].json.currency, "IDR");
  const balance = await run("get_balance", { currency: "php" });
  assert.equal(balance.calls[0].query.currency, "PHP");
});

test("invoice redirect URLs must be https", async () => {
  for (const badUrl of ["http://shop.example/ok", "javascript:alert(1)", "not a url"]) {
    await assert.rejects(run("create_invoice", { external_id: "INV-1", amount: 5000, success_redirect_url: badUrl }), (error) => error.kind === "invalid_input" && error.message.includes("https"), badUrl);
  }
  await assert.rejects(run("create_invoice", { external_id: "INV-1", amount: 5000, failure_redirect_url: "http://shop.example/fail" }), (error) => error.kind === "invalid_input");
  const { calls } = await run("create_invoice", { external_id: "INV-1", amount: 5000, success_redirect_url: "https://shop.example/ok" });
  assert.equal(calls[0].json.success_redirect_url, "https://shop.example/ok");
});
