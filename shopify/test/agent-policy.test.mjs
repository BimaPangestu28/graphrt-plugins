import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { listUserErrors } from "../lib/graphql-mutations.mjs";
import { pluginDefinition } from "../definition.mjs";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: { data: {} } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { SHOPIFY_ACCESS_TOKEN: "shpat_fake", SHOPIFY_SHOP_DOMAIN: "acme.myshopify.com", ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("SHOPIFY_SHOP_DOMAIN must be a *.myshopify.com domain", async () => {
  for (const badDomain of ["", "acme.com", "evil.example/acme.myshopify.com", "acme.myshopify.com.evil.example", "-x.myshopify.com"]) {
    await assert.rejects(run("get_shop", {}, { environment: { SHOPIFY_SHOP_DOMAIN: badDomain } }), (error) => error.kind === "invalid_input" && error.message.includes("SHOPIFY_SHOP_DOMAIN"), badDomain);
  }
  const { calls } = await run("get_shop", {}, { environment: { SHOPIFY_SHOP_DOMAIN: "https://Acme-Store.myshopify.com/" } });
  assert.equal(calls[0].url, "https://acme-store.myshopify.com/admin/api/2026-10/graphql.json");
  assert.equal(calls[0].headers["x-shopify-access-token"], "shpat_fake");
});

test("there is no free-form GraphQL: no api_request operation", () => {
  assert.equal(pluginDefinition.operations.some((operation) => operation.name === "api_request"), false);
});

test("inventory, order edits, refunds and cancellations are node only; product writes are opt-in", async () => {
  for (const operationName of ["adjust_inventory", "update_order", "create_refund", "cancel_order"]) {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly, true, operationName);
  }
  await assert.rejects(run("create_product", { product_title: "Kopi" }), (error) => error.kind === "permission_denied" && error.message.includes("SHOPIFY_TOOL_ALLOW_PRODUCTS"));
});

test("adjust_inventory and create_refund get a fresh @idempotent key unless one is given", async () => {
  const changes = [{ delta: 1, inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", changeFromQuantity: 0 }];
  const first = await run("adjust_inventory", { reason: "received", changes }, { source: "node" });
  const second = await run("adjust_inventory", { reason: "received", changes }, { source: "node" });
  const firstKey = first.calls[0].json.variables.idempotencyKey;
  assert.match(firstKey, /^[0-9a-f-]{36}$/);
  assert.notEqual(firstKey, second.calls[0].json.variables.idempotencyKey);
  const given = await run("create_refund", { order_id: "gid://shopify/Order/1", idempotency_key: "retry-key-1" }, { source: "node" });
  assert.equal(given.calls[0].json.variables.idempotencyKey, "retry-key-1");
});

test("userErrors become invalid_input errors", async () => {
  const responses = [{ body: { data: { productCreate: { product: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } } } }];
  await assert.rejects(
    run("create_product", { product_title: "x" }, { source: "node", responses }),
    (error) => error.kind === "invalid_input" && error.message.includes("title: Title can't be blank") && error.message.includes("nothing was changed"),
  );
  assert.deepEqual(listUserErrors({ orderCancelUserErrors: [{ field: null, message: "Order is already cancelled", code: "X" }] }), ["Order is already cancelled"]);
  assert.deepEqual(listUserErrors({ userErrors: [] }), []);
});

test("GraphQL throttling and token errors are mapped", async () => {
  await assert.rejects(
    run("get_shop", {}, { responses: [{ body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } }, { body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } }, { body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } }] }),
    (error) => error.kind === "rate_limited",
  );
  await assert.rejects(
    run("get_shop", {}, { responses: [{ status: 401, body: { errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" } }] }),
    (error) => error.kind === "auth_error" && error.message.includes("Invalid API key"),
  );
});
