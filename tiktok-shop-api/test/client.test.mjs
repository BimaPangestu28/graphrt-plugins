import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTiktokShopError, normalizeQueryInPlace, parseTiktokShopError } from "../lib/client.mjs";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { buildDescriptors } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { runExpectingError, runWithResponses, TEST_ENVIRONMENT, tiktokShopError, tiktokShopOk } from "./helpers.mjs";

for (const [code, message, expectedKind] of [
  [105002, "Expired credentials. The x-tts-access-token header has expired.", "auth_error"],
  [106001, "Invalid credentials. The sign query parameter is invalid.", "auth_error"],
  [36009004, "Invalid credentials. The x-tts-access-token header is invalid.", "auth_error"],
  [36009004, "Invalid credentials. Invalid app_key query parameter.", "auth_error"],
  [36009004, "Invalid timestamp. The value must not be earlier than 5 minutes before the current time.", "auth_error"],
  [36009004, "Missing credentials. The request does not include a required signature in the query.", "auth_error"],
  [36009004, "Unexpected identifier. The shop_cipher query parameter is not required for this request.", "invalid_input"],
  [36009004, "Invalid API version.", "invalid_input"],
  [101000, "Invalid query or header.", "auth_error"],
  [105001, "Some other credential problem", "auth_error"],
  [105005, "Access denied. Missing scope.", "permission_denied"],
  [36009033, "IP not in allow list", "permission_denied"],
  [36009002, "Too many requests.", "rate_limited"],
  [45101004, "The query quota has been reached (10000 request per day).", "rate_limited"],
  [106013, "Missing identifier. The shop_cipher query parameter is required.", "invalid_input"],
  [36009009, "Invalid path.", "invalid_input"],
  [45101003, "Record not found.", "not_found"],
  [12052032, "The product does not exist", "not_found"],
  [36009003, "Internal error.", "api_error"],
  [12019024, "The inventory quantity is invalid.", "api_error"],
]) {
  test(`detectTiktokShopError maps ${code} "${message.slice(0, 40)}" to ${expectedKind}`, () => {
    const detected = detectTiktokShopError({ code, message, request_id: "REQ7" });
    assert.equal(detected.kind, expectedKind);
    assert.match(detected.message, new RegExp(`code ${code}`));
    assert.match(detected.message, /REQ7/);
  });
}

test("detectTiktokShopError ignores code 0 and bodies without a code", () => {
  assert.equal(detectTiktokShopError(tiktokShopOk().body), null);
  assert.equal(detectTiktokShopError({ code: "0" }), null);
  assert.equal(detectTiktokShopError({ text: "<html>" }), null);
});

test("the daily send quota is rate_limited but not retryable", () => {
  assert.equal(detectTiktokShopError({ code: 45101004, message: "quota" }).retryable, false);
});

test("parseTiktokShopError leaves api_error to the HTTP status mapping and maps others", () => {
  assert.deepEqual(Object.keys(parseTiktokShopError(500, { code: 36009003, message: "Internal" })), ["message"]);
  assert.equal(parseTiktokShopError(401, { code: 105002, message: "Expired credentials" }).kind, "auth_error");
  assert.deepEqual(parseTiktokShopError(502, { text: "Bad gateway" }), {});
});

test("normalizeQueryInPlace produces the strings that are sent", () => {
  const query = { a: ["x", "y"], b: 5, c: true, d: undefined, e: null, f: { k: 1 } };
  normalizeQueryInPlace(query);
  assert.deepEqual(query, { a: "x,y", b: "5", c: "true", f: '{"k":1}' });
});

test("an auth error inside an HTTP 200 body is auth_error, not retried, and redacts credentials", async () => {
  const leaky = "Invalid credentials. token TTP_access_token_test secret app-secret-for-tests";
  const { error, calls } = await runExpectingError("get_authorized_shops", {}, [tiktokShopError(36009004, leaky)]);
  assert.equal(error.kind, "auth_error");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(error.message, /TTP_access_token_test|app-secret-for-tests/);
});

test("HTTP 429 with code 36009002 is rate_limited", async () => {
  const { error } = await runExpectingError("get_conversations", {}, [
    tiktokShopError(36009002, "Too many requests", 429),
    tiktokShopError(36009002, "Too many requests", 429),
    tiktokShopError(36009002, "Too many requests", 429),
  ]);
  assert.equal(error.kind, "rate_limited");
});

test("reads are retried after a 5xx", async () => {
  const { output, calls } = await runWithResponses("get_authorized_shops", {}, [tiktokShopError(36009003, "Internal", 503), tiktokShopOk({ shops: [] })]);
  assert.equal(calls.length, 2);
  assert.deepEqual(output.data, []);
});

const WRITE_CASES = [
  ["update_inventory", { product_id: "1", skus: [{ sku_id: "2", quantity: 1 }] }],
  ["update_price", { product_id: "1", currency: "IDR", skus: [{ sku_id: "2", amount: "10" }] }],
  ["ship_package", { package_id: "3" }],
  ["send_message", { conversation_id: "4", text: "hi" }],
];

for (const [operationName, args] of WRITE_CASES) {
  test(`${operationName} is not retried after a 5xx and says the outcome is unknown`, async () => {
    const { error, calls } = await runExpectingError(operationName, args, [tiktokShopError(36009003, "Internal", 500), tiktokShopOk()]);
    assert.equal(calls.length, 1);
    assert.equal(error.retryable, false);
    assert.match(error.message, /outcome unknown/);
  });

  test(`${operationName} is not retried after a network failure`, async () => {
    let attempts = 0;
    const failingFetch = async () => {
      attempts += 1;
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    };
    const runOperation = createOperationRunner(pluginDefinition, TEST_ENVIRONMENT, { fetchImpl: failingFetch });
    const source = pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly ? "node" : "tool";
    await assert.rejects(runOperation(operationName, args, { source }), (error) => error.kind === "network_error" && error.retryable === false);
    assert.equal(attempts, 1);
  });
}

test("missing credentials fail with auth_error naming the env var, before any request", async () => {
  for (const variableName of ["TIKTOK_SHOP_APP_KEY", "TIKTOK_SHOP_APP_SECRET", "TIKTOK_SHOP_ACCESS_TOKEN"]) {
    const { [variableName]: _removed, ...environment } = TEST_ENVIRONMENT;
    const { error, calls } = await runExpectingError("get_authorized_shops", {}, [], environment);
    assert.equal(error.kind, "auth_error", variableName);
    assert.match(error.message, new RegExp(variableName));
    assert.equal(calls.length, 0);
  }
});

test("shop operations without TIKTOK_SHOP_CIPHER fail with invalid_input; get_authorized_shops does not need it", async () => {
  const { TIKTOK_SHOP_CIPHER: _removed, ...environment } = TEST_ENVIRONMENT;
  const { error, calls } = await runExpectingError("search_orders", {}, [], environment);
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /TIKTOK_SHOP_CIPHER/);
  assert.equal(calls.length, 0);
  const { calls: shopCalls } = await runWithResponses("get_authorized_shops", {}, [tiktokShopOk({ shops: [] })], environment);
  assert.equal(shopCalls.length, 1);
});

test("refresh_access_token is node only and never offered as a tool", async () => {
  assert.ok(!buildDescriptors(pluginDefinition).tools.some((tool) => tool.name === "refresh_access_token"));
  await assert.rejects(runWithResponses("refresh_access_token", {}, [tiktokShopOk()], TEST_ENVIRONMENT, "tool"), (error) => error.kind === "invalid_input");
});

test("refresh_access_token maps a rejected refresh token, redacts secrets and is not retried", async () => {
  const leaky = "refresh_token TTP_refresh_token_test invalid for secret app-secret-for-tests";
  const { error, calls } = await runExpectingError("refresh_access_token", {}, [tiktokShopError(105002, leaky, 500), tiktokShopOk()]);
  assert.equal(error.kind, "auth_error");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(error.message, /TTP_refresh_token_test|app-secret-for-tests/);
});

test("refresh_access_token without a refresh token or app secret fails before any request", async () => {
  const { TIKTOK_SHOP_REFRESH_TOKEN: _token, ...withoutRefresh } = TEST_ENVIRONMENT;
  const { error, calls } = await runExpectingError("refresh_access_token", {}, [], withoutRefresh);
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
  const { TIKTOK_SHOP_APP_SECRET: _secret, ...withoutSecret } = TEST_ENVIRONMENT;
  const { error: secretError } = await runExpectingError("refresh_access_token", {}, [], withoutSecret);
  assert.equal(secretError.kind, "auth_error");
});

test("api_request rejects unsafe paths and query strings in the path", async () => {
  for (const path of ["/order/202309/orders?x=1", "/a/../b", "https://evil.example/x", "//evil.example/x", "/a b", "/a/%2e%2e/b", "/a/%2F/b", "/a/./b", "/a/b.json"]) {
    const { error, calls } = await runExpectingError("api_request", { path });
    assert.equal(error.kind, "invalid_input", path);
    assert.equal(calls.length, 0);
  }
});

function createFailingFetch() {
  const failingFetch = async () => {
    failingFetch.attempts += 1;
    throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
  };
  failingFetch.attempts = 0;
  return failingFetch;
}

for (const operationName of ["update_inventory", "update_price", "ship_package"]) {
  test(`${operationName} is node only: never offered as a tool and refused when called as one`, async () => {
    assert.ok(!buildDescriptors(pluginDefinition).tools.some((tool) => tool.name === operationName));
    assert.ok(buildDescriptors(pluginDefinition).nodes.some((node) => node.kind === `tiktok-shop-api.${operationName}`));
    const { error, calls } = await runExpectingError(operationName, {}, [tiktokShopOk()], TEST_ENVIRONMENT, "tool");
    assert.equal(error.kind, "invalid_input");
    assert.equal(calls.length, 0);
  });
}

for (const [description, response] of [
  ["a non-JSON body", { body: "<html>gateway</html>" }],
  ["a JSON body without code", { body: { data: { shops: [] } } }],
]) {
  test(`an HTTP 200 read with ${description} is api_error`, async () => {
    const { error, calls } = await runExpectingError("get_authorized_shops", {}, [response, tiktokShopOk()]);
    assert.equal(error.kind, "api_error");
    assert.match(error.message, /envelope/);
    assert.doesNotMatch(error.message, /outcome unknown/);
    assert.equal(calls.length, 1);
  });

  test(`an HTTP 200 write with ${description} is api_error with the unknown-outcome note`, async () => {
    const { error, calls } = await runExpectingError("send_message", { conversation_id: "4", text: "hi" }, [response, tiktokShopOk()]);
    assert.equal(error.kind, "api_error");
    assert.equal(error.retryable, false);
    assert.match(error.message, /outcome unknown/);
    assert.equal(calls.length, 1);
  });
}

for (const [operationName, listKey] of [["search_orders", "orders"], ["search_products", "products"], ["search_returns", "return_orders"]]) {
  test(`${operationName} is a POST read: retried after a 5xx`, async () => {
    const responses = [tiktokShopError(36009003, "Internal", 503), tiktokShopOk({ [listKey]: [{ id: "1" }] })];
    const { output, calls } = await runWithResponses(operationName, {}, responses);
    assert.equal(calls.length, 2);
    assert.deepEqual(output.data, [{ id: "1" }]);
  });

  test(`${operationName} network failures are retryable and not reported as writes`, async () => {
    const failingFetch = createFailingFetch();
    const runOperation = createOperationRunner(pluginDefinition, TEST_ENVIRONMENT, { fetchImpl: failingFetch });
    await assert.rejects(
      runOperation(operationName, {}, { source: "tool" }),
      (error) => error.kind === "network_error" && error.retryable === true && !/outcome unknown/.test(error.message),
    );
    assert.equal(failingFetch.attempts, 3);
  });
}

test("refresh_access_token network failure is not retryable and says the outcome is unknown", async () => {
  const failingFetch = createFailingFetch();
  const runOperation = createOperationRunner(pluginDefinition, TEST_ENVIRONMENT, { fetchImpl: failingFetch });
  await assert.rejects(
    runOperation("refresh_access_token", {}, { source: "node" }),
    (error) => error.kind === "network_error" && error.retryable === false && /outcome unknown/.test(error.message),
  );
  assert.equal(failingFetch.attempts, 1);
});

test("refresh_access_token 5xx is not retryable and says the outcome is unknown", async () => {
  const { error, calls } = await runExpectingError("refresh_access_token", {}, [tiktokShopError(36009003, "Internal", 503), tiktokShopOk()]);
  assert.equal(error.kind, "api_error");
  assert.equal(error.retryable, false);
  assert.match(error.message, /outcome unknown/);
  assert.equal(calls.length, 1);
});
