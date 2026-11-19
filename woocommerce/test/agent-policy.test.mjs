import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const baseEnvironment = { WOOCOMMERCE_SITE_URL: "https://shop.example.com", WOOCOMMERCE_CONSUMER_KEY: "ck_fake", WOOCOMMERCE_CONSUMER_SECRET: "cs_fake" };

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: { id: 1 } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { ...baseEnvironment, ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);

test("WOOCOMMERCE_SITE_URL must be https without credentials, query or fragment; a subdirectory is kept", async () => {
  for (const badUrl of ["", "shop.example.com", "http://shop.example.com", "https://user:pw@shop.example.com", "https://shop.example.com/?x=1", "https://shop.example.com/#a"]) {
    await assert.rejects(run("get_order", { order_id: 1 }, { environment: { WOOCOMMERCE_SITE_URL: badUrl } }), (error) => error.kind === "invalid_input" && error.message.includes("WOOCOMMERCE_SITE_URL"), badUrl);
  }
  const { calls } = await run("get_order", { order_id: 1 }, { environment: { WOOCOMMERCE_SITE_URL: "https://example.com/store/" } });
  assert.equal(calls[0].url, "https://example.com/store/wp-json/wc/v3/orders/1");
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("ck_fake:cs_fake").toString("base64")}`);
  assert.equal(calls[0].url.includes("consumer_"), false);
});

test("update_product as a tool needs the opt-in and may not change prices or stock", async () => {
  await assert.rejects(run("update_product", { product_id: 1, name: "x" }), isDenied("WOOCOMMERCE_TOOL_ALLOW_PRODUCTS"));
  const environment = { WOOCOMMERCE_TOOL_ALLOW_PRODUCTS: "1" };
  for (const priceOrStock of [{ regular_price: "1.00" }, { sale_price: "0.50" }, { stock_quantity: 0 }, { manage_stock: false }, { stock_status: "outofstock" }]) {
    await assert.rejects(run("update_product", { product_id: 1, ...priceOrStock }, { environment }), isDenied("price and stock changes are node only"), JSON.stringify(priceOrStock));
  }
  const { calls } = await run("update_product", { product_id: 1, name: "Kopi" }, { environment });
  assert.equal(calls.length, 1);
  const node = await run("update_product", { product_id: 1, regular_price: "9.00", stock_quantity: 4 }, { source: "node" });
  assert.deepEqual(node.calls[0].json, { regular_price: "9.00", stock_quantity: 4 });
});

test("update_order_status as a tool may only set on-hold (no processing/completed on unpaid orders, no cancel, refund or fail)", async () => {
  await assert.rejects(run("update_order_status", { order_id: 1, status: "completed" }), isDenied("WOOCOMMERCE_TOOL_ALLOW_ORDER_STATUS"));
  const environment = { WOOCOMMERCE_TOOL_ALLOW_ORDER_STATUS: "1" };
  for (const status of ["processing", "completed", "pending", "cancelled", "refunded", "failed", "draft"]) {
    await assert.rejects(run("update_order_status", { order_id: 1, status }, { environment }), isDenied("node only"), status);
  }
  const { calls } = await run("update_order_status", { order_id: 1, status: "on-hold" }, { environment });
  assert.equal(calls.length, 1);
  const node = await run("update_order_status", { order_id: 1, status: "refunded" }, { source: "node" });
  assert.equal(node.calls.length, 1);
});

test("refunds are node only", () => {
  assert.equal(pluginDefinition.operations.find((operation) => operation.name === "create_refund").nodeOnly, true);
});

test("api_request as a tool cannot reach settings, payment gateways, system status or webhooks", async () => {
  for (const blockedPath of ["/payment_gateways", "/payment_gateways/stripe", "/settings/general", "/system_status", "/webhooks", "/data", "/products/../payment_gateways"]) {
    await assert.rejects(run("api_request", { path: blockedPath }), isDenied("api_request cannot reach"), blockedPath);
  }
  const { calls } = await run("api_request", { path: "/reports/sales" });
  assert.equal(calls[0].url, "https://shop.example.com/wp-json/wc/v3/reports/sales");
});

test("WooCommerce error codes map to kinds", async () => {
  await assert.rejects(run("get_product", { product_id: 9 }, { responses: [{ status: 404, body: { code: "woocommerce_rest_product_invalid_id", message: "Invalid ID.", data: { status: 404 } } }] }), (error) => error.kind === "not_found" && error.message.includes("Invalid ID."));
  await assert.rejects(run("get_product", { product_id: 9 }, { responses: [{ status: 401, body: { code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot view this resource.", data: { status: 401 } } }] }), (error) => error.kind === "permission_denied");
});
