/**
 * paypal plugin definition: Orders v2 (create, get, capture, authorize), captures, authorizations and refunds,
 * Invoicing v2 (list, get, create draft, send), Payouts and reporting (balances, transactions) through the PayPal
 * REST API (https://developer.paypal.com/api/rest/). Built with the declarative REST layer
 * (docs/declarative-plugins.md) plus wrappers:
 *   - lib/tool-amount-cap.mjs: agent-created orders need PAYPAL_TOOL_MAX_AMOUNT and listed currencies;
 *   - lib/tool-path-policy.mjs: api_request for tools only reaches an allowlist of read paths.
 *
 * Hosts: PAYPAL_ENV=sandbox (default) uses api-m.sandbox.paypal.com, live uses api-m.paypal.com. The OAuth2
 * client-credentials token URL differs per host and the layer takes a fixed token URL, so the plugin builds one
 * declarative definition per host and picks the client by PAYPAL_ENV (selectPayPalDefinition).
 *
 * Agent policy: reads are tools; orders need PAYPAL_TOOL_ALLOW_ORDERS=1 plus the cap (an order only moves money
 * once the buyer approves it and a node captures it); draft invoices need PAYPAL_TOOL_ALLOW_INVOICES=1. Capturing,
 * authorizing, voiding, refunds, sending invoices and payouts are node only. Writes send PayPal-Request-Id.
 */
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardPayPalShapes, MONEY_VALUE_PATTERN } from "./lib/order-shape-policy.mjs";
import { capToolAmounts } from "./lib/tool-amount-cap.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";

const ORDER_POLICY = "optIn:PAYPAL_TOOL_ALLOW_ORDERS";
const INVOICE_POLICY = "optIn:PAYPAL_TOOL_ALLOW_INVOICES";
export const PAYPAL_HOSTS = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" };
const ID = "[^/]+";
// GET paths agent tools may reach through api_request (normalized). Vault (saved payment methods), webhooks,
// identity/userinfo, payouts and disputes evidence are not listed.
const TOOL_API_PATHS = [
  `/v2/checkout/orders/${ID}`,
  `/v2/payments/(captures|authorizations|refunds)/${ID}`,
  `/v2/invoicing/invoices(/${ID})?`,
  "/v1/reporting/balances",
  "/v1/reporting/transactions",
  `/v1/catalogs/products(/${ID})?`,
  `/v1/billing/(plans|subscriptions)(/${ID})?`,
].map((pattern) => new RegExp(`^${pattern}$`));

const idParam = (description) => ({ in: "path", type: "string", required: true, minLength: 1, description });
const moneyParams = (prefix, required) => ({
  [`${prefix}value`]: { in: "body", type: "string", required, minLength: 1, wireName: "amount.value", description: "Decimal string, e.g. \"10.50\"" },
  [`${prefix}currency_code`]: { in: "body", type: "string", required, minLength: 3, wireName: "amount.currency_code", description: "ISO code, e.g. USD" },
});
const nodeWrite = (operation) => ({ method: "POST", write: "unsafe", nodeOnly: true, ...operation });

const orderOperations = [
  {
    name: "create_order",
    title: "Create order",
    description:
      "Create a checkout order; send the buyer its approve (payer-action) link. No money moves until the buyer approves and a node captures it. Agent tools also need PAYPAL_TOOL_MAX_AMOUNT and the currencies in PAYPAL_TOOL_ALLOWED_CURRENCIES",
    method: "POST",
    path: "/v2/checkout/orders",
    write: "unsafe",
    toolPolicy: ORDER_POLICY,
    checkHint: "get_order with the id from the response; with PayPal-Request-Id a retry returns the same order",
    params: {
      intent: { in: "body", type: "string", enum: ["CAPTURE", "AUTHORIZE"], default: "CAPTURE" },
      purchase_units: {
        in: "body",
        type: "array",
        required: true,
        maxItems: 10,
        items: { type: "object" },
        description: "[{reference_id?, description?, custom_id?, invoice_id?, amount: {currency_code: \"USD\", value: \"10.00\", breakdown?}, items?}]",
      },
      return_url: { in: "body", type: "string", wireName: "payment_source.paypal.experience_context.return_url", description: "Where the buyer returns after approving" },
      cancel_url: { in: "body", type: "string", wireName: "payment_source.paypal.experience_context.cancel_url" },
      brand_name: { in: "body", type: "string", wireName: "payment_source.paypal.experience_context.brand_name" },
    },
    constants: { headers: { prefer: "return=representation" } },
  },
  { name: "get_order", title: "Get order", description: "Retrieve an order (status CREATED, APPROVED, COMPLETED...)", path: "/v2/checkout/orders/{order_id}", params: { order_id: idParam("Order id") } },
  nodeWrite({ name: "capture_order", title: "Capture order", description: "Capture an approved order: this charges the buyer", path: "/v2/checkout/orders/{order_id}/capture", checkHint: "get_order and look at status", params: { order_id: idParam("Order id") }, constants: { headers: { prefer: "return=representation" } } }),
  nodeWrite({ name: "authorize_order", title: "Authorize order", description: "Authorize an approved AUTHORIZE-intent order (places a hold)", path: "/v2/checkout/orders/{order_id}/authorize", checkHint: "get_order and look at status", params: { order_id: idParam("Order id") }, constants: { headers: { prefer: "return=representation" } } }),
];

const paymentOperations = [
  { name: "get_capture", title: "Get capture", description: "Retrieve a captured payment", path: "/v2/payments/captures/{capture_id}", params: { capture_id: idParam("Capture id") } },
  nodeWrite({
    name: "refund_capture",
    title: "Refund capture",
    description: "Refund a captured payment fully (no amount) or partly: money goes back to the buyer",
    path: "/v2/payments/captures/{capture_id}/refund",
    checkHint: "get_capture and look at its refunds; with PayPal-Request-Id a retry returns the same refund",
    params: {
      capture_id: idParam("Capture id"),
      ...moneyParams("amount_", false),
      note_to_payer: { in: "body", type: "string" },
      invoice_id: { in: "body", type: "string" },
    },
  }),
  { name: "get_refund", title: "Get refund", description: "Retrieve a refund", path: "/v2/payments/refunds/{refund_id}", params: { refund_id: idParam("Refund id") } },
  { name: "get_authorization", title: "Get authorization", description: "Retrieve an authorized payment", path: "/v2/payments/authorizations/{authorization_id}", params: { authorization_id: idParam("Authorization id") } },
  nodeWrite({
    name: "capture_authorization",
    title: "Capture authorization",
    description: "Capture an authorized payment fully or partly: this charges the buyer",
    path: "/v2/payments/authorizations/{authorization_id}/capture",
    checkHint: "get_authorization and look at status",
    params: { authorization_id: idParam("Authorization id"), ...moneyParams("amount_", false), final_capture: { in: "body", type: "boolean" } },
  }),
  nodeWrite({ name: "void_authorization", title: "Void authorization", description: "Void an authorized payment (releases the hold)", path: "/v2/payments/authorizations/{authorization_id}/void", checkHint: "get_authorization and look at status", params: { authorization_id: idParam("Authorization id") } }),
];

const invoiceOperations = [
  {
    name: "list_invoices",
    title: "List invoices",
    description: "List invoices, newest first",
    path: "/v2/invoicing/invoices",
    params: {},
    constants: { query: { total_required: "true" } },
    response: { dataPath: "items", pagePagination: { pageParam: "page", sizeParam: "page_size", totalPagesPath: "total_pages" }, maxLimit: 100 },
  },
  { name: "get_invoice", title: "Get invoice", description: "Retrieve an invoice", path: "/v2/invoicing/invoices/{invoice_id}", params: { invoice_id: idParam("Invoice id (INV2-...)") } },
  {
    name: "create_invoice",
    title: "Create draft invoice",
    description: "Create a draft invoice (nothing is emailed until send_invoice)",
    method: "POST",
    path: "/v2/invoicing/invoices",
    write: "unsafe",
    toolPolicy: INVOICE_POLICY,
    idempotencyKeyHeader: false,
    checkHint: "list_invoices and look for the invoice_number",
    params: {
      currency_code: { in: "body", type: "string", required: true, minLength: 3, wireName: "detail.currency_code" },
      invoice_number: { in: "body", type: "string", wireName: "detail.invoice_number", description: "Unique number (PayPal refuses duplicates); default the next one" },
      note: { in: "body", type: "string", wireName: "detail.note" },
      term: { in: "body", type: "string", wireName: "detail.term" },
      payment_term_type: { in: "body", type: "string", enum: ["DUE_ON_RECEIPT", "DUE_ON_DATE_SPECIFIED", "NET_10", "NET_15", "NET_30", "NET_45", "NET_60", "NET_90", "NO_DUE_DATE"], wireName: "detail.payment_term.term_type" },
      primary_recipients: { in: "body", type: "array", items: { type: "object" }, description: "[{billing_info: {email_address, name: {given_name, surname}}}]" },
      items: { in: "body", type: "array", items: { type: "object" }, description: "[{name, quantity: \"1\", unit_amount: {currency_code, value}}]" },
    },
  },
  nodeWrite({
    name: "send_invoice",
    title: "Send invoice",
    description: "Send a draft invoice: PayPal emails it to the recipients",
    path: "/v2/invoicing/invoices/{invoice_id}/send",
    checkHint: "get_invoice and look at status",
    params: { invoice_id: idParam("Invoice id"), send_to_recipient: { in: "body", type: "boolean", default: true }, subject: { in: "body", type: "string" }, note: { in: "body", type: "string" } },
  }),
];

const accountOperations = [
  { name: "get_balances", title: "Get balances", description: "Account balances per currency", path: "/v1/reporting/balances", params: { currency_code: { in: "query", type: "string" }, as_of_time: { in: "query", type: "string", description: "ISO 8601" } } },
  {
    name: "list_transactions",
    title: "List transactions",
    description: "Transactions between two dates (at most 31 days apart; data lags up to 3 hours)",
    path: "/v1/reporting/transactions",
    params: {
      start_date: { in: "query", type: "string", required: true, description: "ISO 8601, e.g. 2026-11-01T00:00:00-0000" },
      end_date: { in: "query", type: "string", required: true, description: "ISO 8601" },
      transaction_id: { in: "query", type: "string" },
      transaction_status: { in: "query", type: "string", enum: ["D", "P", "S", "V"], description: "D denied, P pending, S success, V reversed" },
      fields: { in: "query", type: "string", default: "transaction_info,payer_info", description: "Comma-separated, or all" },
    },
    response: { dataPath: "transaction_details", pagePagination: { pageParam: "page", sizeParam: "page_size", totalPagesPath: "total_pages" }, maxLimit: 500 },
  },
  nodeWrite({
    name: "create_payout",
    title: "Create payout",
    description: "Send money to up to 15000 recipients by email, phone or PayPal id",
    path: "/v1/payments/payouts",
    // sender_batch_id is PayPal's own dedupe key (refused when reused within 30 days).
    checkHint: "get_payout_batch, or the dashboard by sender_batch_id",
    params: {
      sender_batch_id: { in: "body", type: "string", required: true, minLength: 1, wireName: "sender_batch_header.sender_batch_id" },
      email_subject: { in: "body", type: "string", wireName: "sender_batch_header.email_subject" },
      payout_items: { in: "body", type: "array", required: true, items: { type: "object" }, wireName: "items", description: "[{recipient_type: EMAIL, amount: {value, currency}, receiver, note?, sender_item_id?}]" },
    },
  }),
  { name: "get_payout_batch", title: "Get payout batch", description: "Retrieve a payout batch and its items", path: "/v1/payments/payouts/{payout_batch_id}", nodeOnly: true, params: { payout_batch_id: idParam("Payout batch id") } },
];

const OPERATIONS = [...orderOperations, ...paymentOperations, ...invoiceOperations, ...accountOperations];

function buildRestDefinition(baseUrl) {
  return defineRestPlugin({
    name: "paypal",
    version: "0.1.0",
    description: "PayPal: orders, captures, refunds, draft invoices, balances and transactions; capture, refunds, invoice sending and payouts node only",
    apiName: "PayPal REST API",
    baseUrl,
    auth: { type: "oauth2", grant: "client_credentials", tokenUrl: `${baseUrl}/v1/oauth2/token`, clientIdEnv: "PAYPAL_CLIENT_ID", clientSecretEnv: "PAYPAL_CLIENT_SECRET", clientAuth: "basic" },
    // PayPal deduplicates POSTs with the same PayPal-Request-Id (Orders, Payments: 6 hours / 72 hours).
    idempotencyKeyHeader: "PayPal-Request-Id",
    extraEnv: ["PAYPAL_ENV", "PAYPAL_TOOL_MAX_AMOUNT", "PAYPAL_TOOL_ALLOWED_CURRENCIES", "PAYPAL_TOOL_API_EXTRA_PATHS", "PAYPAL_TOOL_ALLOWED_RETURN_HOSTS"],
    // Errors are {"name": "RESOURCE_NOT_FOUND", "message": "...", "details": [{"issue", "description"}], "debug_id"}.
    errors: {
      messagePath: ["details.0.description", "message", "error_description"],
      codePath: "name",
      kindByCode: {
        RESOURCE_NOT_FOUND: "not_found",
        INVALID_RESOURCE_ID: "not_found",
        INVALID_REQUEST: "invalid_input",
        UNPROCESSABLE_ENTITY: "invalid_input",
        AUTHENTICATION_FAILURE: "auth_error",
        NOT_AUTHORIZED: "permission_denied",
        PERMISSION_DENIED: "permission_denied",
        RATE_LIMIT_REACHED: "rate_limited",
      },
    },
    apiRequest: { examplePath: "/v1/reporting/balances" },
    operations: OPERATIONS,
  });
}

/**
 * Picks the definition for PAYPAL_ENV.
 *
 * @param definitions - `{sandbox, live}` definitions (object)
 * @param environment - Environment variables (object)
 * @returns The definition for the configured host (object)
 * @throws PluginError kind `invalid_input` - PAYPAL_ENV is neither sandbox nor live
 */
export function selectPayPalDefinition(definitions, environment) {
  const mode = String(environment?.PAYPAL_ENV ?? "sandbox").trim().toLowerCase() || "sandbox";
  if (!definitions[mode]) throw new PluginError("PAYPAL_ENV must be sandbox or live", { kind: "invalid_input" });
  return definitions[mode];
}

const definitionsByMode = { sandbox: buildRestDefinition(PAYPAL_HOSTS.sandbox), live: buildRestDefinition(PAYPAL_HOSTS.live) };
/**
 * The amounts of a draft invoice: unit_amount.value times quantity per item.
 *
 * @param args - create_invoice arguments (object)
 * @returns `[{amount, currency}]`; non-numeric values become NaN and are refused by the cap (object[])
 */
export function readInvoiceCharges(args) {
  if (!Array.isArray(args.items)) return [];
  return args.items.map((item) => ({
    amount: MONEY_VALUE_PATTERN.test(String(item?.unit_amount?.value ?? "")) ? Number(item.unit_amount.value) * Number(item?.quantity ?? 1) : Number.NaN,
    currency: item?.unit_amount?.currency_code,
  }));
}

const hostSwitchingDefinition = {
  ...definitionsByMode.sandbox,
  createClient: (clientOptions) => selectPayPalDefinition(definitionsByMode, clientOptions.environment).createClient(clientOptions),
};

const cappedDefinition = capToolAmounts(hostSwitchingDefinition, {
  operationNames: ["create_order"],
  maxAmountEnv: "PAYPAL_TOOL_MAX_AMOUNT",
  currencyEnv: "PAYPAL_TOOL_ALLOWED_CURRENCIES",
  readCharges: (args) => (Array.isArray(args.purchase_units) ? args.purchase_units.map((unit) => ({ amount: unit?.amount?.value, currency: unit?.amount?.currency_code })) : []),
  unitLabel: "major currency unit, e.g. dollars",
});
// Draft invoices do not move money, but a sent invoice asks for the drafted total: agents stay within the same cap.
const invoiceCappedDefinition = capToolAmounts(cappedDefinition, {
  operationNames: ["create_invoice"],
  maxAmountEnv: "PAYPAL_TOOL_MAX_AMOUNT",
  currencyEnv: "PAYPAL_TOOL_ALLOWED_CURRENCIES",
  readCharges: readInvoiceCharges,
  unitLabel: "major currency unit, e.g. dollars",
});
// Outermost of the argument checks: currencies are normalized before the caps read them.
const shapedDefinition = guardPayPalShapes(invoiceCappedDefinition);

export const pluginDefinition = guardToolApiRequest(shapedDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "PAYPAL_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read orders, payments, invoices, balances, transactions, catalog products and billing plans; use a workflow node",
});
