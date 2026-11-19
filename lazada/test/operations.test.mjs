import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { computeLazadaSignature } from "../lib/signing.mjs";
import { detectLazadaBodyError } from "../lib/client.mjs";
import { nextOffsetCursor } from "../operations/reads.mjs";
import { pluginDefinition } from "../definition.mjs";

const ENVIRONMENT = { LAZADA_APP_KEY: "123456", LAZADA_APP_SECRET: "app-secret-for-tests", LAZADA_ACCESS_TOKEN: "seller-access-token", LAZADA_REGION: "id" };
const ok = (data = {}) => ({ body: { code: "0", data, request_id: "R1" } });
const NODE_ONLY = ["update_price_quantity", "update_sellable_stock", "pack_order", "ready_to_ship"];

async function run(operationName, args, { responses = [ok()], environment = ENVIRONMENT, source } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const callSource = source ?? (NODE_ONLY.includes(operationName) ? "node" : "tool");
  return { output: await runner(operationName, args, { source: callSource }), calls: recordingFetch.calls };
}

function assertSigned(call, apiPath, formParameters = {}) {
  const { sign, ...queryParameters } = call.query;
  assert.equal(queryParameters.app_key, "123456");
  assert.equal(queryParameters.sign_method, "sha256");
  assert.equal(queryParameters.access_token, "seller-access-token");
  assert.match(queryParameters.timestamp, /^\d{13}$/);
  assert.equal(sign, computeLazadaSignature("app-secret-for-tests", apiPath, { ...queryParameters, ...formParameters }));
}

const READ_CASES = [
  ["get_seller", {}, "/seller/get", {}],
  ["list_products", { filter: "live", limit: 10, seller_skus: ["A", "B"] }, "/products/get", { filter: "live", offset: "0", limit: "10", sku_seller_list: '["A","B"]' }],
  ["get_product", { item_id: 77 }, "/product/item/get", { item_id: "77" }],
  ["list_orders", { created_after: "2026-11-01T00:00:00+07:00", status: "pending" }, "/orders/get", { created_after: "2026-11-01T00:00:00+07:00", status: "pending", sort_by: "created_at", sort_direction: "DESC", offset: "0", limit: "50" }],
  ["get_order", { order_id: 9 }, "/order/get", { order_id: "9" }],
  ["get_order_items", { order_id: 9 }, "/order/items/get", { order_id: "9" }],
  ["get_multiple_order_items", { order_ids: [9, 10] }, "/orders/items/get", { order_ids: "[9,10]" }],
];

for (const [operationName, args, apiPath, businessQuery] of READ_CASES) {
  test(`${operationName} sends a signed GET to ${apiPath} on the regional gateway`, async () => {
    const { calls } = await run(operationName, args);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].url.split("?")[0], `https://api.lazada.co.id/rest${apiPath}`);
    const { app_key: _appKey, timestamp: _timestamp, sign_method: _signMethod, access_token: _accessToken, sign: _sign, ...rest } = calls[0].query;
    assert.deepEqual(rest, businessQuery);
    assertSigned(calls[0], apiPath);
  });
}

const WRITE_CASES = [
  ["update_price_quantity", { skus: [{ item_id: 1, sku_id: 2, price: 15000, quantity: 3 }] }, "/product/price_quantity/update", { payload: '<?xml version="1.0" encoding="UTF-8"?><Request><Product><Skus><Sku><ItemId>1</ItemId><SkuId>2</SkuId><Price>15000</Price><Quantity>3</Quantity></Sku></Skus></Product></Request>' }],
  ["update_sellable_stock", { skus: [{ seller_sku: "K1", sellable_quantity: 8 }] }, "/product/stock/sellable/update", { payload: '<?xml version="1.0" encoding="UTF-8"?><Request><Product><Skus><Sku><SellerSku>K1</SellerSku><SellableQuantity>8</SellableQuantity></Sku></Skus></Product></Request>' }],
  ["pack_order", { pack_request: { pack_order_list: [{ order_id: 9 }], delivery_type: "dropship" } }, "/order/fulfill/pack", { packReq: '{"pack_order_list":[{"order_id":9}],"delivery_type":"dropship"}' }],
  ["ready_to_ship", { ready_to_ship_request: { packages: [{ package_id: "FP1" }] } }, "/order/package/rts", { readyToShipReq: '{"packages":[{"package_id":"FP1"}]}' }],
];

for (const [operationName, args, apiPath, form] of WRITE_CASES) {
  test(`${operationName} is node only and POSTs a signed form to ${apiPath}`, async () => {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly, true);
    const { calls } = await run(operationName, args);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url.split("?")[0], `https://api.lazada.co.id/rest${apiPath}`);
    assert.equal(calls[0].headers["content-type"], "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), form);
    assertSigned(calls[0], apiPath, form);
  });
}

test("node-only writes are not in the tool manifest and are refused for tools", async () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("list_orders"), true);
  for (const operationName of NODE_ONLY) assert.equal(toolNames.includes(operationName), false, operationName);
  await assert.rejects(run("update_price_quantity", { skus: [{ seller_sku: "a", price: 1 }] }, { source: "tool" }), (error) => error.kind === "invalid_input");
});

test("writes are not retried after a 5xx and say the outcome is unknown", async () => {
  await assert.rejects(run("pack_order", { pack_request: {} }, { responses: [{ status: 502, body: {} }, ok()] }), (error) => /outcome unknown/.test(error.message) && error.retryable === false);
});

test("LAZADA_REGION picks the gateway and is required", async () => {
  const { calls } = await run("get_seller", {}, { environment: { ...ENVIRONMENT, LAZADA_REGION: "VN" } });
  assert.equal(calls[0].url.split("?")[0], "https://api.lazada.vn/rest/seller/get");
  await assert.rejects(run("get_seller", {}, { environment: { ...ENVIRONMENT, LAZADA_REGION: "" } }), (error) => error.kind === "invalid_input" && error.message.includes("LAZADA_REGION"));
  await assert.rejects(run("get_seller", {}, { environment: { ...ENVIRONMENT, LAZADA_REGION: "us" } }), (error) => error.kind === "invalid_input");
});

test("missing credentials are auth_error; a non-numeric app key is invalid_input", async () => {
  await assert.rejects(run("get_seller", {}, { environment: { ...ENVIRONMENT, LAZADA_APP_SECRET: "" } }), (error) => error.kind === "auth_error" && error.message.includes("LAZADA_APP_SECRET"));
  await assert.rejects(run("get_seller", {}, { environment: { ...ENVIRONMENT, LAZADA_APP_KEY: "abc" } }), (error) => error.kind === "invalid_input");
});

test("Lazada error envelopes on HTTP 200 map to kinds and never leak the secret or token", async () => {
  const echo = { body: { type: "ISV", code: "IllegalAccessToken", message: "invalid token seller-access-token / app-secret-for-tests", request_id: "R9" } };
  await assert.rejects(run("get_seller", {}, { responses: [echo] }), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.equal(error.message.includes("seller-access-token"), false);
    assert.equal(error.message.includes("app-secret-for-tests"), false);
    assert.match(error.message, /IllegalAccessToken, request_id R9/);
    return true;
  });
  await assert.rejects(run("get_order", { order_id: 1 }, { responses: [{ body: { type: "ISV", code: "ApiCallLimit", message: "limit" } }, { body: { type: "ISV", code: "ApiCallLimit", message: "limit" } }, { body: { type: "ISV", code: "ApiCallLimit", message: "limit" } }] }), (error) => error.kind === "rate_limited");
});

test("detectLazadaBodyError: success, missing envelope and server failures", () => {
  assert.equal(detectLazadaBodyError({ code: "0", data: {} }, { isRead: true }), null);
  assert.equal(detectLazadaBodyError({ text: "<html>" }, { isRead: true }).kind, "api_error");
  assert.match(detectLazadaBodyError({ data: {} }, { isRead: false }).message, /outcome unknown/);
  assert.equal(detectLazadaBodyError({ type: "SYSTEM", code: "ServiceTimeout", message: "x" }, { isRead: true }).retryable, true);
  const writeFailure = detectLazadaBodyError({ type: "ISP", code: "ServiceUnavailable", message: "x" }, { isRead: false });
  assert.equal(writeFailure.retryable, false);
  assert.match(writeFailure.message, /outcome unknown/);
  assert.equal(detectLazadaBodyError({ type: "ISV", code: "E0001", message: "bad" }, { isRead: false }).kind, "invalid_input");
  assert.equal(detectLazadaBodyError({ type: "ISV", code: "InsufficientPermission", message: "x" }, { isRead: true }).kind, "permission_denied");
});

test("list operations page by offset", async () => {
  const products = Array.from({ length: 10 }, (_, index) => ({ item_id: index }));
  const firstPage = await run("list_products", { limit: 10 }, { responses: [ok({ total_products: 25, products })] });
  assert.equal(firstPage.output.next_cursor, "10");
  const secondPage = await run("list_products", { limit: 10, cursor: "10" }, { responses: [ok({ total_products: 25, products })] });
  assert.equal(secondPage.calls[0].query.offset, "10");
  assert.equal(nextOffsetCursor(20, 5, 10, 25), null);
  assert.equal(nextOffsetCursor(10, 10, 10, 20), null);
  await assert.rejects(run("list_products", { cursor: "abc" }), (error) => error.kind === "invalid_input");
  await assert.rejects(run("list_orders", {}), (error) => error.kind === "invalid_input" && error.message.includes("created_after"));
});

test("api_request is GET-only for tools, signs other paths, and refuses odd paths", async () => {
  await assert.rejects(run("api_request", { method: "POST", path: "/order/cancel" }), (error) => error.kind === "permission_denied");
  const { calls } = await run("api_request", { path: "/finance/transaction/details/get", query: { start_time: "2026-11-01", limit: 10 } });
  assert.equal(calls[0].query.start_time, "2026-11-01");
  assertSigned(calls[0], "/finance/transaction/details/get");
  await assert.rejects(run("api_request", { path: "/orders/get?x=1" }, { source: "node" }), (error) => error.kind === "invalid_input");
  await assert.rejects(run("api_request", { path: "/../auth/token/create" }, { source: "node" }), (error) => error.kind === "invalid_input");
});
