import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const CORE = "https://api.sandbox.midtrans.com";
const SNAP = "https://app.sandbox.midtrans.com";

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls opt-in operations as tools (needs the cap) and api_request on "/anything".
  environment: { MIDTRANS_TOOL_MAX_AMOUNT: "10000000", MIDTRANS_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    create_snap_transaction: {
      args: {
        order_id: "ORDER-1",
        gross_amount: 25000,
        item_details: [{ id: "sku-1", name: "Kopi", price: 25000, quantity: 1 }],
        customer_details: { first_name: "Ana", email: "ana@example.com" },
        enabled_payments: ["qris"],
        expiry_duration: 30,
        expiry_unit: "minute",
      },
      request: {
        method: "POST",
        url: `${SNAP}/snap/v1/transactions`,
        query: "absent",
        json: {
          transaction_details: { order_id: "ORDER-1", gross_amount: 25000 },
          item_details: [{ id: "sku-1", name: "Kopi", price: 25000, quantity: 1 }],
          customer_details: { first_name: "Ana", email: "ana@example.com" },
          enabled_payments: ["qris"],
          expiry: { duration: 30, unit: "minute" },
        },
      },
      response: { status: 201, body: { token: "tok", redirect_url: `${SNAP}/snap/v3/redirection/tok` } },
      expect: { data: { token: "tok", redirect_url: `${SNAP}/snap/v3/redirection/tok` } },
    },
    get_transaction_status: {
      args: { order_id: "ORDER-1" },
      request: { method: "GET", url: `${CORE}/v2/ORDER-1/status`, query: "absent" },
      response: { body: { status_code: "407", transaction_status: "expire" } },
      expect: { data: { status_code: "407", transaction_status: "expire" } },
    },
    get_b2b_transaction_status: { args: { order_id: "B-1", page: 0, per_page: 10 }, request: { method: "GET", url: `${CORE}/v2/B-1/status/b2b`, query: { page: "0", per_page: "10" } } },
    cancel_transaction: { args: { order_id: "ORDER-1" }, request: { method: "POST", url: `${CORE}/v2/ORDER-1/cancel`, query: "absent", body: "absent" } },
    expire_transaction: { args: { order_id: "ORDER-1" }, request: { method: "POST", url: `${CORE}/v2/ORDER-1/expire`, query: "absent", body: "absent" } },
    refund_transaction: {
      args: { order_id: "ORDER-1", refund_key: "r-1", amount: 5000, reason: "damaged" },
      request: { method: "POST", url: `${CORE}/v2/ORDER-1/refund`, query: "absent", json: { refund_key: "r-1", amount: 5000, reason: "damaged" } },
    },
    direct_refund_transaction: {
      args: { order_id: "ORDER-1", refund_key: "r-2" },
      request: { method: "POST", url: `${CORE}/v2/ORDER-1/refund/online/direct`, query: "absent", json: { refund_key: "r-2" } },
    },
    approve_transaction: { args: { order_id: "ORDER-1" }, request: { method: "POST", url: `${CORE}/v2/ORDER-1/approve`, query: "absent", body: "absent" } },
    deny_transaction: { args: { order_id: "ORDER-1" }, request: { method: "POST", url: `${CORE}/v2/ORDER-1/deny`, query: "absent", body: "absent" } },
    capture_transaction: {
      args: { transaction_id: "tx-1", gross_amount: 10000 },
      request: { method: "POST", url: `${CORE}/v2/capture`, query: "absent", json: { transaction_id: "tx-1", gross_amount: 10000 } },
    },
  },
});
