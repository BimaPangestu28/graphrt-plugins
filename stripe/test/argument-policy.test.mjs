import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

async function run(operationName, args, { source = "tool", environment = {} } = {}) {
  const recordingFetch = createRecordingFetch([{ body: { id: "x_1" } }]);
  const runner = createOperationRunner(pluginDefinition, { STRIPE_SECRET_KEY: "sk_test_fake", ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);
const formOf = (call) => Object.fromEntries(new URLSearchParams(call.body));

test("add_invoice_item is node only (a renewal draft would charge an agent-added amount automatically)", async () => {
  assert.equal(pluginDefinition.operations.find((operation) => operation.name === "add_invoice_item").nodeOnly, true);
  await assert.rejects(run("add_invoice_item", { customer: "cus_1", invoice: "in_1", amount: 99999900, currency: "usd" }, { environment: { STRIPE_TOOL_ALLOW_WRITE: "1" } }), (error) => error.kind === "invalid_input");
  const { calls } = await run("add_invoice_item", { customer: "cus_1", invoice: "in_1", amount: 500, currency: "usd" }, { source: "node" });
  assert.equal(calls.length, 1);
});

test("agent payment links take only {price, quantity} with quantity 1..100", async () => {
  const environment = { STRIPE_TOOL_ALLOW_PAYMENT_LINKS: "1" };
  const refused = [
    [[{ price: "price_1", quantity: 101 }], "quantity must be an integer from 1 to 100"],
    [[{ price: "price_1", quantity: 0 }], "quantity"],
    [[{ price: "price_1", quantity: 1, adjustable_quantity: { enabled: true, maximum: 999 } }], "adjustable_quantity"],
    [[{ price_data: { currency: "usd", unit_amount: 99999999, product: "prod_1" }, quantity: 1 }], "price_data"],
    [[{ price: "plan_old", quantity: 1 }], "existing price id"],
  ];
  for (const [lineItems, fragment] of refused) {
    await assert.rejects(run("create_payment_link", { line_items: lineItems }, { environment }), isDenied(fragment), fragment);
  }
  const { calls } = await run("create_payment_link", { line_items: [{ price: "price_1", quantity: 100 }] }, { environment });
  assert.deepEqual(formOf(calls[0]), { "line_items[0][price]": "price_1", "line_items[0][quantity]": "100" });
});

test("without the opt-in the payment-link refusal names STRIPE_TOOL_ALLOW_PAYMENT_LINKS", async () => {
  await assert.rejects(run("create_payment_link", { line_items: [{ price_data: {}, quantity: 1 }] }), isDenied("STRIPE_TOOL_ALLOW_PAYMENT_LINKS"));
});

test("workflow nodes may send other line-item fields", async () => {
  const { calls } = await run("create_payment_link", { line_items: [{ price: "price_1", quantity: 500, adjustable_quantity: { enabled: true } }] }, { source: "node" });
  assert.equal(formOf(calls[0])["line_items[0][adjustable_quantity][enabled]"], "true");
});

test("agent prices are capped like PaymentIntents (unit_amount, allowed currency)", async () => {
  const environment = { STRIPE_TOOL_ALLOW_WRITE: "1", STRIPE_TOOL_MAX_AMOUNT: "5000", STRIPE_TOOL_ALLOWED_CURRENCIES: "usd" };
  const priceArgs = { product: "prod_1", currency: "usd" };
  await assert.rejects(run("create_price", { ...priceArgs, unit_amount: 1000 }, { environment: { STRIPE_TOOL_ALLOW_WRITE: "1" } }), isDenied("STRIPE_TOOL_MAX_AMOUNT"));
  await assert.rejects(run("create_price", { ...priceArgs, unit_amount: 5001 }, { environment }), isDenied("over STRIPE_TOOL_MAX_AMOUNT=5000"));
  await assert.rejects(run("create_price", { ...priceArgs, unit_amount: 100, currency: "jpy" }, { environment }), isDenied("jpy"));
  const { calls } = await run("create_price", { ...priceArgs, unit_amount: 5000 }, { environment });
  assert.equal(calls.length, 1);
});

test("currency is trimmed and lowercased before the cap and the request", async () => {
  const environment = { STRIPE_TOOL_ALLOW_PAYMENT_INTENTS: "1", STRIPE_TOOL_MAX_AMOUNT: "5000", STRIPE_TOOL_ALLOWED_CURRENCIES: "usd" };
  const { calls } = await run("create_payment_intent", { amount: 100, currency: " USD " }, { environment });
  assert.equal(formOf(calls[0]).currency, "usd");
  const node = await run("list_prices", { currency: "EUR" }, { source: "node" });
  assert.equal(node.calls[0].query.currency, "eur");
});
