import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { normalizeCurrencies } from "../lib/order-shape-policy.mjs";
import { pluginDefinition } from "../definition.mjs";

const TOKEN_RESPONSE = { body: { access_token: "A21-test-token", token_type: "Bearer", expires_in: 32400 } };
// Tokens are cached per client id, so every run gets its own client id and fetches a token first.
let runCount = 0;

async function run(operationName, args, { source = "tool", environment = {} } = {}) {
  const recordingFetch = createRecordingFetch([TOKEN_RESPONSE, { status: 201, body: { id: "5O1" } }]);
  const credentials = { PAYPAL_CLIENT_ID: `shape-client-${(runCount += 1)}`, PAYPAL_CLIENT_SECRET: "client-secret" };
  const runner = createOperationRunner(pluginDefinition, { ...credentials, ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const orderEnvironment = { PAYPAL_TOOL_ALLOW_ORDERS: "1", PAYPAL_TOOL_MAX_AMOUNT: "100", PAYPAL_TOOL_ALLOWED_CURRENCIES: "USD" };
const usd = (value) => ({ currency_code: "USD", value });
const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);

test("agent orders may not redirect funds: payee, payment_instruction and unknown keys are refused at any depth", async () => {
  const refusedUnits = [
    [{ amount: usd("10.00"), payee: { merchant_id: "ATTACKER" } }, "purchase_units[0].payee"],
    [{ amount: usd("10.00"), payment_instruction: { platform_fees: [{ amount: usd("9.00"), payee: { email_address: "x@evil.example" } }] } }, "purchase_units[0].payment_instruction"],
    [{ amount: { ...usd("10.00"), payee: {} } }, "amount.payee"],
    [{ amount: { ...usd("10.00"), breakdown: { item_total: usd("10.00"), payee: {} } } }, "breakdown.payee"],
    [{ amount: usd("10.00"), items: [{ name: "x", quantity: "1", unit_amount: usd("10.00"), payee: {} }] }, "items[0].payee"],
    [{ amount: usd("10.00"), shipping: { address: { country_code: "US", payee: "x" } } }, "address.payee"],
    [{ amount: usd("10.00"), supplementary_data: {} }, "supplementary_data"],
  ];
  for (const [unit, fragment] of refusedUnits) {
    await assert.rejects(run("create_order", { purchase_units: [unit] }, { environment: orderEnvironment }), isDenied(fragment), fragment);
  }
});

test("without the opt-in the refusal still names PAYPAL_TOOL_ALLOW_ORDERS", async () => {
  await assert.rejects(run("create_order", { purchase_units: [{ amount: usd("1.00"), payee: {} }] }), isDenied("PAYPAL_TOOL_ALLOW_ORDERS"));
});

test("workflow nodes may still set payee (marketplaces), and currencies are uppercased for them too", async () => {
  const { calls } = await run("create_order", { purchase_units: [{ amount: { currency_code: " usd", value: "1.00" }, payee: { merchant_id: "M1" } }] }, { source: "node" });
  assert.deepEqual(calls[1].json.purchase_units[0], { amount: { currency_code: "USD", value: "1.00" }, payee: { merchant_id: "M1" } });
});

test("agent orders accept the allowlisted purchase-unit shape", async () => {
  const unit = {
    reference_id: "o-1",
    description: "Kopi",
    custom_id: "c",
    invoice_id: "i",
    soft_descriptor: "KOPI",
    amount: { currency_code: "usd", value: "12.50", breakdown: { item_total: usd("10.00"), shipping: usd("2.50") } },
    items: [{ name: "Kopi", quantity: "1", sku: "K1", unit_amount: usd("10.00") }],
    shipping: { type: "SHIPPING", name: { full_name: "Ana" }, address: { address_line_1: "Jl. 1", admin_area_2: "Jakarta", postal_code: "10110", country_code: "ID" } },
  };
  const { calls } = await run("create_order", { purchase_units: [unit] }, { environment: orderEnvironment });
  assert.equal(calls[1].json.purchase_units[0].amount.currency_code, "USD");
});

test("agent order amounts must be plain decimal strings", async () => {
  for (const value of ["1e3", "10.0001", " 10", "-1", "0x10", "1,000.00"]) {
    await assert.rejects(run("create_order", { purchase_units: [{ amount: usd(value) }] }, { environment: orderEnvironment }), (error) => error.kind === "permission_denied", value);
  }
});

test("return and cancel URLs must be https, and in PAYPAL_TOOL_ALLOWED_RETURN_HOSTS for agents when set", async () => {
  await assert.rejects(run("create_order", { purchase_units: [{ amount: usd("1.00") }], return_url: "http://shop.example/r" }, { source: "node" }), (error) => error.kind === "invalid_input");
  const environment = { ...orderEnvironment, PAYPAL_TOOL_ALLOWED_RETURN_HOSTS: "shop.example" };
  await assert.rejects(run("create_order", { purchase_units: [{ amount: usd("1.00") }], cancel_url: "https://evil.example/c" }, { environment }), isDenied("PAYPAL_TOOL_ALLOWED_RETURN_HOSTS"));
  const { calls } = await run("create_order", { purchase_units: [{ amount: usd("1.00") }], return_url: "https://Shop.example/r" }, { environment });
  assert.equal(calls.length, 2);
});

test("agent draft invoices are capped by item totals and limited to known item keys", async () => {
  const environment = { PAYPAL_TOOL_ALLOW_INVOICES: "1", PAYPAL_TOOL_MAX_AMOUNT: "100", PAYPAL_TOOL_ALLOWED_CURRENCIES: "USD" };
  const item = (value, quantity) => ({ name: "Kopi", quantity, unit_amount: usd(value) });
  await assert.rejects(run("create_invoice", { currency_code: "USD", items: [item("60.00", "2")] }, { environment }), isDenied("over PAYPAL_TOOL_MAX_AMOUNT=100"));
  await assert.rejects(run("create_invoice", { currency_code: "USD", items: [{ ...item("1.00", "1"), discount: {} }] }, { environment }), isDenied("items[0].discount"));
  const euro = { name: "x", quantity: "1", unit_amount: { currency_code: "EUR", value: "1.00" } };
  await assert.rejects(run("create_invoice", { currency_code: "USD", items: [item("1.00", "1"), euro] }, { environment }), isDenied("EUR"));
  const { calls } = await run("create_invoice", { currency_code: "USD", items: [item("25.00", "4")] }, { environment });
  assert.equal(calls.length, 2);
});

test("normalizeCurrencies trims and uppercases currency fields at any depth", () => {
  assert.deepEqual(normalizeCurrencies([{ amount: { currency_code: " eur ", value: "1" }, items: [{ currency: "usd" }] }]), [{ amount: { currency_code: "EUR", value: "1" }, items: [{ currency: "USD" }] }]);
});
