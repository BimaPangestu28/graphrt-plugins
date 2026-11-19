import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.stripe.com/v1";

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls opt-in operations as tools (needs the cap) and api_request on "/anything".
  environment: { STRIPE_TOOL_MAX_AMOUNT: "1000000", STRIPE_TOOL_ALLOWED_CURRENCIES: "usd", STRIPE_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    list_customers: {
      args: { email: "ana@example.com", created_gte: 1700000000, limit: 10 },
      request: { method: "GET", url: `${API}/customers`, query: { email: "ana@example.com", "created[gte]": "1700000000", limit: "10" } },
      response: { body: { object: "list", data: [{ id: "cus_1" }], has_more: true } },
      expect: { data: [{ id: "cus_1" }] },
    },
    search_customers: {
      args: { query: "email~'ana'" },
      request: { method: "GET", url: `${API}/customers/search`, query: { query: "email~'ana'" } },
    },
    get_customer: { args: { customer_id: "cus_1" }, request: { method: "GET", url: `${API}/customers/cus_1`, query: "absent" } },
    create_customer: {
      args: { email: "ana@example.com", name: "Ana", metadata: { crm_id: "42" } },
      request: { method: "POST", url: `${API}/customers`, query: "absent", form: { email: "ana@example.com", name: "Ana", "metadata[crm_id]": "42" } },
    },
    update_customer: {
      args: { customer_id: "cus_1", phone: "+6281" },
      request: { method: "POST", url: `${API}/customers/cus_1`, query: "absent", form: { phone: "+6281" } },
    },
    list_payment_intents: { args: { customer: "cus_1" }, request: { method: "GET", url: `${API}/payment_intents`, query: { customer: "cus_1" } } },
    get_payment_intent: { args: { payment_intent_id: "pi_1" }, request: { method: "GET", url: `${API}/payment_intents/pi_1`, query: "absent" } },
    create_payment_intent: {
      args: { amount: 2000, currency: "usd", customer: "cus_1", metadata: { order: "A1" } },
      request: {
        method: "POST",
        url: `${API}/payment_intents`,
        query: "absent",
        form: { amount: "2000", currency: "usd", customer: "cus_1", "automatic_payment_methods[enabled]": "true", "metadata[order]": "A1" },
      },
    },
    confirm_payment_intent: {
      args: { payment_intent_id: "pi_1", payment_method: "pm_card_visa", off_session: true },
      request: { method: "POST", url: `${API}/payment_intents/pi_1/confirm`, query: "absent", form: { payment_method: "pm_card_visa", off_session: "true" } },
    },
    capture_payment_intent: {
      args: { payment_intent_id: "pi_1", amount_to_capture: 1500 },
      request: { method: "POST", url: `${API}/payment_intents/pi_1/capture`, query: "absent", form: { amount_to_capture: "1500" } },
    },
    cancel_payment_intent: {
      args: { payment_intent_id: "pi_1", cancellation_reason: "abandoned" },
      request: { method: "POST", url: `${API}/payment_intents/pi_1/cancel`, query: "absent", form: { cancellation_reason: "abandoned" } },
    },
    list_payment_links: { args: { active: true }, request: { method: "GET", url: `${API}/payment_links`, query: { active: "true" } } },
    create_payment_link: {
      args: { line_items: [{ price: "price_1", quantity: 2 }] },
      request: { method: "POST", url: `${API}/payment_links`, query: "absent", form: { "line_items[0][price]": "price_1", "line_items[0][quantity]": "2" } },
    },
    list_invoices: { args: { customer: "cus_1", status: "open" }, request: { method: "GET", url: `${API}/invoices`, query: { customer: "cus_1", status: "open" } } },
    get_invoice: { args: { invoice_id: "in_1" }, request: { method: "GET", url: `${API}/invoices/in_1`, query: "absent" } },
    create_invoice: {
      args: { customer: "cus_1", collection_method: "send_invoice", days_until_due: 14 },
      request: { method: "POST", url: `${API}/invoices`, query: "absent", form: { customer: "cus_1", collection_method: "send_invoice", days_until_due: "14", auto_advance: "false" } },
    },
    add_invoice_item: {
      args: { customer: "cus_1", invoice: "in_1", price: "price_1", quantity: 3 },
      request: { method: "POST", url: `${API}/invoiceitems`, query: "absent", form: { customer: "cus_1", invoice: "in_1", "pricing[price]": "price_1", quantity: "3" } },
    },
    finalize_invoice: { args: { invoice_id: "in_1" }, request: { method: "POST", url: `${API}/invoices/in_1/finalize`, query: "absent", form: {} } },
    send_invoice: { args: { invoice_id: "in_1" }, request: { method: "POST", url: `${API}/invoices/in_1/send`, query: "absent", body: "absent" } },
    pay_invoice: {
      args: { invoice_id: "in_1", paid_out_of_band: true },
      request: { method: "POST", url: `${API}/invoices/in_1/pay`, query: "absent", form: { paid_out_of_band: "true" } },
    },
    list_products: { args: { active: true }, request: { method: "GET", url: `${API}/products`, query: { active: "true" } } },
    get_product: { args: { product_id: "prod_1" }, request: { method: "GET", url: `${API}/products/prod_1`, query: "absent" } },
    create_product: { args: { name: "T-shirt" }, request: { method: "POST", url: `${API}/products`, query: "absent", form: { name: "T-shirt" } } },
    list_prices: { args: { product: "prod_1" }, request: { method: "GET", url: `${API}/prices`, query: { product: "prod_1" } } },
    create_price: {
      args: { product: "prod_1", unit_amount: 1000, currency: "usd", recurring_interval: "month" },
      request: { method: "POST", url: `${API}/prices`, query: "absent", form: { product: "prod_1", unit_amount: "1000", currency: "usd", "recurring[interval]": "month" } },
    },
    list_charges: { args: { payment_intent: "pi_1" }, request: { method: "GET", url: `${API}/charges`, query: { payment_intent: "pi_1" } } },
    get_charge: { args: { charge_id: "ch_1" }, request: { method: "GET", url: `${API}/charges/ch_1`, query: "absent" } },
    get_balance: { args: {}, request: { method: "GET", url: `${API}/balance`, query: "absent" }, response: { body: { object: "balance", available: [{ amount: 5, currency: "usd" }] } } },
    list_balance_transactions: {
      args: { transaction_type: "payout", currency: "usd" },
      request: { method: "GET", url: `${API}/balance_transactions`, query: { type: "payout", currency: "usd" } },
    },
    list_refunds: { args: { charge: "ch_1" }, request: { method: "GET", url: `${API}/refunds`, query: { charge: "ch_1" } } },
    create_refund: {
      args: { payment_intent: "pi_1", amount: 500, reason: "requested_by_customer" },
      request: { method: "POST", url: `${API}/refunds`, query: "absent", form: { payment_intent: "pi_1", amount: "500", reason: "requested_by_customer" } },
    },
    list_subscriptions: { args: { customer: "cus_1", status: "all" }, request: { method: "GET", url: `${API}/subscriptions`, query: { customer: "cus_1", status: "all" } } },
    get_subscription: { args: { subscription_id: "sub_1" }, request: { method: "GET", url: `${API}/subscriptions/sub_1`, query: "absent" } },
    cancel_subscription: {
      args: { subscription_id: "sub_1", prorate: true },
      request: { method: "DELETE", url: `${API}/subscriptions/sub_1`, query: { prorate: "true" }, body: "absent" },
    },
  },
});
