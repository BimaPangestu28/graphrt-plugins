import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { parseMaxAmount } from "../lib/tool-amount-cap.mjs";
import { pluginDefinition, STRIPE_API_VERSION } from "../definition.mjs";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: { id: "pi_1" } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { STRIPE_SECRET_KEY: "sk_test_fake", ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const intentArgs = { amount: 5000, currency: "usd" };
const optedIn = { STRIPE_TOOL_ALLOW_PAYMENT_INTENTS: "1" };
const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);

test("parseMaxAmount accepts only positive numbers", () => {
  assert.equal(parseMaxAmount("5000"), 5000);
  for (const refused of [undefined, "", " ", "0", "-5", "abc", "Infinity"]) assert.equal(parseMaxAmount(refused), undefined);
});

test("create_payment_intent as a tool needs the opt-in first, and the refusal names it", async () => {
  await assert.rejects(run("create_payment_intent", intentArgs), isDenied("STRIPE_TOOL_ALLOW_PAYMENT_INTENTS"));
});

test("create_payment_intent as a tool is refused while STRIPE_TOOL_MAX_AMOUNT is unset or 0", async () => {
  for (const maxAmount of [undefined, "0", "not-a-number"]) {
    const environment = { ...optedIn, STRIPE_TOOL_ALLOWED_CURRENCIES: "usd", ...(maxAmount === undefined ? {} : { STRIPE_TOOL_MAX_AMOUNT: maxAmount }) };
    await assert.rejects(run("create_payment_intent", intentArgs, { environment }), isDenied("STRIPE_TOOL_MAX_AMOUNT"));
  }
});

test("create_payment_intent as a tool is refused over the cap and sends nothing", async () => {
  const environment = { ...optedIn, STRIPE_TOOL_MAX_AMOUNT: "4999", STRIPE_TOOL_ALLOWED_CURRENCIES: "usd" };
  await assert.rejects(run("create_payment_intent", intentArgs, { environment }), isDenied("over STRIPE_TOOL_MAX_AMOUNT=4999"));
});

test("create_payment_intent as a tool needs the currency in STRIPE_TOOL_ALLOWED_CURRENCIES", async () => {
  const base = { ...optedIn, STRIPE_TOOL_MAX_AMOUNT: "10000" };
  await assert.rejects(run("create_payment_intent", intentArgs, { environment: base }), isDenied("STRIPE_TOOL_ALLOWED_CURRENCIES"));
  await assert.rejects(run("create_payment_intent", { amount: 100, currency: "jpy" }, { environment: { ...base, STRIPE_TOOL_ALLOWED_CURRENCIES: "usd,eur" } }), isDenied("jpy"));
  const { calls } = await run("create_payment_intent", intentArgs, { environment: { ...base, STRIPE_TOOL_ALLOWED_CURRENCIES: "EUR, USD" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["idempotency-key"]?.length, 36);
  assert.equal(calls[0].headers["stripe-version"], STRIPE_API_VERSION);
});

test("workflow nodes create PaymentIntents of any amount without the cap", async () => {
  const { calls } = await run("create_payment_intent", { amount: 99999999, currency: "jpy" }, { source: "node" });
  assert.equal(calls.length, 1);
});

test("money-moving operations are not agent tools", async () => {
  const nodeOnlyNames = ["confirm_payment_intent", "capture_payment_intent", "cancel_payment_intent", "finalize_invoice", "send_invoice", "pay_invoice", "create_refund", "cancel_subscription"];
  for (const operationName of nodeOnlyNames) {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly, true, operationName);
  }
});

test("client_secret is removed from tool results, at any depth, but kept for nodes", async () => {
  const body = { id: "pi_1", client_secret: "pi_1_secret_abc", latest_charge: { nested: { client_secret: "x" } } };
  const toolResult = await run("get_payment_intent", { payment_intent_id: "pi_1" }, { responses: [{ body }] });
  assert.deepEqual(toolResult.result.data, { id: "pi_1", latest_charge: { nested: {} } });
  const listResult = await run("list_payment_intents", {}, { responses: [{ body: { data: [body], has_more: false } }] });
  assert.equal(JSON.stringify(listResult.result.data).includes("secret"), false);
  const nodeResult = await run("get_payment_intent", { payment_intent_id: "pi_1" }, { source: "node", responses: [{ body }] });
  assert.equal(nodeResult.result.data.client_secret, "pi_1_secret_abc");
});

test("api_request as a tool only reaches allowlisted read paths", async () => {
  for (const blockedPath of ["/v1/payment_intents", "/v1/payment_intents/pi_1", "/v1/checkout/sessions", "/v1/issuing/cards/ic_1", "/v1/apps/secrets", "/v1/webhook_endpoints", "/v1/events", "/v1/customers/../issuing/cards", "/v1/%70ayment_intents"]) {
    await assert.rejects(run("api_request", { path: blockedPath }), isDenied("api_request cannot reach"), blockedPath);
  }
  for (const allowedPath of ["/v1/balance", "/v1/customers/cus_1", "/v1/disputes?limit=3"]) {
    const { calls } = await run("api_request", { path: allowedPath });
    assert.equal(calls.length, 1, allowedPath);
  }
  const { calls } = await run("api_request", { path: "/v1/payment_intents" }, { source: "node" });
  assert.equal(calls.length, 1);
});

test("api_request strips client_secret for tools", async () => {
  const { result } = await run("api_request", { path: "/v1/invoices/in_1" }, { responses: [{ body: { id: "in_1", payment_intent: { client_secret: "s" } } }] });
  assert.equal(JSON.stringify(result.data).includes("client_secret"), false);
});
