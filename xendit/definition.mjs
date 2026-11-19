/**
 * xendit plugin definition: invoices (hosted payment pages), payment requests (Payments API v3), balance,
 * transactions, refunds and payouts (v3) through the Xendit API (https://docs.xendit.co). Built with the
 * declarative REST layer (docs/declarative-plugins.md) plus wrappers:
 *   - lib/tool-amount-cap.mjs: agent-created invoices need XENDIT_TOOL_MAX_AMOUNT and a listed currency;
 *   - lib/tool-path-policy.mjs: api_request for tools only reaches an allowlist of read paths.
 *
 * Auth: the secret API key as the Basic user with an empty password. Test-mode keys (xnd_development_...) and live
 * keys (xnd_production_...) use the same host, api.xendit.co.
 *
 * Agent policy: reads are tools; invoices need XENDIT_TOOL_ALLOW_INVOICES=1 plus the cap. Expiring invoices,
 * payment requests (they can charge saved payment tokens), refunds and payouts are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { normalizeArguments } from "./lib/argument-normalization.mjs";
import { capToolAmounts } from "./lib/tool-amount-cap.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";

const INVOICE_POLICY = "optIn:XENDIT_TOOL_ALLOW_INVOICES";
const PAYMENTS_API_VERSION = "2024-11-11";
const PAYOUTS_API_VERSION = "2025-09-01";
const ID = "[^/]+";
// GET paths agent tools may reach through api_request (normalized). Payment tokens, customers' payment methods,
// payouts and anything with account or key details are not listed.
const TOOL_API_PATHS = [`/v2/invoices(/${ID})?`, "/balance", `/transactions(/${ID})?`, `/v3/payment_requests/${ID}`, `/refunds(/${ID})?`].map((pattern) => new RegExp(`^${pattern}$`));

const idParam = (description) => ({ in: "path", type: "string", required: true, minLength: 1, description });
const isoTime = (description) => ({ in: "query", type: "string", description: `${description} (ISO 8601, e.g. 2026-01-01T00:00:00Z)` });

const invoiceOperations = [
  {
    name: "create_invoice",
    title: "Create invoice",
    description:
      "Create a hosted payment page (invoice_url) for an amount; send invoice_url to the payer. No money moves until the payer pays. Agent tools also need XENDIT_TOOL_MAX_AMOUNT and the currency in XENDIT_TOOL_ALLOWED_CURRENCIES",
    method: "POST",
    path: "/v2/invoices",
    write: "unsafe",
    toolPolicy: INVOICE_POLICY,
    checkHint: "list_invoices with external_id",
    params: {
      external_id: { in: "body", type: "string", required: true, minLength: 1, description: "Your id for the invoice (Xendit does not enforce uniqueness)" },
      amount: { in: "body", type: "number", required: true, min: 1, description: "Amount in the currency's major unit (IDR 150000 = Rp150.000)" },
      currency: { in: "body", type: "string", default: "IDR", description: "IDR, PHP, THB, VND, MYR, SGD or USD (enabled for your account)" },
      description: { in: "body", type: "string" },
      payer_email: { in: "body", type: "string", description: "Shown on the invoice (Xendit sends no email unless notifications are set in the dashboard)" },
      invoice_duration: { in: "body", type: "integer", min: 1, description: "Seconds until the invoice expires (default 24 hours)" },
      items: { in: "body", type: "array", items: { type: "object" }, description: "[{name, quantity, price, category?, url?}]" },
      customer: { in: "body", type: "object", description: "{given_names, surname, email, mobile_number}" },
      payment_methods: { in: "body", type: "array", items: { type: "string" }, description: "Limit channels, e.g. [\"QRIS\", \"BCA\", \"OVO\"]" },
      success_redirect_url: { in: "body", type: "string", description: "Where the payer's browser goes after paying" },
      failure_redirect_url: { in: "body", type: "string" },
    },
  },
  { name: "get_invoice", title: "Get invoice", description: "Retrieve an invoice (status PENDING, PAID, SETTLED or EXPIRED)", path: "/v2/invoices/{invoice_id}", params: { invoice_id: idParam("Invoice id") } },
  {
    name: "list_invoices",
    title: "List invoices",
    description: "List invoices, newest first",
    path: "/v2/invoices",
    params: {
      external_id: { in: "query", type: "string" },
      statuses: { in: "query", type: "array", items: { type: "string", enum: ["PENDING", "PAID", "SETTLED", "EXPIRED"] }, style: "repeat" },
      created_after: isoTime("Created after"),
      created_before: isoTime("Created before"),
      paid_after: isoTime("Paid after"),
      paid_before: isoTime("Paid before"),
    },
    response: { lastItemCursor: { itemIdPath: "id", param: "last_invoice" }, limitParam: "limit", maxLimit: 100 },
  },
  {
    name: "expire_invoice",
    title: "Expire invoice",
    description: "Expire a pending invoice so it can no longer be paid",
    method: "POST",
    path: "/invoices/{invoice_id}/expire!",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_invoice and look at status",
    params: { invoice_id: idParam("Invoice id") },
  },
];

const paymentRequestOperations = [
  {
    name: "create_payment_request",
    title: "Create payment request",
    description: "Start collecting a payment through one channel (Payments API v3); with a payment_token_id it can charge a saved method at once",
    method: "POST",
    path: "/v3/payment_requests",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_payment_request is by id only: search the dashboard for the reference_id",
    params: {
      reference_id: { in: "body", type: "string", required: true, minLength: 1 },
      request_type: { in: "body", type: "string", enum: ["PAY", "PAY_AND_SAVE", "REUSABLE_PAYMENT_CODE"], default: "PAY", wireName: "type", description: "Sent as `type`" },
      currency: { in: "body", type: "string", required: true },
      request_amount: { in: "body", type: "number", min: 0 },
      country: { in: "body", type: "string", description: "ID, PH, TH, VN, MY, SG" },
      channel_code: { in: "body", type: "string", description: "e.g. QRIS, BRI_VIRTUAL_ACCOUNT, DANA (or payment_token_id)" },
      channel_properties: { in: "body", type: "object" },
      payment_token_id: { in: "body", type: "string", description: "A saved payment token (charges it)" },
      capture_method: { in: "body", type: "string", enum: ["AUTOMATIC", "MANUAL"] },
      customer_id: { in: "body", type: "string" },
      description: { in: "body", type: "string" },
      metadata: { in: "body", type: "object" },
    },
    constants: { headers: { "api-version": PAYMENTS_API_VERSION } },
  },
  {
    name: "get_payment_request",
    title: "Get payment request",
    description: "Retrieve a payment request (status, actions, latest_payment)",
    path: "/v3/payment_requests/{payment_request_id}",
    params: { payment_request_id: idParam("Payment request id (pr-...)") },
    constants: { headers: { "api-version": PAYMENTS_API_VERSION } },
  },
];

const ledgerOperations = [
  {
    name: "get_balance",
    title: "Get balance",
    description: "Account balance (CASH by default)",
    path: "/balance",
    params: {
      account_type: { in: "query", type: "string", enum: ["CASH", "HOLDING"] },
      currency: { in: "query", type: "string", description: "For multi-currency accounts" },
      at_timestamp: { in: "query", type: "string", description: "Balance at this time (ISO 8601)" },
    },
  },
  {
    name: "list_transactions",
    title: "List transactions",
    description: "List money movements (payments, refunds, payouts, fees), newest first",
    path: "/transactions",
    params: {
      types: { in: "query", type: "array", items: { type: "string" }, style: "repeat", description: "e.g. PAYMENT, REFUND, DISBURSEMENT" },
      statuses: { in: "query", type: "array", items: { type: "string", enum: ["PENDING", "SUCCESS", "FAILED", "VOIDED", "REVERSED"] }, style: "repeat" },
      channel_categories: { in: "query", type: "array", items: { type: "string" }, style: "repeat" },
      reference_id: { in: "query", type: "string" },
      currency: { in: "query", type: "string" },
      created_gte: { in: "query", type: "string", wireName: "created[gte]", description: "ISO 8601" },
      created_lte: { in: "query", type: "string", wireName: "created[lte]", description: "ISO 8601" },
    },
    response: { dataPath: "data", lastItemCursor: { itemIdPath: "id", param: "after_id", hasMorePath: "has_more" }, limitParam: "limit", maxLimit: 50 },
  },
  {
    name: "create_refund",
    title: "Create refund",
    description: "Refund a payment request or invoice payment, fully or partly: money goes back to the payer",
    method: "POST",
    path: "/refunds",
    write: "unsafe",
    nodeOnly: true,
    idempotencyKeyHeader: "idempotency-key",
    checkHint: "list_transactions with types=REFUND and the reference_id",
    params: {
      payment_request_id: { in: "body", type: "string", description: "Payment request id (or invoice_id)" },
      invoice_id: { in: "body", type: "string" },
      reference_id: { in: "body", type: "string" },
      amount: { in: "body", type: "number", min: 0, description: "Default the full amount" },
      currency: { in: "body", type: "string" },
      reason: { in: "body", type: "string", required: true, enum: ["FRAUDULENT", "DUPLICATE", "REQUESTED_BY_CUSTOMER", "CANCELLATION", "OTHERS"] },
      metadata: { in: "body", type: "object" },
    },
  },
  { name: "get_refund", title: "Get refund", description: "Retrieve a refund", path: "/refunds/{refund_id}", params: { refund_id: idParam("Refund id (rfd-...)") } },
  {
    name: "create_payout",
    title: "Create payout",
    description: "Send money from your balance to a bank account or e-wallet (Payouts v3)",
    method: "POST",
    path: "/v3/payouts",
    write: "unsafe",
    nodeOnly: true,
    idempotencyKeyHeader: "idempotency-key",
    checkHint: "get_payout, or the dashboard by reference_id",
    params: {
      reference_id: { in: "body", type: "string", required: true, minLength: 1 },
      recipient: { in: "body", type: "object", required: true, description: "{type, relationship, account_details, address, ...} per the Payouts v3 docs" },
      payout_details: { in: "body", type: "object", required: true, description: "{source_currency, source_amount, destination_currency, ...} or {quote_id}" },
      source_of_fund: { in: "body", type: "string", required: true },
      purpose_code: { in: "body", type: "string", required: true },
      description: { in: "body", type: "string" },
      metadata: { in: "body", type: "object" },
    },
    constants: { headers: { "api-version": PAYOUTS_API_VERSION } },
  },
  {
    name: "get_payout",
    title: "Get payout",
    description: "Retrieve a payout (Payouts v3)",
    path: "/v3/payouts/{payout_id}",
    nodeOnly: true,
    params: { payout_id: idParam("Payout id") },
    constants: { headers: { "api-version": PAYOUTS_API_VERSION } },
  },
];

/** The declarative definition before the wrappers. */
export const restDefinition = defineRestPlugin({
  name: "xendit",
  version: "0.1.0",
  description: "Xendit: invoices (hosted payment pages), payment requests, balance, transactions; refunds, payouts and expiry node only",
  apiName: "Xendit API",
  baseUrl: "https://api.xendit.co",
  auth: { type: "basic", tokenEnv: "XENDIT_SECRET_KEY", password: "" },
  extraEnv: ["XENDIT_TOOL_MAX_AMOUNT", "XENDIT_TOOL_ALLOWED_CURRENCIES", "XENDIT_TOOL_API_EXTRA_PATHS"],
  // Errors are {"error_code": "INVALID_API_KEY", "message": "..."}.
  errors: {
    messagePath: "message",
    codePath: "error_code",
    kindByCode: {
      INVALID_API_KEY: "auth_error",
      REQUEST_FORBIDDEN_ERROR: "permission_denied",
      FEATURE_NOT_AVAILABLE: "permission_denied",
      INVOICE_NOT_FOUND_ERROR: "not_found",
      DATA_NOT_FOUND: "not_found",
      NOT_FOUND: "not_found",
      API_VALIDATION_ERROR: "invalid_input",
      INVALID_VALUE_ERROR: "invalid_input",
      DUPLICATE_ERROR: "invalid_input",
      RATE_LIMIT_EXCEEDED: "rate_limited",
    },
  },
  apiRequest: { examplePath: "/balance" },
  operations: [...invoiceOperations, ...paymentRequestOperations, ...ledgerOperations],
});

const cappedDefinition = capToolAmounts(restDefinition, {
  operationNames: ["create_invoice"],
  maxAmountEnv: "XENDIT_TOOL_MAX_AMOUNT",
  currencyEnv: "XENDIT_TOOL_ALLOWED_CURRENCIES",
  readCharges: (args) => [{ amount: args.amount, currency: args.currency ?? "IDR" }],
  unitLabel: "major currency unit, e.g. IDR",
});

// Outermost of the argument wrappers: the cap compares the uppercased currency.
const normalizedDefinition = normalizeArguments(cappedDefinition);

export const pluginDefinition = guardToolApiRequest(normalizedDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "XENDIT_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read invoices, balance, transactions, payment requests and refunds; use a workflow node",
});
