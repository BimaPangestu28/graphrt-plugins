import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.xendit.co";

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls opt-in operations as tools (needs the cap) and api_request on "/anything".
  environment: { XENDIT_TOOL_MAX_AMOUNT: "10000000", XENDIT_TOOL_ALLOWED_CURRENCIES: "IDR", XENDIT_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    create_invoice: {
      args: { external_id: "INV-1", amount: 150000, description: "Kopi", items: [{ name: "Kopi", quantity: 1, price: 150000 }], payment_methods: ["QRIS"] },
      request: {
        method: "POST",
        url: `${API}/v2/invoices`,
        query: "absent",
        json: { external_id: "INV-1", amount: 150000, currency: "IDR", description: "Kopi", items: [{ name: "Kopi", quantity: 1, price: 150000 }], payment_methods: ["QRIS"] },
      },
      response: { body: { id: "inv_1", invoice_url: "https://checkout.xendit.co/web/inv_1", status: "PENDING" } },
      expect: { data: { id: "inv_1", invoice_url: "https://checkout.xendit.co/web/inv_1", status: "PENDING" } },
    },
    get_invoice: { args: { invoice_id: "inv_1" }, request: { method: "GET", url: `${API}/v2/invoices/inv_1`, query: "absent" } },
    list_invoices: {
      args: { statuses: ["PAID", "SETTLED"], created_after: "2026-01-01T00:00:00Z", limit: 20 },
      request: { method: "GET", url: `${API}/v2/invoices`, query: { statuses: ["PAID", "SETTLED"], created_after: "2026-01-01T00:00:00Z", limit: "20" } },
      response: { body: [{ id: "inv_1" }, { id: "inv_2" }] },
      expect: { data: [{ id: "inv_1" }, { id: "inv_2" }] },
    },
    expire_invoice: { args: { invoice_id: "inv_1" }, request: { method: "POST", url: `${API}/invoices/inv_1/expire!`, query: "absent", body: "absent" } },
    create_payment_request: {
      args: { reference_id: "ord-1", currency: "IDR", request_amount: 50000, country: "ID", channel_code: "QRIS" },
      request: {
        method: "POST",
        url: `${API}/v3/payment_requests`,
        query: "absent",
        headers: { "api-version": "2024-11-11" },
        json: { reference_id: "ord-1", type: "PAY", currency: "IDR", request_amount: 50000, country: "ID", channel_code: "QRIS" },
      },
    },
    get_payment_request: {
      args: { payment_request_id: "pr-1" },
      request: { method: "GET", url: `${API}/v3/payment_requests/pr-1`, query: "absent", headers: { "api-version": "2024-11-11" } },
    },
    get_balance: { args: { account_type: "CASH", currency: "IDR" }, request: { method: "GET", url: `${API}/balance`, query: { account_type: "CASH", currency: "IDR" } } },
    list_transactions: {
      args: { types: ["PAYMENT", "REFUND"], created_gte: "2026-01-01T00:00:00Z", limit: 10 },
      request: { method: "GET", url: `${API}/transactions`, query: { types: ["PAYMENT", "REFUND"], "created[gte]": "2026-01-01T00:00:00Z", limit: "10" } },
      response: { body: { has_more: true, data: [{ id: "txn_1" }] } },
      expect: { data: [{ id: "txn_1" }] },
    },
    create_refund: {
      args: { invoice_id: "inv_1", amount: 1000, reason: "REQUESTED_BY_CUSTOMER" },
      request: { method: "POST", url: `${API}/refunds`, query: "absent", json: { invoice_id: "inv_1", amount: 1000, reason: "REQUESTED_BY_CUSTOMER" } },
    },
    get_refund: { args: { refund_id: "rfd-1" }, request: { method: "GET", url: `${API}/refunds/rfd-1`, query: "absent" } },
    create_payout: {
      args: { reference_id: "po-1", recipient: { type: "INDIVIDUAL" }, payout_details: { source_currency: "IDR", source_amount: 10000 }, source_of_fund: "BUSINESS_REVENUE", purpose_code: "SALARY" },
      request: {
        method: "POST",
        url: `${API}/v3/payouts`,
        query: "absent",
        headers: { "api-version": "2025-09-01" },
        json: { reference_id: "po-1", recipient: { type: "INDIVIDUAL" }, payout_details: { source_currency: "IDR", source_amount: 10000 }, source_of_fund: "BUSINESS_REVENUE", purpose_code: "SALARY" },
      },
    },
    get_payout: { args: { payout_id: "po_1" }, request: { method: "GET", url: `${API}/v3/payouts/po_1`, query: "absent", headers: { "api-version": "2025-09-01" } } },
  },
});
