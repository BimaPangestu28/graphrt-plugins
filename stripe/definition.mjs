/**
 * stripe plugin definition: customers, PaymentIntents, payment links, invoices, products and prices, charges,
 * balance, refunds and subscriptions through the Stripe API (https://docs.stripe.com/api), pinned to one
 * Stripe-Version. Built with the declarative REST layer (docs/declarative-plugins.md) plus three wrappers:
 *   - lib/tool-amount-cap.mjs: agent-created PaymentIntents need STRIPE_TOOL_MAX_AMOUNT and a listed currency;
 *   - lib/tool-secret-fields.mjs: `client_secret` is removed from everything agent tools see;
 *   - lib/tool-path-policy.mjs: api_request for tools only reaches an allowlist of read paths.
 *
 * Agent policy: reads are tools. Customers, products, prices (capped) and draft invoices need
 * STRIPE_TOOL_ALLOW_WRITE=1; payment links ({price, quantity <= 100} only) STRIPE_TOOL_ALLOW_PAYMENT_LINKS=1;
 * PaymentIntents STRIPE_TOOL_ALLOW_PAYMENT_INTENTS=1 plus the cap. Adding invoice items is node only.
 * Confirming, capturing and cancelling PaymentIntents, finalizing, sending and paying invoices, refunds and
 * subscription cancellation are node only. Every create sends a fresh Idempotency-Key.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { limitToolLineItems, normalizeCurrencyArguments } from "./lib/stripe-argument-policy.mjs";
import { capToolAmounts } from "./lib/tool-amount-cap.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { stripSecretFieldsForTools } from "./lib/tool-secret-fields.mjs";

export const STRIPE_API_VERSION = "2026-10-28.endive";
const WRITE_POLICY = "optIn:STRIPE_TOOL_ALLOW_WRITE";
const PAYMENT_LINK_POLICY = "optIn:STRIPE_TOOL_ALLOW_PAYMENT_LINKS";
const PAYMENT_INTENT_POLICY = "optIn:STRIPE_TOOL_ALLOW_PAYMENT_INTENTS";
const ID = "[^/]+";
// GET paths agent tools may reach through api_request (normalized: lowercase, decoded, dot segments resolved).
// PaymentIntents, SetupIntents, Checkout Sessions and events (they embed client secrets) are not listed, nor are
// Issuing (card numbers), Apps secrets, webhook endpoints, Connect accounts and anything else.
const TOOL_API_PATHS = [
  `/v1/customers(/${ID}(/(invoices|balance_transactions|tax_ids))?)?`,
  `/v1/charges(/${ID})?`,
  "/v1/balance",
  `/v1/balance_transactions(/${ID})?`,
  `/v1/invoices(/${ID}(/lines)?)?`,
  `/v1/invoiceitems(/${ID})?`,
  `/v1/products(/${ID})?`,
  `/v1/prices(/${ID})?`,
  `/v1/subscriptions(/${ID})?`,
  `/v1/refunds(/${ID})?`,
  `/v1/disputes(/${ID})?`,
  `/v1/payouts(/${ID})?`,
  `/v1/payment_links(/${ID}(/line_items)?)?`,
  `/v1/coupons(/${ID})?`,
  `/v1/promotion_codes(/${ID})?`,
].map((pattern) => new RegExp(`^${pattern}$`));

const lastItemPages = { dataPath: "data", lastItemCursor: { itemIdPath: "id", param: "starting_after", hasMorePath: "has_more" }, limitParam: "limit", maxLimit: 100 };
const searchPages = { dataPath: "data", cursorPath: "next_page", cursorParam: "page", hasMorePath: "has_more", limitParam: "limit", maxLimit: 100 };
const idParam = (description) => ({ in: "path", type: "string", required: true, minLength: 1, description });
const metadataParam = { in: "body", type: "object", description: "Key-value pairs (strings) stored on the object" };
const currencyParam = { in: "body", type: "string", required: true, minLength: 3, description: "Three-letter ISO currency code, lowercase (e.g. usd, idr)" };
const createdFilters = {
  created_gte: { in: "query", type: "integer", wireName: "created[gte]", description: "Created at or after (Unix seconds)" },
  created_lte: { in: "query", type: "integer", wireName: "created[lte]", description: "Created at or before (Unix seconds)" },
};

// --- customers --------------------------------------------------------------------------------------

const customerOperations = [
  {
    name: "list_customers",
    title: "List customers",
    description: "List customers, newest first, optionally by exact email",
    path: "/v1/customers",
    params: { email: { in: "query", type: "string", description: "Exact email (case-sensitive)" }, ...createdFilters },
    response: lastItemPages,
  },
  {
    name: "search_customers",
    title: "Search customers",
    description: "Search customers with Stripe search syntax, e.g. email~'ana' or metadata['crm_id']:'42' (not for read-after-write: results lag up to a minute)",
    path: "/v1/customers/search",
    params: { query: { in: "query", type: "string", required: true, minLength: 1, description: "Search query (https://docs.stripe.com/search#search-query-language)" } },
    response: searchPages,
  },
  { name: "get_customer", title: "Get customer", description: "Retrieve a customer", path: "/v1/customers/{customer_id}", params: { customer_id: idParam("Customer id (cus_...)") } },
  {
    name: "create_customer",
    title: "Create customer",
    description: "Create a customer",
    method: "POST",
    path: "/v1/customers",
    bodyMode: "form",
    write: "unsafe",
    toolPolicy: WRITE_POLICY,
    checkHint: "search_customers by email",
    params: {
      email: { in: "body", type: "string" },
      name: { in: "body", type: "string" },
      phone: { in: "body", type: "string" },
      description: { in: "body", type: "string" },
      metadata: metadataParam,
    },
  },
  {
    name: "update_customer",
    title: "Update customer",
    description: "Update a customer's email, name, phone, description or metadata",
    method: "POST",
    path: "/v1/customers/{customer_id}",
    bodyMode: "form",
    write: "unsafe",
    toolPolicy: WRITE_POLICY,
    checkHint: "get_customer",
    params: {
      customer_id: idParam("Customer id (cus_...)"),
      email: { in: "body", type: "string" },
      name: { in: "body", type: "string" },
      phone: { in: "body", type: "string" },
      description: { in: "body", type: "string" },
      metadata: metadataParam,
    },
  },
];

// --- PaymentIntents -----------------------------------------------------------------------------------

const paymentIntentOperations = [
  {
    name: "list_payment_intents",
    title: "List PaymentIntents",
    description: "List PaymentIntents, newest first (client_secret is removed for agent tools)",
    path: "/v1/payment_intents",
    params: { customer: { in: "query", type: "string", description: "Customer id" }, ...createdFilters },
    response: lastItemPages,
  },
  { name: "get_payment_intent", title: "Get PaymentIntent", description: "Retrieve a PaymentIntent (client_secret is removed for agent tools)", path: "/v1/payment_intents/{payment_intent_id}", params: { payment_intent_id: idParam("PaymentIntent id (pi_...)") } },
  {
    name: "create_payment_intent",
    title: "Create PaymentIntent",
    description:
      "Create an unconfirmed PaymentIntent (no money moves until it is confirmed with confirm_payment_intent or by the customer with its client_secret). Agent tools also need STRIPE_TOOL_MAX_AMOUNT and the currency in STRIPE_TOOL_ALLOWED_CURRENCIES",
    method: "POST",
    path: "/v1/payment_intents",
    bodyMode: "form",
    write: "unsafe",
    toolPolicy: PAYMENT_INTENT_POLICY,
    checkHint: "list_payment_intents for the customer",
    params: {
      amount: { in: "body", type: "integer", required: true, min: 1, description: "Amount in the smallest currency unit (cents; 100 = $1.00)" },
      currency: currencyParam,
      customer: { in: "body", type: "string", description: "Customer id" },
      description: { in: "body", type: "string" },
      capture_method: { in: "body", type: "string", enum: ["automatic", "automatic_async", "manual"], description: "manual places a hold that capture_payment_intent collects later" },
      automatic_payment_methods: { in: "body", type: "boolean", default: true, wireName: "automatic_payment_methods.enabled", description: "Accept the payment methods enabled in the Dashboard" },
      statement_descriptor_suffix: { in: "body", type: "string", description: "Card statement suffix (max 22 characters)" },
      metadata: metadataParam,
    },
  },
  {
    name: "confirm_payment_intent",
    title: "Confirm PaymentIntent",
    description: "Confirm a PaymentIntent with a payment method: this charges the customer",
    method: "POST",
    path: "/v1/payment_intents/{payment_intent_id}/confirm",
    bodyMode: "form",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_payment_intent and look at status",
    params: {
      payment_intent_id: idParam("PaymentIntent id (pi_...)"),
      payment_method: { in: "body", type: "string", description: "PaymentMethod id (pm_...)" },
      off_session: { in: "body", type: "boolean", description: "The customer is not present (saved card)" },
      return_url: { in: "body", type: "string", description: "Where redirect-based methods return the customer" },
    },
  },
  {
    name: "capture_payment_intent",
    title: "Capture PaymentIntent",
    description: "Capture the held funds of a PaymentIntent created with capture_method=manual",
    method: "POST",
    path: "/v1/payment_intents/{payment_intent_id}/capture",
    bodyMode: "form",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_payment_intent and look at amount_received",
    params: {
      payment_intent_id: idParam("PaymentIntent id (pi_...)"),
      amount_to_capture: { in: "body", type: "integer", min: 1, description: "Capture less than the authorized amount (smallest currency unit)" },
    },
  },
  {
    name: "cancel_payment_intent",
    title: "Cancel PaymentIntent",
    description: "Cancel a PaymentIntent (releases any hold)",
    method: "POST",
    path: "/v1/payment_intents/{payment_intent_id}/cancel",
    bodyMode: "form",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_payment_intent and look at status",
    params: {
      payment_intent_id: idParam("PaymentIntent id (pi_...)"),
      cancellation_reason: { in: "body", type: "string", enum: ["duplicate", "fraudulent", "requested_by_customer", "abandoned"] },
    },
  },
];

// --- payment links -------------------------------------------------------------------------------------

const paymentLinkOperations = [
  { name: "list_payment_links", title: "List payment links", description: "List payment links", path: "/v1/payment_links", params: { active: { in: "query", type: "boolean" } }, response: lastItemPages },
  {
    name: "create_payment_link",
    title: "Create payment link",
    description: "Create a shareable checkout link (buy.stripe.com) for existing prices; money moves only when a customer pays it",
    method: "POST",
    path: "/v1/payment_links",
    bodyMode: "form",
    write: "unsafe",
    toolPolicy: PAYMENT_LINK_POLICY,
    checkHint: "list_payment_links",
    params: {
      line_items: {
        in: "body",
        type: "array",
        required: true,
        maxItems: 20,
        items: { type: "object", properties: { price: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["price", "quantity"] },
        description: "Items: [{price: 'price_...', quantity: 1}] (up to 20; agents: only price and quantity, quantity at most 100)",
      },
      allow_promotion_codes: { in: "body", type: "boolean" },
      metadata: metadataParam,
    },
  },
];

// --- invoices --------------------------------------------------------------------------------------------

const invoiceOperations = [
  {
    name: "list_invoices",
    title: "List invoices",
    description: "List invoices, newest first",
    path: "/v1/invoices",
    params: {
      customer: { in: "query", type: "string" },
      status: { in: "query", type: "string", enum: ["draft", "open", "paid", "uncollectible", "void"] },
      subscription: { in: "query", type: "string" },
      ...createdFilters,
    },
    response: lastItemPages,
  },
  { name: "get_invoice", title: "Get invoice", description: "Retrieve an invoice", path: "/v1/invoices/{invoice_id}", params: { invoice_id: idParam("Invoice id (in_...)") } },
  {
    name: "create_invoice",
    title: "Create draft invoice",
    description: "Create a draft invoice for a customer (auto_advance off: nothing is finalized or sent until finalize_invoice / send_invoice)",
    method: "POST",
    path: "/v1/invoices",
    bodyMode: "form",
    write: "unsafe",
    toolPolicy: WRITE_POLICY,
    checkHint: "list_invoices for the customer with status=draft",
    params: {
      customer: { in: "body", type: "string", required: true, minLength: 1 },
      collection_method: { in: "body", type: "string", enum: ["charge_automatically", "send_invoice"], description: "send_invoice emails the customer when sent; needs days_until_due" },
      days_until_due: { in: "body", type: "integer", min: 0 },
      currency: { in: "body", type: "string" },
      description: { in: "body", type: "string" },
      metadata: metadataParam,
    },
    constants: { body: { auto_advance: false } },
  },
  {
    name: "add_invoice_item",
    title: "Add invoice item",
    description: "Add a line (a price, or an amount with a description) to a draft invoice. Node only: a draft can be a subscription renewal that Stripe finalizes and charges automatically",
    method: "POST",
    path: "/v1/invoiceitems",
    bodyMode: "form",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_invoice and look at its lines",
    params: {
      customer: { in: "body", type: "string", required: true, minLength: 1 },
      invoice: { in: "body", type: "string", required: true, minLength: 1, description: "Draft invoice id (in_...)" },
      price: { in: "body", type: "string", wireName: "pricing.price", description: "Price id (or give amount and currency)" },
      quantity: { in: "body", type: "integer", min: 1 },
      amount: { in: "body", type: "integer", description: "Amount in the smallest currency unit (instead of price)" },
      currency: { in: "body", type: "string" },
      description: { in: "body", type: "string" },
      metadata: metadataParam,
    },
  },
  {
    name: "finalize_invoice",
    title: "Finalize invoice",
    description: "Finalize a draft invoice so it can be paid (and, with charge_automatically, charged)",
    method: "POST",
    path: "/v1/invoices/{invoice_id}/finalize",
    bodyMode: "form",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_invoice and look at status",
    params: { invoice_id: idParam("Invoice id (in_...)"), auto_advance: { in: "body", type: "boolean", description: "Let Stripe collect payment automatically afterwards" } },
  },
  {
    name: "send_invoice",
    title: "Send invoice",
    description: "Email an open invoice to the customer",
    method: "POST",
    path: "/v1/invoices/{invoice_id}/send",
    bodyMode: "form",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_invoice and look at status_transitions",
    params: { invoice_id: idParam("Invoice id (in_...)") },
  },
  {
    name: "pay_invoice",
    title: "Pay invoice",
    description: "Attempt to collect an open invoice now (charges the customer's payment method)",
    method: "POST",
    path: "/v1/invoices/{invoice_id}/pay",
    bodyMode: "form",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_invoice and look at status",
    params: { invoice_id: idParam("Invoice id (in_...)"), paid_out_of_band: { in: "body", type: "boolean", description: "Mark as paid outside Stripe instead of charging" } },
  },
];

// --- products and prices ------------------------------------------------------------------------------------

const catalogOperations = [
  { name: "list_products", title: "List products", description: "List products", path: "/v1/products", params: { active: { in: "query", type: "boolean" } }, response: lastItemPages },
  { name: "get_product", title: "Get product", description: "Retrieve a product", path: "/v1/products/{product_id}", params: { product_id: idParam("Product id (prod_...)") } },
  {
    name: "create_product",
    title: "Create product",
    description: "Create a product",
    method: "POST",
    path: "/v1/products",
    bodyMode: "form",
    write: "unsafe",
    toolPolicy: WRITE_POLICY,
    checkHint: "list_products",
    params: {
      name: { in: "body", type: "string", required: true, minLength: 1 },
      description: { in: "body", type: "string" },
      active: { in: "body", type: "boolean" },
      metadata: metadataParam,
    },
  },
  {
    name: "list_prices",
    title: "List prices",
    description: "List prices, optionally of one product",
    path: "/v1/prices",
    params: { product: { in: "query", type: "string" }, active: { in: "query", type: "boolean" }, currency: { in: "query", type: "string" } },
    response: lastItemPages,
  },
  {
    name: "create_price",
    title: "Create price",
    description: "Create a one-time or recurring price for a product",
    method: "POST",
    path: "/v1/prices",
    bodyMode: "form",
    write: "unsafe",
    toolPolicy: WRITE_POLICY,
    checkHint: "list_prices for the product",
    params: {
      product: { in: "body", type: "string", required: true, minLength: 1 },
      unit_amount: { in: "body", type: "integer", required: true, min: 0, description: "Smallest currency unit" },
      currency: currencyParam,
      recurring_interval: { in: "body", type: "string", enum: ["day", "week", "month", "year"], wireName: "recurring.interval", description: "Omit for a one-time price" },
      nickname: { in: "body", type: "string" },
      metadata: metadataParam,
    },
  },
];

// --- charges, balance, refunds, subscriptions ---------------------------------------------------------------

const ledgerOperations = [
  {
    name: "list_charges",
    title: "List charges",
    description: "List charges, newest first",
    path: "/v1/charges",
    params: { customer: { in: "query", type: "string" }, payment_intent: { in: "query", type: "string" }, ...createdFilters },
    response: lastItemPages,
  },
  { name: "get_charge", title: "Get charge", description: "Retrieve a charge", path: "/v1/charges/{charge_id}", params: { charge_id: idParam("Charge id (ch_... or py_...)") } },
  { name: "get_balance", title: "Get balance", description: "Available and pending balance per currency", path: "/v1/balance" },
  {
    name: "list_balance_transactions",
    title: "List balance transactions",
    description: "List balance transactions (charges, refunds, fees, payouts...), newest first",
    path: "/v1/balance_transactions",
    params: {
      transaction_type: { in: "query", type: "string", wireName: "type", description: "e.g. charge, refund, payout, adjustment (sent as `type`)" },
      payout: { in: "query", type: "string", description: "Only transactions paid out in this payout (po_...)" },
      currency: { in: "query", type: "string" },
      ...createdFilters,
    },
    response: lastItemPages,
  },
  {
    name: "list_refunds",
    title: "List refunds",
    description: "List refunds, newest first",
    path: "/v1/refunds",
    params: { charge: { in: "query", type: "string" }, payment_intent: { in: "query", type: "string" } },
    response: lastItemPages,
  },
  {
    name: "create_refund",
    title: "Create refund",
    description: "Refund a charge or PaymentIntent, fully or partly: money goes back to the customer",
    method: "POST",
    path: "/v1/refunds",
    bodyMode: "form",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_refunds for the payment_intent",
    params: {
      payment_intent: { in: "body", type: "string", description: "PaymentIntent id (or charge)" },
      charge: { in: "body", type: "string", description: "Charge id (or payment_intent)" },
      amount: { in: "body", type: "integer", min: 1, description: "Partial refund in the smallest currency unit (default: everything left)" },
      reason: { in: "body", type: "string", enum: ["duplicate", "fraudulent", "requested_by_customer"] },
      metadata: metadataParam,
    },
  },
  {
    name: "list_subscriptions",
    title: "List subscriptions",
    description: "List subscriptions (default: not canceled)",
    path: "/v1/subscriptions",
    params: {
      customer: { in: "query", type: "string" },
      price: { in: "query", type: "string" },
      status: { in: "query", type: "string", enum: ["active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "trialing", "paused", "all", "ended"] },
    },
    response: lastItemPages,
  },
  { name: "get_subscription", title: "Get subscription", description: "Retrieve a subscription", path: "/v1/subscriptions/{subscription_id}", params: { subscription_id: idParam("Subscription id (sub_...)") } },
  {
    name: "cancel_subscription",
    title: "Cancel subscription",
    description: "Cancel a subscription immediately",
    method: "DELETE",
    path: "/v1/subscriptions/{subscription_id}",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_subscription and look at status",
    params: {
      subscription_id: idParam("Subscription id (sub_...)"),
      invoice_now: { in: "query", type: "boolean", description: "Invoice pending usage and proration now" },
      prorate: { in: "query", type: "boolean", description: "Credit the unused time" },
    },
  },
];

/** The declarative definition before the agent wrappers; tests use it for the generated contract suite. */
export const restDefinition = defineRestPlugin({
  name: "stripe",
  version: "0.1.0",
  description: "Stripe: customers, PaymentIntents, payment links, invoices, products, prices, charges, balance, refunds, subscriptions; money movement node only",
  apiName: "Stripe API",
  baseUrl: "https://api.stripe.com",
  // Secret or restricted key as the Basic user with an empty password (https://docs.stripe.com/api/authentication).
  auth: { type: "basic", tokenEnv: "STRIPE_SECRET_KEY", password: "" },
  defaultHeaders: { "stripe-version": STRIPE_API_VERSION },
  // Stripe deduplicates POSTs with the same key for 24 hours (https://docs.stripe.com/api/idempotent_requests).
  idempotencyKeyHeader: "Idempotency-Key",
  toolOutput: false,
  extraEnv: ["STRIPE_TOOL_MAX_AMOUNT", "STRIPE_TOOL_ALLOWED_CURRENCIES", "STRIPE_TOOL_API_EXTRA_PATHS"],
  // Errors are {"error": {"type": "invalid_request_error", "code": "resource_missing", "message": "..."}}.
  errors: {
    messagePath: "error.message",
    codePath: "error.code",
    kindByCode: {
      resource_missing: "not_found",
      api_key_expired: "auth_error",
      rate_limit: "rate_limited",
      parameter_missing: "invalid_input",
      parameter_invalid_integer: "invalid_input",
      parameter_unknown: "invalid_input",
      amount_too_small: "invalid_input",
      amount_too_large: "invalid_input",
      secret_key_required: "permission_denied",
    },
    retryableCodes: ["lock_timeout"],
  },
  apiRequest: { examplePath: "/v1/balance" },
  operations: [...customerOperations, ...paymentIntentOperations, ...paymentLinkOperations, ...invoiceOperations, ...catalogOperations, ...ledgerOperations],
});

const cappedDefinition = capToolAmounts(restDefinition, {
  operationNames: ["create_payment_intent"],
  maxAmountEnv: "STRIPE_TOOL_MAX_AMOUNT",
  currencyEnv: "STRIPE_TOOL_ALLOWED_CURRENCIES",
  readCharges: (args) => [{ amount: args.amount, currency: args.currency }],
  unitLabel: "smallest currency unit, e.g. cents",
});
// An agent-created price becomes the amount of any payment link that uses it, so it gets the same cap.
const priceCappedDefinition = capToolAmounts(cappedDefinition, {
  operationNames: ["create_price"],
  maxAmountEnv: "STRIPE_TOOL_MAX_AMOUNT",
  currencyEnv: "STRIPE_TOOL_ALLOWED_CURRENCIES",
  readCharges: (args) => [{ amount: args.unit_amount, currency: args.currency }],
  unitLabel: "smallest currency unit, e.g. cents",
});
const lineItemDefinition = limitToolLineItems(priceCappedDefinition, "STRIPE_TOOL_ALLOW_PAYMENT_LINKS");
// Outermost of the argument wrappers: the caps compare the trimmed, lowercased currency.
const currencyDefinition = normalizeCurrencyArguments(lineItemDefinition);
const guardedDefinition = guardToolApiRequest(currencyDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "STRIPE_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read customers, charges, balance, invoices, catalog, subscriptions, refunds, disputes, payouts and payment links; use a workflow node",
});

export const pluginDefinition = stripSecretFieldsForTools(guardedDefinition, ["client_secret"]);
