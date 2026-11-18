import { test } from "node:test";
import assert from "node:assert/strict";
import { runExpectingError } from "./helpers.mjs";

const DAY = 86400;
const WINDOW_START = 1763424000;

// Each case: operation + args that must be rejected with invalid_input before any request is sent.
const INVALID_INPUT_CASES = [
  ["get_order_list", { time_from: WINDOW_START, time_to: WINDOW_START + 15 * DAY + 1 }, /15 days/],
  ["get_order_list", { time_from: WINDOW_START, time_to: WINDOW_START }, /after/],
  ["get_order_list", { time_from: WINDOW_START + DAY, time_to: WINDOW_START }, /after/],
  ["get_order_list", { time_from: WINDOW_START * 1000, time_to: (WINDOW_START + DAY) * 1000 }, /seconds/],
  ["get_order_list", { time_from: WINDOW_START }, /time_to/],
  ["get_item_list", { cursor: "abc" }, /cursor/],
  ["get_item_list", { item_status: [] }, /item_status/],
  ["get_item_list", { update_time_from: 1763424000000 }, /seconds/],
  ["get_item_list", { update_time_from: WINDOW_START + DAY, update_time_to: WINDOW_START }, /update_time_from/],
  ["get_item_base_info", { item_ids: [] }, /1-50/],
  ["get_item_base_info", { item_ids: Array.from({ length: 51 }, (_, index) => index + 1) }, /at most 50/],
  ["get_order_detail", { order_sns: ["A", ""] }, /invalid id|empty/],
  ["update_stock", { item_id: 1, stock_list: [] }, /at least one/],
  ["update_stock", { item_id: 1, stock_list: [{ stock: -1 }] }, /stock/],
  ["update_stock", { item_id: 1, stock_list: [{ stock: 1.5 }] }, /stock/],
  ["update_stock", { item_id: 1, stock_list: [{ model_id: "abc", stock: 1 }] }, /model_id/],
  ["update_stock", { item_id: -4, stock_list: [{ stock: 1 }] }, /item_id/],
  ["update_stock", { item_id: 1, stock_list: [{ model_id: 2, stock: 1 }, { model_id: 2, stock: 3 }] }, /repeats/],
  ["update_stock", { item_id: 1, stock_list: [{ stock: 1 }, { model_id: 0, stock: 3 }] }, /repeats/],
  ["update_stock", { item_id: 1, stock_list: [{ model_id: 2, location_id: "W1", stock: 1 }, { model_id: 2, location_id: "W1", stock: 3 }] }, /repeats/],
  ["update_price", { item_id: 1, price_list: [{ original_price: 0 }] }, /original_price/],
  ["update_price", { item_id: 1, price_list: [{ model_id: 2, original_price: 1 }, { model_id: 2, original_price: 2 }] }, /repeats/],
  ["ship_order", { order_sn: "A" }, /exactly one/],
  ["ship_order", { order_sn: "A", pickup: {}, dropoff: {} }, /exactly one/],
  ["sellerchat_send_message", { to_id: "1" }, /text/],
  ["sellerchat_send_message", { to_id: "1", text: "x".repeat(2001) }, /2000/],
  ["sellerchat_send_message", { to_id: "buyer-name", text: "hi" }, /to_id/],
  ["sellerchat_send_message", { to_id: "1", message_type: "image" }, /image_url/],
  ["sellerchat_send_message", { to_id: "1", message_type: "sticker", text: "hi" }, /message_type/],
];

for (const [operationName, args, messagePattern] of INVALID_INPUT_CASES) {
  test(`${operationName} rejects ${JSON.stringify(args).slice(0, 120)}`, async () => {
    const { error, calls } = await runExpectingError(operationName, args);
    assert.equal(error.kind, "invalid_input");
    assert.match(error.message, messagePattern);
    assert.equal(calls.length, 0);
  });
}
