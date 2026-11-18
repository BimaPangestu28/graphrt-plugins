import { test } from "node:test";
import assert from "node:assert/strict";
import { detectShopeeError, parseShopeeError } from "../lib/client.mjs";
import { runExpectingError, runWithResponses, shopeeError, shopeeOk, TEST_ENVIRONMENT } from "./helpers.mjs";

for (const [code, expectedKind] of [
  ["error_auth", "auth_error"],
  ["error_sign", "auth_error"],
  ["invalid_access_token", "auth_error"],
  ["invalid_acceess_token", "auth_error"],
  ["error_partner_key_expired", "auth_error"],
  ["error_param", "invalid_input"],
  ["error_param_shop_id_not_found", "invalid_input"],
  ["error_permission", "permission_denied"],
  ["error_api_permission", "permission_denied"],
  ["source_ip_undeclared", "permission_denied"],
  ["shop_no_linked", "permission_denied"],
  ["error_not_found", "not_found"],
  ["error_item_not_found", "not_found"],
  ["error_too_many_requests", "rate_limited"],
  ["error_rate_limit", "rate_limited"],
  ["rate_limit", "rate_limited"],
  ["error_limit", "rate_limited"],
  ["error_server", "api_error"],
  ["error_inner", "api_error"],
]) {
  test(`detectShopeeError maps ${code} to ${expectedKind}`, () => {
    const detected = detectShopeeError({ request_id: "REQ9", error: code, message: `details for ${code}` });
    assert.equal(detected.kind, expectedKind);
    assert.match(detected.message, new RegExp(`details for ${code}`));
    assert.match(detected.message, /REQ9/);
  });
}

test("detectShopeeError ignores empty or missing error fields", () => {
  assert.equal(detectShopeeError(shopeeOk().body), null);
  assert.equal(detectShopeeError({ response: {} }), null);
  assert.equal(detectShopeeError({ error: "   " }), null);
});

test("the daily quota error is rate_limited but not retryable", () => {
  assert.equal(detectShopeeError({ error: "error_limit" }).retryable, false);
});

test("parseShopeeError keeps HTTP-status kinds for server errors and maps envelopes on 4xx", () => {
  assert.deepEqual(Object.keys(parseShopeeError(500, { error: "error_server", message: "boom" })), ["message"]);
  assert.equal(parseShopeeError(403, { error: "error_auth", message: "Invalid partner_id" }).kind, "auth_error");
  assert.deepEqual(parseShopeeError(502, { text: "Bad gateway" }), {});
});

test("an auth error inside an HTTP 200 body becomes auth_error and redacts credentials", async () => {
  const leakyMessage = "Invalid access_token shop-access-token for key partner-key-for-tests";
  const { error, calls } = await runExpectingError("get_shop_info", {}, [shopeeError("invalid_acceess_token", leakyMessage)]);
  assert.equal(error.kind, "auth_error");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(error.message, /shop-access-token|partner-key-for-tests/);
  assert.match(error.message, /invalid_acceess_token/);
});

test("error_param on HTTP 200 becomes invalid_input without retries", async () => {
  const { error, calls } = await runExpectingError("get_order_detail", { order_sns: ["X"] }, [shopeeError("error_param", "Wrong parameters")]);
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 1);
});

test("reads are retried after a 5xx and re-signed with the same request", async () => {
  const { output, calls } = await runWithResponses("get_shop_info", {}, [shopeeError("error_server", "busy", 503), { body: { error: "", shop_name: "Toko" } }]);
  assert.equal(calls.length, 2);
  assert.equal(output.data.shop_name, "Toko");
});

for (const [operationName, args] of [
  ["update_stock", { item_id: 1, stock_list: [{ stock: 1 }] }],
  ["update_price", { item_id: 1, price_list: [{ original_price: 10 }] }],
  ["ship_order", { order_sn: "A", pickup: {} }],
  ["sellerchat_send_message", { to_id: "1", text: "hi" }],
]) {
  test(`${operationName} is not retried after a 5xx and says the outcome is unknown`, async () => {
    const { error, calls } = await runExpectingError(operationName, args, [shopeeError("error_server", "busy", 502), shopeeOk()]);
    assert.equal(calls.length, 1);
    assert.equal(error.retryable, false);
    assert.match(error.message, /outcome unknown/);
  });

  test(`${operationName} is not retried after a network failure`, async () => {
    const { createOperationRunner } = await import("../lib/shared/operations.mjs");
    const { pluginDefinition } = await import("../definition.mjs");
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
  for (const variableName of ["SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY", "SHOPEE_SHOP_ID", "SHOPEE_ACCESS_TOKEN"]) {
    const { [variableName]: _removed, ...environment } = TEST_ENVIRONMENT;
    const { error, calls } = await runExpectingError("get_shop_info", {}, [], environment);
    assert.equal(error.kind, "auth_error", variableName);
    assert.match(error.message, new RegExp(variableName));
    assert.equal(calls.length, 0);
  }
});

test("non-numeric partner or shop ids are invalid_input", async () => {
  const { error } = await runExpectingError("get_shop_info", {}, [], { ...TEST_ENVIRONMENT, SHOPEE_SHOP_ID: "toko-saya" });
  assert.equal(error.kind, "invalid_input");
});

test("an unknown SHOPEE_ENV is invalid_input", async () => {
  const { error } = await runExpectingError("get_shop_info", {}, [], { ...TEST_ENVIRONMENT, SHOPEE_ENV: "staging" });
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /SHOPEE_ENV/);
});

test("refresh_access_token is node only and never offered as a tool", async () => {
  const { pluginDefinition } = await import("../definition.mjs");
  const { buildDescriptors } = await import("../lib/shared/operations.mjs");
  assert.ok(!buildDescriptors(pluginDefinition).tools.some((tool) => tool.name === "refresh_access_token"));
  await assert.rejects(runWithResponses("refresh_access_token", {}, [shopeeOk()], TEST_ENVIRONMENT, "tool"), (error) => error.kind === "invalid_input");
});

test("refresh_access_token redacts the refresh token from errors", async () => {
  const { error } = await runExpectingError("refresh_access_token", {}, [shopeeError("error_auth", "refresh token shop-refresh-token is invalid")]);
  assert.equal(error.kind, "auth_error");
  assert.doesNotMatch(error.message, /shop-refresh-token/);
});

test("refresh_access_token without a refresh token is invalid_input", async () => {
  const { SHOPEE_REFRESH_TOKEN: _removed, ...environment } = TEST_ENVIRONMENT;
  const { error, calls } = await runExpectingError("refresh_access_token", {}, [], environment);
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("api_request rejects paths outside /api/v2 and paths with query strings", async () => {
  for (const path of ["/api/v1/shop/get", "/api/v2/shop/get?x=1", "/api/v2/../v1/x", "https://evil.example/api/v2/x"]) {
    const { error, calls } = await runExpectingError("api_request", { path });
    assert.equal(error.kind, "invalid_input", path);
    assert.equal(calls.length, 0);
  }
});

for (const operationName of ["update_stock", "update_price", "ship_order"]) {
  test(`${operationName} is node only: never offered as a tool and refused when called as one`, async () => {
    const { pluginDefinition } = await import("../definition.mjs");
    const { buildDescriptors } = await import("../lib/shared/operations.mjs");
    assert.ok(!buildDescriptors(pluginDefinition).tools.some((tool) => tool.name === operationName));
    assert.ok(buildDescriptors(pluginDefinition).nodes.some((node) => node.kind === `shopee-api.${operationName}`));
    const { error, calls } = await runExpectingError(operationName, {}, [shopeeOk()], TEST_ENVIRONMENT, "tool");
    assert.equal(error.kind, "invalid_input");
    assert.equal(calls.length, 0);
  });
}

for (const [description, response] of [
  ["a non-JSON body", { body: "<html>gateway</html>" }],
  ["a JSON body without the error field", { body: { response: { shop_name: "Toko" } } }],
]) {
  test(`an HTTP 200 read with ${description} is api_error`, async () => {
    const { error, calls } = await runExpectingError("get_shop_info", {}, [response, shopeeOk()]);
    assert.equal(error.kind, "api_error");
    assert.match(error.message, /envelope/);
    assert.doesNotMatch(error.message, /outcome unknown/);
    assert.equal(calls.length, 1);
  });

  test(`an HTTP 200 write with ${description} is api_error with the unknown-outcome note`, async () => {
    const { error, calls } = await runExpectingError("sellerchat_send_message", { to_id: "1", text: "hi" }, [response, shopeeOk()]);
    assert.equal(error.kind, "api_error");
    assert.equal(error.retryable, false);
    assert.match(error.message, /outcome unknown/);
    assert.equal(calls.length, 1);
  });
}

for (const serverCode of ["error_server", "error_inner", "error_busy", "error_network"]) {
  test(`${serverCode} on HTTP 200 is retried for a GET`, async () => {
    const { output, calls } = await runWithResponses("get_shop_info", {}, [shopeeError(serverCode), { body: { error: "", shop_name: "Toko" } }]);
    assert.equal(calls.length, 2);
    assert.equal(output.data.shop_name, "Toko");
  });

  test(`${serverCode} on HTTP 200 is not retried for a POST and says the outcome is unknown`, async () => {
    const { error, calls } = await runExpectingError("sellerchat_send_message", { to_id: "1", text: "hi" }, [shopeeError(serverCode), shopeeOk()]);
    assert.equal(error.kind, "api_error");
    assert.equal(error.retryable, false);
    assert.match(error.message, /outcome unknown/);
    assert.equal(calls.length, 1);
  });
}
