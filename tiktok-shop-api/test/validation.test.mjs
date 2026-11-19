import { test } from "node:test";
import assert from "node:assert/strict";
import { runExpectingError } from "./helpers.mjs";

// Each case: operation + args that must be rejected with invalid_input before any request is sent.
const INVALID_INPUT_CASES = [
  ["get_product", { product_id: "../shops" }, /product_id/],
  ["get_product", { product_id: "abc" }, /product_id/],
  ["get_order_detail", { order_ids: [] }, /1-50/],
  ["get_order_detail", { order_ids: Array.from({ length: 51 }, (_, index) => String(index + 1)) }, /at most 50/],
  ["get_order_detail", { order_ids: ["1", "x2"] }, /order_ids\[1\]/],
  ["update_inventory", { product_id: "1", skus: [] }, /at least one/],
  ["update_inventory", { product_id: "1", skus: [{ sku_id: "2", quantity: -1 }] }, /quantity/],
  ["update_inventory", { product_id: "1", skus: [{ sku_id: "2", quantity: 1000000 }] }, /quantity/],
  ["update_inventory", { product_id: "1", skus: [{ sku_id: "2", quantity: 2.5 }] }, /quantity/],
  ["update_inventory", { product_id: "1", skus: [{ quantity: 1 }] }, /sku_id/],
  ["update_inventory", { product_id: "1", skus: [{ sku_id: "2", quantity: 1 }, { sku_id: "2", quantity: 3 }] }, /repeats/],
  ["update_inventory", { product_id: "1", skus: [{ sku_id: "2", quantity: 1, warehouse_id: "9" }, { sku_id: "2", quantity: 3, warehouse_id: "9" }] }, /repeats/],
  ["update_price", { product_id: "1", currency: "idr", skus: [{ sku_id: "2", amount: "5" }] }, /currency/],
  ["update_price", { product_id: "1", currency: "RUPIAH", skus: [{ sku_id: "2", amount: "5" }] }, /currency/],
  ["update_price", { product_id: "1", currency: "US", skus: [{ sku_id: "2", amount: "5" }] }, /currency/],
  ["update_price", { product_id: "1", currency: "IDR", skus: [{ sku_id: "2", amount: "1500.5" }] }, /whole number/],
  ["update_price", { product_id: "1", currency: "JPY", skus: [{ sku_id: "2", amount: 99.9 }] }, /whole number/],
  ["update_price", { product_id: "1", currency: "KRW", skus: [{ sku_id: "2", amount: "100.00" }] }, /whole number/],
  ["update_price", { product_id: "1", currency: "VND", skus: [{ sku_id: "2", amount: "100.1" }] }, /whole number/],
  ["update_price", { product_id: "1", currency: "IDR", skus: [{ sku_id: "2", amount: "-5" }] }, /amount/],
  ["update_price", { product_id: "1", currency: "IDR", skus: [{ sku_id: "2", amount: "0" }] }, /amount/],
  ["update_price", { product_id: "1", currency: "IDR", skus: [{ sku_id: "2", amount: "1" }, { sku_id: "2", amount: "2" }] }, /repeats/],
  ["search_orders", { create_time_ge: 1763424000000 }, /seconds/],
  ["search_orders", { create_time_ge: 1763510400, create_time_lt: 1763424000 }, /after/],
  ["search_products", { update_time_ge: 1763510400, update_time_le: 1763424000 }, /after/],
  ["search_returns", { limit: 5 }, />= 10/],
  ["search_returns", { order_ids: ["A1"] }, /order_ids/],
  ["get_package_shipping_document", { package_id: "1/2" }, /package_id/],
  ["get_conversation_messages", { conversation_id: "1", limit: 11 }, /<= 10/],
  ["get_conversations", { limit: 21 }, /<= 20/],
  ["send_message", { conversation_id: "1" }, /text/],
  ["send_message", { conversation_id: "1", text: "x".repeat(2001) }, /2000/],
  ["send_message", { conversation_id: "1", message_type: "PRODUCT_CARD" }, /content/],
  ["send_message", { conversation_id: "conv/../x", text: "hi" }, /conversation_id/],
];

for (const [operationName, args, messagePattern] of INVALID_INPUT_CASES) {
  test(`${operationName} rejects ${JSON.stringify(args).slice(0, 120)}`, async () => {
    const { error, calls } = await runExpectingError(operationName, args);
    assert.equal(error.kind, "invalid_input");
    assert.match(error.message, messagePattern);
    assert.equal(calls.length, 0);
  });
}
