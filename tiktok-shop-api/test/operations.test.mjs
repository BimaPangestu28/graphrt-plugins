import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedSignature, OPEN_API_ORIGIN, runExpectingError, runWithResponses, TEST_ENVIRONMENT, tiktokShopOk } from "./helpers.mjs";

const PRODUCT_ID = "1729592969712207008";
const SKU_ID = "1729592969712207013";
const PACKAGE_ID = "5433567853345";
const CONVERSATION_ID = "7494560109732334261";

// Each case: operation + args → expected single request (method, path, shop_cipher presence, query subset, JSON body).
const OPERATION_CASES = [
  ["get_authorized_shops", {}, { method: "GET", path: "/authorization/202309/shops", shopCipher: false }],
  [
    "search_products",
    { status: "ACTIVATE", limit: 50, cursor: "tok1", update_time_ge: 1763424000 },
    { method: "POST", path: "/product/202502/products/search", query: { page_size: "50", page_token: "tok1" }, json: { status: "ACTIVATE", update_time_ge: 1763424000 } },
  ],
  ["search_products", {}, { method: "POST", path: "/product/202502/products/search", query: { page_size: "20" }, json: { status: "ALL" } }],
  ["get_product", { product_id: PRODUCT_ID, locale: "id-ID" }, { method: "GET", path: `/product/202309/products/${PRODUCT_ID}`, query: { locale: "id-ID" } }],
  [
    "update_inventory",
    { product_id: PRODUCT_ID, skus: [{ sku_id: SKU_ID, quantity: 25 }] },
    { method: "POST", path: `/product/202309/products/${PRODUCT_ID}/inventory/update`, json: { skus: [{ id: SKU_ID, inventory: [{ quantity: 25 }] }] } },
  ],
  [
    "update_inventory",
    { product_id: PRODUCT_ID, skus: [{ sku_id: SKU_ID, quantity: 0, warehouse_id: "7068517275539719942" }, { sku_id: SKU_ID, quantity: "3", warehouse_id: "7068517275539719943" }] },
    {
      method: "POST",
      path: `/product/202309/products/${PRODUCT_ID}/inventory/update`,
      json: { skus: [{ id: SKU_ID, inventory: [{ warehouse_id: "7068517275539719942", quantity: 0 }, { warehouse_id: "7068517275539719943", quantity: 3 }] }] },
    },
  ],
  [
    "update_price",
    { product_id: PRODUCT_ID, currency: "IDR", skus: [{ sku_id: SKU_ID, amount: 150000 }] },
    { method: "POST", path: `/product/202309/products/${PRODUCT_ID}/prices/update`, json: { skus: [{ id: SKU_ID, price: { amount: "150000", currency: "IDR" } }] } },
  ],
  [
    "search_orders",
    { order_status: "AWAITING_SHIPMENT", create_time_ge: 1763424000, create_time_lt: 1763510400, limit: 10, sort_order: "ASC" },
    {
      method: "POST",
      path: "/order/202309/orders/search",
      query: { page_size: "10", sort_order: "ASC" },
      json: { order_status: "AWAITING_SHIPMENT", create_time_ge: 1763424000, create_time_lt: 1763510400 },
    },
  ],
  ["get_order_detail", { order_ids: ["576461413038785752", "576461413038785753"] }, { method: "GET", path: "/order/202507/orders", query: { ids: "576461413038785752,576461413038785753" } }],
  [
    "get_package_shipping_document",
    { package_id: PACKAGE_ID },
    { method: "GET", path: `/fulfillment/202309/packages/${PACKAGE_ID}/shipping_documents`, query: { document_type: "SHIPPING_LABEL" } },
  ],
  [
    "ship_package",
    { package_id: PACKAGE_ID, handover_method: "PICKUP", pickup_slot: { start_time: 1763424000, end_time: 1763427600 } },
    { method: "POST", path: `/fulfillment/202309/packages/${PACKAGE_ID}/ship`, json: { handover_method: "PICKUP", pickup_slot: { start_time: 1763424000, end_time: 1763427600 } } },
  ],
  ["ship_package", { package_id: PACKAGE_ID }, { method: "POST", path: `/fulfillment/202309/packages/${PACKAGE_ID}/ship`, json: {} }],
  [
    "search_returns",
    { order_ids: ["577686530908261117"], return_status: ["RETURN_OR_REFUND_REQUEST_PENDING"] },
    {
      method: "POST",
      path: "/return_refund/202602/returns/search",
      query: { page_size: "20" },
      json: { order_ids: ["577686530908261117"], return_status: ["RETURN_OR_REFUND_REQUEST_PENDING"] },
    },
  ],
  ["get_conversations", { limit: 5, cursor: "1612356123" }, { method: "GET", path: "/customer_service/202309/conversations", query: { page_size: "5", page_token: "1612356123" } }],
  [
    "get_conversation_messages",
    { conversation_id: CONVERSATION_ID },
    { method: "GET", path: `/customer_service/202309/conversations/${CONVERSATION_ID}/messages`, query: { page_size: "10", sort_order: "DESC" } },
  ],
  [
    "send_message",
    { conversation_id: CONVERSATION_ID, text: "Halo kak, paket sudah dikirim" },
    { method: "POST", path: `/customer_service/202606/conversations/${CONVERSATION_ID}/messages`, json: { type: "TEXT", content: '{"content":"Halo kak, paket sudah dikirim"}' } },
  ],
  [
    "send_message",
    { conversation_id: CONVERSATION_ID, type: "ORDER_CARD", content: { order_id: "580874485811283206" } },
    { method: "POST", path: `/customer_service/202606/conversations/${CONVERSATION_ID}/messages`, json: { type: "ORDER_CARD", content: '{"order_id":"580874485811283206"}' } },
  ],
  ["api_request", { path: "/logistics/202309/warehouses" }, { method: "GET", path: "/logistics/202309/warehouses" }],
  [
    "api_request",
    { path: "/seller/202309/shops", include_shop_cipher: false, query: { extra: ["a", "b"] } },
    { method: "GET", path: "/seller/202309/shops", shopCipher: false, query: { extra: "a,b" } },
  ],
  [
    "api_request",
    { method: "POST", path: "/event/202309/webhooks", body: { address: "https://example.com/hook", event_type: "PACKAGE_UPDATE" } },
    { method: "POST", path: "/event/202309/webhooks", json: { address: "https://example.com/hook", event_type: "PACKAGE_UPDATE" }, source: "node" },
  ],
  [
    "update_price",
    { product_id: PRODUCT_ID, currency: "USD", skus: [{ sku_id: SKU_ID, amount: "19.99" }] },
    { method: "POST", path: `/product/202309/products/${PRODUCT_ID}/prices/update`, json: { skus: [{ id: SKU_ID, price: { amount: "19.99", currency: "USD" } }] } },
  ],
];

for (const [operationName, args, expectedRequest] of OPERATION_CASES) {
  test(`${operationName} ${JSON.stringify(args).slice(0, 100)} sends a signed ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args, [tiktokShopOk()], TEST_ENVIRONMENT, expectedRequest.source);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(new URL(call.url).origin, OPEN_API_ORIGIN);
    assert.equal(call.path, expectedRequest.path);
    assertCommonParameters(call, expectedRequest.shopCipher !== false);
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
    if (expectedRequest.method === "GET") assert.equal(call.body, undefined);
  });
}

function assertCommonParameters(call, expectsShopCipher) {
  assert.equal(call.query.app_key, TEST_ENVIRONMENT.TIKTOK_SHOP_APP_KEY);
  assert.match(call.query.timestamp, /^\d{10}$/);
  assert.ok(Math.abs(Number(call.query.timestamp) - Date.now() / 1000) < 60, "timestamp is current Unix seconds");
  assert.equal(call.query.shop_cipher, expectsShopCipher ? TEST_ENVIRONMENT.TIKTOK_SHOP_CIPHER : undefined);
  assert.equal(call.query.access_token, undefined, "the token never goes in the query");
  assert.equal(call.headers["x-tts-access-token"], TEST_ENVIRONMENT.TIKTOK_SHOP_ACCESS_TOKEN);
  assert.equal(call.headers["content-type"], "application/json");
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.query.sign, expectedSignature(call), "sign covers path, sorted query and the exact body");
}

test("search_orders maps next_page_token to next_cursor and null on the last page", async () => {
  const { output } = await runWithResponses("search_orders", {}, [tiktokShopOk({ orders: [{ id: "1" }], next_page_token: "p2", total_count: 3 })]);
  assert.deepEqual(output, { data: [{ id: "1" }], next_cursor: "p2" });
  const { output: lastPage } = await runWithResponses("search_orders", { cursor: "p2" }, [tiktokShopOk({ orders: [], next_page_token: "" })]);
  assert.equal(lastPage.next_cursor, null);
});

for (const [operationName, args, listKey] of [
  ["search_products", {}, "products"],
  ["search_returns", {}, "return_orders"],
  ["get_conversations", {}, "conversations"],
  ["get_conversation_messages", { conversation_id: CONVERSATION_ID }, "messages"],
]) {
  test(`${operationName} returns data.${listKey} and its page token`, async () => {
    const { output } = await runWithResponses(operationName, args, [tiktokShopOk({ [listKey]: [{ id: "x" }], next_page_token: "n" })]);
    assert.deepEqual(output, { data: [{ id: "x" }], next_cursor: "n" });
  });
}

test("api_request POST called as an agent tool is refused before any request", async () => {
  const args = { method: "POST", path: "/event/202309/webhooks", body: { address: "https://example.com/hook" } };
  const { error, calls } = await runExpectingError("api_request", args, [tiktokShopOk()], TEST_ENVIRONMENT, "tool");
  assert.equal(error.kind, "permission_denied");
  assert.equal(calls.length, 0);
});

for (const [operationName, args, listKey] of [
  ["search_orders", {}, "orders"],
  ["search_products", {}, "products"],
  ["search_returns", {}, "return_orders"],
  ["get_conversations", {}, "conversations"],
  ["get_conversation_messages", { conversation_id: CONVERSATION_ID }, "messages"],
]) {
  test(`${operationName} stops paging when next_page_token repeats the cursor`, async () => {
    const { output } = await runWithResponses(operationName, { ...args, cursor: "same" }, [tiktokShopOk({ [listKey]: [{ id: "x" }], next_page_token: "same" })]);
    assert.equal(output.next_cursor, null);
  });
}

test("get_authorized_shops returns the shops with their ciphers", async () => {
  const shops = [{ id: "7000714532876273420", cipher: "GCP_XF90", region: "ID" }];
  const { output } = await runWithResponses("get_authorized_shops", {}, [tiktokShopOk({ shops })]);
  assert.deepEqual(output.data, shops);
});

test("get_package_shipping_document returns the document URL without downloading it", async () => {
  const { output, calls } = await runWithResponses("get_package_shipping_document", { package_id: PACKAGE_ID }, [tiktokShopOk({ doc_url: "https://example.com/label.pdf", tracking_number: "T1" })]);
  assert.equal(calls.length, 1);
  assert.deepEqual(output.data, { doc_url: "https://example.com/label.pdf", tracking_number: "T1" });
});

test("a node access_token override goes in the header and is not signed", async () => {
  const { calls } = await runWithResponses("get_authorized_shops", { access_token: "node-token" }, [tiktokShopOk()], TEST_ENVIRONMENT, "node");
  assert.equal(calls[0].headers["x-tts-access-token"], "node-token");
  assert.equal(calls[0].query.sign, expectedSignature(calls[0]));
});

test("api_request ignores caller sign/access_token query values and signs what it sends", async () => {
  const { calls } = await runWithResponses("api_request", { path: "/logistics/202309/warehouses", query: { sign: "forged", access_token: "leak", app_key: "other" } });
  const [call] = calls;
  assert.equal(call.query.access_token, undefined);
  assert.equal(call.query.app_key, TEST_ENVIRONMENT.TIKTOK_SHOP_APP_KEY);
  assert.equal(call.query.sign, expectedSignature(call));
});

test("api_request redacts the token and app secret echoed in a response", async () => {
  const echo = tiktokShopOk({ note: "TTP_access_token_test / app-secret-for-tests" });
  const { output } = await runWithResponses("api_request", { path: "/logistics/202309/warehouses" }, [echo]);
  assert.doesNotMatch(JSON.stringify(output), /TTP_access_token_test|app-secret-for-tests/);
});

test("refresh_access_token calls auth.tiktok-shops.com with the documented query and returns the new tokens", async () => {
  const tokens = { access_token: "TTP_new", access_token_expire_in: 1660556783, refresh_token: "TTP_new_refresh", refresh_token_expire_in: 1691487031 };
  const { output, calls } = await runWithResponses("refresh_access_token", {}, [tiktokShopOk(tokens)]);
  const [call] = calls;
  assert.equal(call.method, "GET");
  assert.equal(new URL(call.url).origin, "https://auth.tiktok-shops.com");
  assert.equal(call.path, "/api/v2/token/refresh");
  assert.deepEqual(call.query, { app_key: "app-key-test", app_secret: "app-secret-for-tests", refresh_token: "TTP_refresh_token_test", grant_type: "refresh_token" });
  assert.equal(call.headers["x-tts-access-token"], undefined);
  assert.deepEqual(output.data, tokens);
});

test("refresh_access_token works without an access token and accepts an explicit refresh_token", async () => {
  const { TIKTOK_SHOP_ACCESS_TOKEN: _unused, ...withoutAccessToken } = TEST_ENVIRONMENT;
  const { calls } = await runWithResponses("refresh_access_token", { refresh_token: "TTP_arg" }, [tiktokShopOk()], withoutAccessToken);
  assert.equal(calls[0].query.refresh_token, "TTP_arg");
});
