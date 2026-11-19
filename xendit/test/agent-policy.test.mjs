import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: { id: "inv_1" } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { XENDIT_SECRET_KEY: "xnd_development_fake", ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const invoiceArgs = { external_id: "INV-9", amount: 250000 };
const optedIn = { XENDIT_TOOL_ALLOW_INVOICES: "1" };
const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);

test("create_invoice as a tool needs the opt-in, a positive cap and an allowed currency", async () => {
  await assert.rejects(run("create_invoice", invoiceArgs), isDenied("XENDIT_TOOL_ALLOW_INVOICES"));
  await assert.rejects(run("create_invoice", invoiceArgs, { environment: { ...optedIn, XENDIT_TOOL_ALLOWED_CURRENCIES: "IDR" } }), isDenied("XENDIT_TOOL_MAX_AMOUNT"));
  await assert.rejects(run("create_invoice", invoiceArgs, { environment: { ...optedIn, XENDIT_TOOL_MAX_AMOUNT: "1000000" } }), isDenied("XENDIT_TOOL_ALLOWED_CURRENCIES"));
  const environment = { ...optedIn, XENDIT_TOOL_MAX_AMOUNT: "200000", XENDIT_TOOL_ALLOWED_CURRENCIES: "IDR" };
  await assert.rejects(run("create_invoice", invoiceArgs, { environment }), isDenied("over XENDIT_TOOL_MAX_AMOUNT=200000"));
  await assert.rejects(run("create_invoice", { ...invoiceArgs, amount: 100, currency: "USD" }, { environment }), isDenied("USD"));
  const { calls } = await run("create_invoice", { ...invoiceArgs, amount: 200000 }, { environment });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].json.currency, "IDR");
});

test("workflow nodes create invoices without the cap", async () => {
  const { calls } = await run("create_invoice", { ...invoiceArgs, amount: 999999999 }, { source: "node" });
  assert.equal(calls.length, 1);
});

test("money-moving operations are node only; refunds and payouts carry an idempotency-key", async () => {
  for (const operationName of ["expire_invoice", "create_payment_request", "create_refund", "create_payout", "get_payout"]) {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly, true, operationName);
  }
  const { calls } = await run("create_refund", { invoice_id: "inv_1", reason: "OTHERS" }, { source: "node" });
  assert.equal(calls[0].headers["idempotency-key"]?.length, 36);
  const invoice = await run("create_invoice", invoiceArgs, { source: "node" });
  assert.equal(invoice.calls[0].headers["idempotency-key"], undefined);
});

test("the secret key is the Basic user with an empty password", async () => {
  const { calls } = await run("get_balance", {}, { responses: [{ body: { balance: 1 } }] });
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("xnd_development_fake:").toString("base64")}`);
});

test("Xendit error codes map to kinds", async () => {
  await assert.rejects(run("get_invoice", { invoice_id: "x" }, { responses: [{ status: 401, body: { error_code: "INVALID_API_KEY", message: "API key is not authorized for this API service" } }] }), (error) => error.kind === "auth_error");
  await assert.rejects(run("get_invoice", { invoice_id: "x" }, { responses: [{ status: 404, body: { error_code: "INVOICE_NOT_FOUND_ERROR", message: "Could not find invoice" } }] }), (error) => error.kind === "not_found");
});

test("api_request as a tool only reaches allowlisted read paths", async () => {
  for (const blockedPath of ["/v3/payouts/po_1", "/v3/payment_tokens", "/customers", "/v2/invoices/../../v3/payment_tokens"]) {
    await assert.rejects(run("api_request", { path: blockedPath }), isDenied("api_request cannot reach"), blockedPath);
  }
  const { calls } = await run("api_request", { path: "/transactions/txn_1" });
  assert.equal(calls.length, 1);
});
