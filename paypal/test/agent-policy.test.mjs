import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const TOKEN_RESPONSE = { body: { access_token: "A21-test-token", token_type: "Bearer", expires_in: 32400 } };
// Tokens are cached per client id, so every run gets its own client id and fetches a token first.
let runCount = 0;
const nextCredentials = () => ({ PAYPAL_CLIENT_ID: `client-id-${(runCount += 1)}`, PAYPAL_CLIENT_SECRET: "client-secret" });

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ status: 201, body: { id: "5O1" } }] } = {}) {
  const recordingFetch = createRecordingFetch([TOKEN_RESPONSE, ...responses]);
  const runner = createOperationRunner(pluginDefinition, { ...nextCredentials(), ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const units = (value, currency = "USD") => [{ amount: { currency_code: currency, value } }];
const optedIn = { PAYPAL_TOOL_ALLOW_ORDERS: "1" };
const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);

test("PAYPAL_ENV picks the sandbox (default) or live host for the token and the API", async () => {
  const sandbox = await run("get_order", { order_id: "5O1" });
  assert.deepEqual(sandbox.calls.map((call) => call.url), ["https://api-m.sandbox.paypal.com/v1/oauth2/token", "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O1"]);
  assert.equal(sandbox.calls[0].headers.authorization, `Basic ${Buffer.from(`client-id-${runCount}:client-secret`).toString("base64")}`);
  assert.equal(sandbox.calls[1].headers.authorization, "Bearer A21-test-token");
  const live = await run("get_order", { order_id: "5O1" }, { environment: { PAYPAL_ENV: "live" } });
  assert.deepEqual(live.calls.map((call) => call.url), ["https://api-m.paypal.com/v1/oauth2/token", "https://api-m.paypal.com/v2/checkout/orders/5O1"]);
  await assert.rejects(run("get_order", { order_id: "5O1" }, { environment: { PAYPAL_ENV: "production" } }), (error) => error.kind === "invalid_input" && error.message.includes("PAYPAL_ENV"));
});

test("create_order as a tool needs the opt-in, a positive cap and listed currencies", async () => {
  await assert.rejects(run("create_order", { purchase_units: units("10.00") }), isDenied("PAYPAL_TOOL_ALLOW_ORDERS"));
  await assert.rejects(run("create_order", { purchase_units: units("10.00") }, { environment: { ...optedIn, PAYPAL_TOOL_ALLOWED_CURRENCIES: "USD" } }), isDenied("PAYPAL_TOOL_MAX_AMOUNT"));
  const environment = { ...optedIn, PAYPAL_TOOL_MAX_AMOUNT: "50", PAYPAL_TOOL_ALLOWED_CURRENCIES: "USD,EUR" };
  await assert.rejects(run("create_order", { purchase_units: [...units("30.00"), ...units("20.01")] }, { environment }), isDenied("over PAYPAL_TOOL_MAX_AMOUNT=50"));
  await assert.rejects(run("create_order", { purchase_units: units("10.00", "GBP") }, { environment }), isDenied("GBP"));
  await assert.rejects(run("create_order", { purchase_units: [{ amount: { currency_code: "USD", value: "-1" } }] }, { environment }), isDenied("decimal string"));
  await assert.rejects(run("create_order", { purchase_units: [{ description: "no amount" }] }, { environment }), isDenied("not a positive number"));
  const { calls } = await run("create_order", { purchase_units: [...units("30.00"), ...units("20.00", "EUR")] }, { environment });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers["paypal-request-id"]?.length, 36);
});

test("workflow nodes create orders without the cap", async () => {
  const { calls } = await run("create_order", { purchase_units: units("99999.00", "JPY") }, { source: "node" });
  assert.equal(calls.length, 2);
});

test("captures, authorizations, refunds, invoice sending and payouts are node only", () => {
  const nodeOnlyNames = ["capture_order", "authorize_order", "refund_capture", "capture_authorization", "void_authorization", "send_invoice", "create_payout", "get_payout_batch"];
  for (const operationName of nodeOnlyNames) {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly, true, operationName);
  }
});

test("PayPal error details are shown and mapped", async () => {
  await assert.rejects(
    run("get_order", { order_id: "x" }, { responses: [{ status: 404, body: { name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist.", details: [{ issue: "INVALID_RESOURCE_ID", description: "Specified resource ID does not exist." }] } }] }),
    (error) => error.kind === "not_found" && error.message.includes("Specified resource ID does not exist."),
  );
});

test("api_request as a tool only reaches allowlisted read paths", async () => {
  for (const blockedPath of ["/v3/vault/payment-tokens", "/v1/notifications/webhooks", "/v1/identity/oauth2/userinfo", "/v1/payments/payouts/PB1"]) {
    await assert.rejects(run("api_request", { path: blockedPath }), isDenied("api_request cannot reach"), blockedPath);
  }
  const { calls } = await run("api_request", { path: "/v1/reporting/balances" }, { responses: [{ body: {} }] });
  assert.equal(calls.length, 2);
});
