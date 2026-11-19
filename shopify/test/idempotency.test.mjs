import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

async function run(operationName, args, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { SHOPIFY_ACCESS_TOKEN: "shpat_fake", SHOPIFY_SHOP_DOMAIN: "acme.myshopify.com" }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source: "node" }), calls: recordingFetch.calls };
}

const change = { delta: 2, inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", changeFromQuantity: 3 };
const applied = { body: { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { reason: "received" }, userErrors: [] } } } };

test("a generated idempotency key is returned with the result", async () => {
  const { result, calls } = await run("adjust_inventory", { reason: "received", changes: [change] }, [applied]);
  assert.equal(result.data.idempotency_key, calls[0].json.variables.idempotencyKey);
  assert.match(result.data.idempotency_key, /^[0-9a-f-]{36}$/);
});

test("an unknown outcome names the generated key, so the caller can retry with it", async () => {
  const outcome = await run("create_refund", { order_id: "gid://shopify/Order/1" }, [{ status: 502, body: {} }]).then(
    () => assert.fail("expected an error"),
    (error) => error,
  );
  assert.match(outcome.message, /outcome unknown/);
  const key = /idempotency_key ([0-9a-f-]{36})/.exec(outcome.message)?.[1];
  assert.ok(key, outcome.message);
  const retried = await run("create_refund", { order_id: "gid://shopify/Order/1", idempotency_key: key }, [{ body: { data: { refundCreate: { refund: { id: "r1" }, userErrors: [] } } } }]);
  assert.equal(retried.calls[0].json.variables.idempotencyKey, key);
  assert.equal(retried.result.data.idempotency_key, key);
});

test("adjust_inventory needs changeFromQuantity on every change (null allowed)", async () => {
  const { changeFromQuantity: _omitted, ...withoutCompare } = change;
  await assert.rejects(run("adjust_inventory", { reason: "received", changes: [withoutCompare] }, [applied]), (error) => error.kind === "invalid_input" && error.message.includes("changeFromQuantity"));
  const { calls } = await run("adjust_inventory", { reason: "received", changes: [{ ...change, changeFromQuantity: null }] }, [applied]);
  assert.equal(calls[0].json.variables.input.changes[0].changeFromQuantity, null);
});

test("adjust_inventory needs ledgerDocumentUri for states other than available", async () => {
  await assert.rejects(run("adjust_inventory", { reason: "damaged", quantity_name: "damaged", changes: [change] }, [applied]), (error) => error.kind === "invalid_input" && error.message.includes("ledgerDocumentUri"));
  const { calls } = await run("adjust_inventory", { reason: "damaged", quantity_name: "damaged", changes: [{ ...change, ledgerDocumentUri: "gid://acme/Ledger/1" }] }, [applied]);
  assert.equal(calls.length, 1);
});
