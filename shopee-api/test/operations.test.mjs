import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedSignature, LIVE_ORIGIN, runExpectingError, runWithResponses, shopeeOk, TEST_ENVIRONMENT } from "./helpers.mjs";

const DAY = 86400;
const WINDOW_START = 1763424000;

// Each case: operation + args → expected single request (method, path, a subset of query and the JSON body).
const SHOP_API_CASES = [
  ["get_shop_info", {}, { method: "GET", path: "/api/v2/shop/get_shop_info" }],
  [
    "get_item_list",
    { limit: 20, cursor: "40", update_time_from: WINDOW_START },
    { method: "GET", path: "/api/v2/product/get_item_list", query: { offset: "40", page_size: "20", update_time_from: String(WINDOW_START) }, repeated: { item_status: ["NORMAL"] } },
  ],
  [
    "get_item_list",
    { item_status: ["NORMAL", "UNLIST"] },
    { method: "GET", path: "/api/v2/product/get_item_list", query: { offset: "0", page_size: "50" }, repeated: { item_status: ["NORMAL", "UNLIST"] } },
  ],
  ["get_item_base_info", { item_ids: [34001, 34002] }, { method: "GET", path: "/api/v2/product/get_item_base_info", query: { item_id_list: "34001,34002" } }],
  [
    "update_stock",
    { item_id: 800, stock_list: [{ model_id: 0, stock: 25 }] },
    { method: "POST", path: "/api/v2/product/update_stock", json: { item_id: 800, stock_list: [{ model_id: 0, seller_stock: [{ stock: 25 }] }] } },
  ],
  [
    "update_stock",
    { item_id: "800", stock_list: [{ model_id: "11", stock: 3, location_id: "IDZ" }, { model_id: 11, stock: 4, location_id: "IDW" }, { model_id: 12, stock: 0 }] },
    {
      method: "POST",
      path: "/api/v2/product/update_stock",
      json: {
        item_id: 800,
        stock_list: [
          { model_id: 11, seller_stock: [{ location_id: "IDZ", stock: 3 }, { location_id: "IDW", stock: 4 }] },
          { model_id: 12, seller_stock: [{ stock: 0 }] },
        ],
      },
    },
  ],
  [
    "update_price",
    { item_id: 800, price_list: [{ original_price: "150000" }, { model_id: 5, original_price: 99.5 }] },
    { method: "POST", path: "/api/v2/product/update_price", json: { item_id: 800, price_list: [{ model_id: 0, original_price: 150000 }, { model_id: 5, original_price: 99.5 }] } },
  ],
  [
    "get_order_list",
    { time_from: WINDOW_START, time_to: WINDOW_START + 15 * DAY, order_status: "READY_TO_SHIP", limit: 10, cursor: "c1" },
    {
      method: "GET",
      path: "/api/v2/order/get_order_list",
      query: {
        time_range_field: "create_time",
        time_from: String(WINDOW_START),
        time_to: String(WINDOW_START + 15 * DAY),
        order_status: "READY_TO_SHIP",
        page_size: "10",
        cursor: "c1",
        response_optional_fields: "order_status",
      },
    },
  ],
  [
    "get_order_detail",
    { order_sns: ["2201AB", "2201CD"] },
    { method: "GET", path: "/api/v2/order/get_order_detail", query: { order_sn_list: "2201AB,2201CD" }, queryIncludes: { response_optional_fields: /item_list.*package_list/ } },
  ],
  ["get_shipping_parameter", { order_sn: "2201AB" }, { method: "GET", path: "/api/v2/logistics/get_shipping_parameter", query: { order_sn: "2201AB" } }],
  [
    "ship_order",
    { order_sn: "2201AB", pickup: { address_id: 7, pickup_time_id: "slot-1" } },
    { method: "POST", path: "/api/v2/logistics/ship_order", json: { order_sn: "2201AB", pickup: { address_id: 7, pickup_time_id: "slot-1" } } },
  ],
  [
    "ship_order",
    { order_sn: "2201AB", package_number: "P1", dropoff: {} },
    { method: "POST", path: "/api/v2/logistics/ship_order", json: { order_sn: "2201AB", package_number: "P1", dropoff: {} } },
  ],
  [
    "get_tracking_number",
    { order_sn: "2201AB", package_number: "P1" },
    { method: "GET", path: "/api/v2/logistics/get_tracking_number", query: { order_sn: "2201AB", package_number: "P1" } },
  ],
  [
    "sellerchat_get_conversation_list",
    { limit: 10, cursor: "1700000000000000000" },
    { method: "GET", path: "/api/v2/sellerchat/get_conversation_list", query: { direction: "older", type: "all", page_size: "10", next_timestamp_nano: "1700000000000000000" } },
  ],
  [
    "sellerchat_get_message",
    { conversation_id: "123", cursor: "off-2" },
    { method: "GET", path: "/api/v2/sellerchat/get_message", query: { conversation_id: "123", page_size: "25", offset: "off-2" } },
  ],
  [
    "sellerchat_send_message",
    { to_id: "556677", text: "Halo kak, pesanan sudah dikirim" },
    { method: "POST", path: "/api/v2/sellerchat/send_message", json: { to_id: 556677, message_type: "text", content: { text: "Halo kak, pesanan sudah dikirim" } } },
  ],
  [
    "sellerchat_send_message",
    { to_id: "556677", message_type: "order", order_sn: "2201AB" },
    { method: "POST", path: "/api/v2/sellerchat/send_message", json: { to_id: 556677, message_type: "order", content: { order_sn: "2201AB" } } },
  ],
  [
    "sellerchat_send_message",
    { to_id: "556677", message_type: "item", item_id: "800" },
    { method: "POST", path: "/api/v2/sellerchat/send_message", json: { to_id: 556677, message_type: "item", content: { item_id: 800 } } },
  ],
  ["api_request", { path: "/api/v2/product/get_category", query: { language: "id" } }, { method: "GET", path: "/api/v2/product/get_category", query: { language: "id" } }],
];

for (const [operationName, args, expectedRequest] of SHOP_API_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends a signed ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(new URL(call.url).origin, LIVE_ORIGIN);
    assert.equal(call.path, expectedRequest.path);
    assertShopCommonParameters(call);
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    for (const [key, pattern] of Object.entries(expectedRequest.queryIncludes ?? {})) assert.match(call.query[key], pattern, `query.${key}`);
    for (const [key, values] of Object.entries(expectedRequest.repeated ?? {})) assert.deepEqual(new URL(call.url).searchParams.getAll(key), values, key);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
    if (expectedRequest.method === "GET") assert.equal(call.body, undefined);
  });
}

function assertShopCommonParameters(call) {
  assert.equal(call.query.partner_id, TEST_ENVIRONMENT.SHOPEE_PARTNER_ID);
  assert.equal(call.query.shop_id, TEST_ENVIRONMENT.SHOPEE_SHOP_ID);
  assert.equal(call.query.access_token, TEST_ENVIRONMENT.SHOPEE_ACCESS_TOKEN);
  assert.match(call.query.timestamp, /^\d{10}$/);
  assert.ok(Math.abs(Number(call.query.timestamp) - Date.now() / 1000) < 60, "timestamp is current Unix seconds");
  const signature = expectedSignature({ path: call.path, timestamp: call.query.timestamp, accessToken: call.query.access_token, shopId: call.query.shop_id });
  assert.equal(call.query.sign, signature, "sign is HMAC-SHA256 over partner_id+path+timestamp+access_token+shop_id");
  assert.equal(call.headers.authorization, undefined);
}

test("get_item_list maps has_next_page/next_offset to next_cursor", async () => {
  const { output } = await runWithResponses("get_item_list", {}, [shopeeOk({ item: [{ item_id: 1 }], has_next_page: true, next_offset: 50 })]);
  assert.deepEqual(output, { data: [{ item_id: 1 }], next_cursor: "50" });
  const { output: lastPage } = await runWithResponses("get_item_list", { cursor: "50" }, [shopeeOk({ item: [], has_next_page: false, next_offset: 0 })]);
  assert.equal(lastPage.next_cursor, null);
});

test("get_order_list maps more/next_cursor and returns null on the last page", async () => {
  const args = { time_from: WINDOW_START, time_to: WINDOW_START + DAY };
  const { output } = await runWithResponses("get_order_list", args, [shopeeOk({ more: true, next_cursor: "20", order_list: [{ order_sn: "A" }] })]);
  assert.deepEqual(output, { data: [{ order_sn: "A" }], next_cursor: "20" });
  const { output: lastPage } = await runWithResponses("get_order_list", args, [shopeeOk({ more: false, next_cursor: "", order_list: [] })]);
  assert.equal(lastPage.next_cursor, null);
});

test("sellerchat_get_conversation_list pages by next_message_time_nano", async () => {
  const response = { conversations: [{ conversation_id: "9" }], page_result: { more: true, next_cursor: { next_message_time_nano: "1699", conversation_id: "9" } } };
  const { output } = await runWithResponses("sellerchat_get_conversation_list", {}, [shopeeOk(response)]);
  assert.deepEqual(output, { data: [{ conversation_id: "9" }], next_cursor: "1699" });
  const { output: lastPage } = await runWithResponses("sellerchat_get_conversation_list", {}, [shopeeOk({ conversations: [], page_result: { more: false } })]);
  assert.equal(lastPage.next_cursor, null);
});

test("sellerchat_get_message stops paging on an empty page or a repeated offset", async () => {
  const { output } = await runWithResponses("sellerchat_get_message", { conversation_id: "1" }, [shopeeOk({ messages: [{ message_id: "m" }], page_result: { next_offset: "o2" } })]);
  assert.equal(output.next_cursor, "o2");
  const { output: emptyPage } = await runWithResponses("sellerchat_get_message", { conversation_id: "1", cursor: "o2" }, [shopeeOk({ messages: [], page_result: { next_offset: "o3" } })]);
  assert.equal(emptyPage.next_cursor, null);
  const { output: samePage } = await runWithResponses("sellerchat_get_message", { conversation_id: "1", cursor: "o2" }, [shopeeOk({ messages: [{}], page_result: { next_offset: "o2" } })]);
  assert.equal(samePage.next_cursor, null);
});

test("get_shop_info returns the top-level fields without the envelope", async () => {
  const { output } = await runWithResponses("get_shop_info", {}, [{ body: { request_id: "R", error: "", message: "", shop_name: "Toko", region: "ID", status: "NORMAL" } }]);
  assert.deepEqual(output.data, { shop_name: "Toko", region: "ID", status: "NORMAL" });
});

test("update_stock returns the success and failure lists so partial failures are visible", async () => {
  const response = { success_list: [{ model_id: 1, stock: 5 }], failure_list: [{ model_id: 2, failed_reason: "reserved stock" }] };
  const { output } = await runWithResponses("update_stock", { item_id: 1, stock_list: [{ model_id: 1, stock: 5 }, { model_id: 2, stock: 0 }] }, [shopeeOk(response)]);
  assert.deepEqual(output.data, response);
});

test("SHOPEE_ENV=test signs against the sandbox host", async () => {
  const { calls } = await runWithResponses("get_shop_info", {}, [shopeeOk()], { ...TEST_ENVIRONMENT, SHOPEE_ENV: "test" });
  assert.equal(new URL(calls[0].url).origin, "https://openplatform.sandbox.test-stable.shopee.sg");
  assert.equal(calls[0].query.sign, expectedSignature({ path: calls[0].path, timestamp: calls[0].query.timestamp, accessToken: "shop-access-token", shopId: "14701711" }));
});

test("a node access_token override is used and signed", async () => {
  const { calls } = await runWithResponses("get_shop_info", { access_token: "node-token" }, [shopeeOk()], TEST_ENVIRONMENT, "node");
  assert.equal(calls[0].query.access_token, "node-token");
  assert.equal(calls[0].query.sign, expectedSignature({ path: calls[0].path, timestamp: calls[0].query.timestamp, accessToken: "node-token", shopId: "14701711" }));
});

test("api_request with api_type public signs without access_token and shop_id", async () => {
  const { calls } = await runWithResponses("api_request", { api_type: "public", path: "/api/v2/public/get_shops_by_partner" });
  const [call] = calls;
  assert.equal(call.query.access_token, undefined);
  assert.equal(call.query.shop_id, undefined);
  assert.equal(call.query.sign, expectedSignature({ path: "/api/v2/public/get_shops_by_partner", timestamp: call.query.timestamp }));
});

test("api_request POST sends the JSON body and redacts credentials echoed in the response", async () => {
  const echo = { response: { note: `token shop-access-token key partner-key-for-tests` } };
  const args = { method: "POST", path: "/api/v2/shop/update_profile", body: { description: "x" } };
  const { output, calls } = await runWithResponses("api_request", args, [{ body: { error: "", ...echo } }], TEST_ENVIRONMENT, "node");
  assert.deepEqual(calls[0].json, { description: "x" });
  assert.doesNotMatch(JSON.stringify(output), /shop-access-token|partner-key-for-tests/);
});

test("api_request POST called as an agent tool is refused before any request", async () => {
  const args = { method: "POST", path: "/api/v2/shop/update_profile", body: { description: "x" } };
  const { error, calls } = await runExpectingError("api_request", args, [shopeeOk()], TEST_ENVIRONMENT, "tool");
  assert.equal(error.kind, "permission_denied");
  assert.equal(calls.length, 0);
});

test("refresh_access_token posts a public-signed request with partner_id and shop_id as numbers", async () => {
  const tokens = { access_token: "new-access", refresh_token: "new-refresh", expire_in: 14400, shop_id: 14701711 };
  const { output, calls } = await runWithResponses("refresh_access_token", {}, [{ body: { request_id: "R", error: "", message: "", ...tokens } }]);
  const [call] = calls;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/v2/auth/access_token/get");
  assert.deepEqual(call.json, { refresh_token: "shop-refresh-token", partner_id: 2001887, shop_id: 14701711 });
  assert.equal(call.query.access_token, undefined);
  assert.equal(call.query.sign, expectedSignature({ path: "/api/v2/auth/access_token/get", timestamp: call.query.timestamp }));
  assert.deepEqual(output.data, tokens);
});

test("refresh_access_token works without an access token and takes explicit refresh_token/shop_id", async () => {
  const { SHOPEE_ACCESS_TOKEN: _unused, ...withoutAccessToken } = TEST_ENVIRONMENT;
  const { calls } = await runWithResponses("refresh_access_token", { refresh_token: "rt-arg", shop_id: "99" }, [shopeeOk()], withoutAccessToken);
  assert.deepEqual(calls[0].json, { refresh_token: "rt-arg", partner_id: 2001887, shop_id: 99 });
});
