import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api-m.sandbox.paypal.com";
const usdUnits = [{ reference_id: "o-1", amount: { currency_code: "USD", value: "25.00" } }];

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls opt-in operations as tools (needs the cap) and api_request on "/anything".
  environment: { PAYPAL_TOOL_MAX_AMOUNT: "1000", PAYPAL_TOOL_ALLOWED_CURRENCIES: "USD", PAYPAL_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    create_order: {
      args: { purchase_units: usdUnits, return_url: "https://shop.example/return" },
      request: {
        method: "POST",
        url: `${API}/v2/checkout/orders`,
        query: "absent",
        headers: { prefer: "return=representation" },
        json: { intent: "CAPTURE", purchase_units: usdUnits, payment_source: { paypal: { experience_context: { return_url: "https://shop.example/return" } } } },
      },
    },
    get_order: { args: { order_id: "5O1" }, request: { method: "GET", url: `${API}/v2/checkout/orders/5O1`, query: "absent" } },
    capture_order: { args: { order_id: "5O1" }, request: { method: "POST", url: `${API}/v2/checkout/orders/5O1/capture`, query: "absent", body: "absent" } },
    authorize_order: { args: { order_id: "5O1" }, request: { method: "POST", url: `${API}/v2/checkout/orders/5O1/authorize`, query: "absent", body: "absent" } },
    get_capture: { args: { capture_id: "CAP1" }, request: { method: "GET", url: `${API}/v2/payments/captures/CAP1`, query: "absent" } },
    refund_capture: {
      args: { capture_id: "CAP1", amount_value: "5.00", amount_currency_code: "USD", note_to_payer: "Sorry" },
      request: { method: "POST", url: `${API}/v2/payments/captures/CAP1/refund`, query: "absent", json: { amount: { value: "5.00", currency_code: "USD" }, note_to_payer: "Sorry" } },
    },
    get_refund: { args: { refund_id: "R1" }, request: { method: "GET", url: `${API}/v2/payments/refunds/R1`, query: "absent" } },
    get_authorization: { args: { authorization_id: "A1" }, request: { method: "GET", url: `${API}/v2/payments/authorizations/A1`, query: "absent" } },
    capture_authorization: {
      args: { authorization_id: "A1", final_capture: true },
      request: { method: "POST", url: `${API}/v2/payments/authorizations/A1/capture`, query: "absent", json: { final_capture: true } },
    },
    void_authorization: { args: { authorization_id: "A1" }, request: { method: "POST", url: `${API}/v2/payments/authorizations/A1/void`, query: "absent", body: "absent" } },
    list_invoices: {
      args: { limit: 20 },
      request: { method: "GET", url: `${API}/v2/invoicing/invoices`, query: { total_required: "true", page_size: "20" } },
      response: { body: { items: [{ id: "INV2-1" }], total_pages: 3 } },
      expect: { data: [{ id: "INV2-1" }] },
    },
    get_invoice: { args: { invoice_id: "INV2-1" }, request: { method: "GET", url: `${API}/v2/invoicing/invoices/INV2-1`, query: "absent" } },
    create_invoice: {
      args: { currency_code: "USD", note: "Thanks", primary_recipients: [{ billing_info: { email_address: "ana@example.com" } }], items: [{ name: "Kopi", quantity: "1", unit_amount: { currency_code: "USD", value: "9.00" } }] },
      request: {
        method: "POST",
        url: `${API}/v2/invoicing/invoices`,
        query: "absent",
        json: {
          detail: { currency_code: "USD", note: "Thanks" },
          primary_recipients: [{ billing_info: { email_address: "ana@example.com" } }],
          items: [{ name: "Kopi", quantity: "1", unit_amount: { currency_code: "USD", value: "9.00" } }],
        },
      },
    },
    send_invoice: { args: { invoice_id: "INV2-1" }, request: { method: "POST", url: `${API}/v2/invoicing/invoices/INV2-1/send`, query: "absent", json: { send_to_recipient: true } } },
    get_balances: { args: { currency_code: "USD" }, request: { method: "GET", url: `${API}/v1/reporting/balances`, query: { currency_code: "USD" } } },
    list_transactions: {
      args: { start_date: "2026-11-01T00:00:00-0000", end_date: "2026-11-15T00:00:00-0000" },
      request: { method: "GET", url: `${API}/v1/reporting/transactions`, query: { start_date: "2026-11-01T00:00:00-0000", end_date: "2026-11-15T00:00:00-0000", fields: "transaction_info,payer_info" } },
    },
    create_payout: {
      args: { sender_batch_id: "batch-1", payout_items: [{ recipient_type: "EMAIL", amount: { value: "1.00", currency: "USD" }, receiver: "ana@example.com" }] },
      request: {
        method: "POST",
        url: `${API}/v1/payments/payouts`,
        query: "absent",
        json: { sender_batch_header: { sender_batch_id: "batch-1" }, items: [{ recipient_type: "EMAIL", amount: { value: "1.00", currency: "USD" }, receiver: "ana@example.com" }] },
      },
    },
    get_payout_batch: { args: { payout_batch_id: "PB1" }, request: { method: "GET", url: `${API}/v1/payments/payouts/PB1`, query: "absent" } },
  },
});
