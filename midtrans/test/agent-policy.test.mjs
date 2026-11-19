import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { describeBodyStatusError } from "../lib/body-status-errors.mjs";
import { pluginDefinition } from "../definition.mjs";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ status: 201, body: { token: "t" } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { MIDTRANS_SERVER_KEY: "SB-Mid-server-fake", ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const snapArgs = { order_id: "ORDER-9", gross_amount: 150000 };
const optedIn = { MIDTRANS_TOOL_ALLOW_PAYMENTS: "1" };
const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);

test("MIDTRANS_ENV picks sandbox (default) or production hosts and rejects anything else", async () => {
  const sandbox = await run("get_transaction_status", { order_id: "A" }, { responses: [{ body: { status_code: "200" } }] });
  assert.equal(sandbox.calls[0].url, "https://api.sandbox.midtrans.com/v2/A/status");
  const production = await run("create_snap_transaction", snapArgs, { source: "node", environment: { MIDTRANS_ENV: "production" } });
  assert.equal(production.calls[0].url, "https://app.midtrans.com/snap/v1/transactions");
  await assert.rejects(run("get_transaction_status", { order_id: "A" }, { environment: { MIDTRANS_ENV: "live" } }), (error) => error.kind === "invalid_input" && error.message.includes("MIDTRANS_ENV"));
});

test("the server key is the Basic user with an empty password", async () => {
  const { calls } = await run("get_transaction_status", { order_id: "A" }, { responses: [{ body: { status_code: "200" } }] });
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("SB-Mid-server-fake:").toString("base64")}`);
});

test("create_snap_transaction as a tool needs the opt-in, then a positive MIDTRANS_TOOL_MAX_AMOUNT", async () => {
  await assert.rejects(run("create_snap_transaction", snapArgs), isDenied("MIDTRANS_TOOL_ALLOW_PAYMENTS"));
  await assert.rejects(run("create_snap_transaction", snapArgs, { environment: optedIn }), isDenied("MIDTRANS_TOOL_MAX_AMOUNT"));
  await assert.rejects(run("create_snap_transaction", snapArgs, { environment: { ...optedIn, MIDTRANS_TOOL_MAX_AMOUNT: "0" } }), isDenied("MIDTRANS_TOOL_MAX_AMOUNT"));
  await assert.rejects(run("create_snap_transaction", snapArgs, { environment: { ...optedIn, MIDTRANS_TOOL_MAX_AMOUNT: "100000" } }), isDenied("over MIDTRANS_TOOL_MAX_AMOUNT=100000"));
  const { calls } = await run("create_snap_transaction", snapArgs, { environment: { ...optedIn, MIDTRANS_TOOL_MAX_AMOUNT: "150000" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["idempotency-key"], undefined);
  assert.equal(calls[0].headers["x-override-notification"], undefined);
});

test("Core API writes are node only and send an Idempotency-Key", async () => {
  for (const operationName of ["cancel_transaction", "expire_transaction", "refund_transaction", "direct_refund_transaction", "approve_transaction", "deny_transaction", "capture_transaction"]) {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly, true, operationName);
  }
  const { calls } = await run("cancel_transaction", { order_id: "A" }, { source: "node", responses: [{ body: { status_code: "200" } }] });
  assert.equal(calls[0].headers["idempotency-key"]?.length, 36);
});

test("body status_code errors on HTTP 200 become PluginErrors", async () => {
  await assert.rejects(
    run("get_transaction_status", { order_id: "A" }, { responses: [{ body: { status_code: "404", status_message: "Transaction doesn't exist." } }] }),
    (error) => error.kind === "not_found" && error.message.includes("Transaction doesn't exist."),
  );
  await assert.rejects(
    run("refund_transaction", { order_id: "A", amount: 5 }, { source: "node", responses: [{ body: { status_code: "412", status_message: "Merchant cannot modify the status of the transaction" } }] }),
    (error) => error.kind === "invalid_input" && error.retryable === false,
  );
  const expired = await run("expire_transaction", { order_id: "A" }, { source: "node", responses: [{ body: { status_code: "407", transaction_status: "expire" } }] });
  assert.equal(expired.result.data.transaction_status, "expire");
});

test("describeBodyStatusError: 5xx in a write body is outcome unknown and not retryable", () => {
  const writeError = describeBodyStatusError({ status_code: "500", status_message: "Internal" }, ["200"], true);
  assert.equal(writeError.retryable, false);
  assert.match(writeError.message, /outcome unknown/);
  assert.equal(describeBodyStatusError({ status_code: "503" }, ["200"], false).retryable, true);
  assert.equal(describeBodyStatusError({ status_code: "201" }, ["200"], false), null);
  assert.equal(describeBodyStatusError({ token: "x" }, ["200"], true), null);
  assert.equal(describeBodyStatusError({ status_code: "401" }, ["200"], false).kind, "auth_error");
});

test("Snap errors show error_messages", async () => {
  await assert.rejects(
    run("create_snap_transaction", snapArgs, { source: "node", responses: [{ status: 400, body: { error_messages: ["transaction_details.order_id has already been taken"] } }] }),
    (error) => error.kind === "invalid_input" && error.message.includes("already been taken"),
  );
});

test("api_request as a tool only reaches status reads", async () => {
  await assert.rejects(run("api_request", { path: "/v1/payment-links" }), isDenied("api_request cannot reach"));
  await assert.rejects(run("api_request", { path: "/v2/A/status/../../v1/accounts" }), isDenied("api_request cannot reach"));
  const { calls } = await run("api_request", { path: "/v2/A/status" }, { responses: [{ body: { status_code: "200" } }] });
  assert.equal(calls.length, 1);
});
