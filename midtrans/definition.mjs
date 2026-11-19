/**
 * midtrans plugin definition: Snap payment pages (token + redirect URL) and Core API transaction status, cancel,
 * expire, refund, approve/deny and capture (https://docs.midtrans.com). Built with the declarative REST layer
 * (docs/declarative-plugins.md) plus wrappers:
 *   - lib/tool-amount-cap.mjs: agent-created Snap transactions need MIDTRANS_TOOL_MAX_AMOUNT (IDR);
 *   - lib/body-status-errors.mjs: Core API errors that arrive as HTTP 200 with a body `status_code`;
 *   - lib/tool-path-policy.mjs: api_request for tools only reaches status reads.
 *
 * Hosts: MIDTRANS_ENV=sandbox (default) uses app.sandbox.midtrans.com (Snap) and api.sandbox.midtrans.com (Core);
 * production uses app.midtrans.com and api.midtrans.com. The server key is the Basic auth user, empty password.
 *
 * Agent policy: status reads are tools; Snap transactions need MIDTRANS_TOOL_ALLOW_PAYMENTS=1 plus the cap; every
 * Core API write (cancel, expire, refund, approve, deny, capture) is node only. Notification URL overrides
 * (X-Override-Notification) are never sent: payment notifications go only to the URL set in the dashboard.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { checkBodyStatusCodes } from "./lib/body-status-errors.mjs";
import { addKeyModeHint } from "./lib/key-mode-hint.mjs";
import { capToolAmounts } from "./lib/tool-amount-cap.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";

const PAYMENT_POLICY = "optIn:MIDTRANS_TOOL_ALLOW_PAYMENTS";
const HOSTS = {
  sandbox: { core: "https://api.sandbox.midtrans.com", snap: "https://app.sandbox.midtrans.com" },
  production: { core: "https://api.midtrans.com", snap: "https://app.midtrans.com" },
};
const ID = "[^/]+";
const TOOL_API_PATHS = [`/v2/${ID}/status(/b2b)?`, `/v1/subscriptions/${ID}`].map((pattern) => new RegExp(`^${pattern}$`));

/**
 * Picks the hosts from MIDTRANS_ENV.
 *
 * @param environment - Environment variables (object)
 * @returns `{core, snap}` base URLs (object)
 * @throws Error - MIDTRANS_ENV is neither sandbox nor production
 */
export function selectMidtransHosts(environment) {
  const mode = String(environment.MIDTRANS_ENV ?? "sandbox").trim().toLowerCase() || "sandbox";
  if (!HOSTS[mode]) throw new Error("MIDTRANS_ENV must be sandbox or production");
  return HOSTS[mode];
}

const orderParam = { in: "path", type: "string", required: true, minLength: 1, description: "Order id (or Midtrans transaction id)" };
const coreWrite = (operation) => ({ method: "POST", write: "unsafe", nodeOnly: true, checkHint: "get_transaction_status for the order", ...operation });

const snapOperations = [
  {
    name: "create_snap_transaction",
    title: "Create Snap transaction",
    description:
      "Create a Snap payment page for an order: returns token and redirect_url (send redirect_url to the payer). No money moves until the payer pays. Agent tools also need MIDTRANS_TOOL_MAX_AMOUNT",
    method: "POST",
    baseUrl: (environment) => selectMidtransHosts(environment).snap,
    path: "/snap/v1/transactions",
    write: "unsafe",
    toolPolicy: PAYMENT_POLICY,
    // Midtrans refuses a second transaction with the same order_id, so a lost response is checked, not retried.
    idempotencyKeyHeader: false,
    checkHint: "get_transaction_status for the order_id (404 means no payment yet; the Snap token cannot be fetched again: create a new order_id)",
    params: {
      order_id: { in: "body", type: "string", required: true, minLength: 1, wireName: "transaction_details.order_id", description: "Your unique order id (letters, digits, - _ ~ .; max 50)" },
      gross_amount: { in: "body", type: "integer", required: true, min: 1, wireName: "transaction_details.gross_amount", description: "Total in IDR (must equal the sum of item_details)" },
      item_details: {
        in: "body",
        type: "array",
        items: { type: "object" },
        description: "Items: [{id, name, price, quantity, brand?, category?}] (price in IDR)",
      },
      customer_details: { in: "body", type: "object", description: "{first_name, last_name, email, phone, billing_address, shipping_address}" },
      enabled_payments: { in: "body", type: "array", items: { type: "string" }, description: "Limit methods, e.g. [\"gopay\", \"bca_va\", \"qris\"]" },
      expiry_duration: { in: "body", type: "integer", min: 1, wireName: "expiry.duration", description: "Payment page lifetime (with expiry_unit)" },
      expiry_unit: { in: "body", type: "string", enum: ["second", "minute", "hour", "day"], wireName: "expiry.unit" },
      custom_field1: { in: "body", type: "string" },
      custom_field2: { in: "body", type: "string" },
      custom_field3: { in: "body", type: "string" },
    },
  },
];

const coreOperations = [
  {
    name: "get_transaction_status",
    title: "Get transaction status",
    description: "Status of a transaction by order id: transaction_status (pending, settlement, capture, deny, cancel, expire, refund...), payment_type, gross_amount",
    path: "/v2/{order_id}/status",
    params: { order_id: orderParam },
  },
  {
    name: "get_b2b_transaction_status",
    title: "Get B2B transaction status",
    description: "All transactions of one order id (B2B: several payments per order)",
    path: "/v2/{order_id}/status/b2b",
    params: { order_id: orderParam, page: { in: "query", type: "integer", min: 0 }, per_page: { in: "query", type: "integer", min: 1, max: 100 } },
  },
  coreWrite({ name: "cancel_transaction", title: "Cancel transaction", description: "Cancel a pending or captured (not yet settled) transaction", path: "/v2/{order_id}/cancel", params: { order_id: orderParam } }),
  coreWrite({ name: "expire_transaction", title: "Expire transaction", description: "Expire a pending transaction so it can no longer be paid", path: "/v2/{order_id}/expire", params: { order_id: orderParam } }),
  coreWrite({
    name: "refund_transaction",
    title: "Refund transaction",
    description: "Refund a settled transaction fully or partly: money goes back to the payer",
    path: "/v2/{order_id}/refund",
    checkHint: "get_transaction_status for the order (refund_amount, refunds); retrying with the same refund_key is safe for 7 days",
    params: {
      order_id: orderParam,
      refund_key: { in: "body", type: "string", description: "Your refund id (letters, digits, - _); reuse it to retry safely" },
      amount: { in: "body", type: "integer", min: 1, description: "IDR; default the full amount" },
      reason: { in: "body", type: "string" },
    },
  }),
  coreWrite({
    name: "direct_refund_transaction",
    title: "Direct refund transaction",
    description: "Refund through the payment provider at once (GoPay, ShopeePay, QRIS, cards): money goes back to the payer",
    path: "/v2/{order_id}/refund/online/direct",
    checkHint: "get_transaction_status for the order; retrying with the same refund_key is safe",
    params: {
      order_id: orderParam,
      refund_key: { in: "body", type: "string" },
      amount: { in: "body", type: "integer", min: 1 },
      reason: { in: "body", type: "string" },
    },
  }),
  coreWrite({ name: "approve_transaction", title: "Approve transaction", description: "Accept a card transaction flagged as challenge by fraud detection", path: "/v2/{order_id}/approve", params: { order_id: orderParam } }),
  coreWrite({ name: "deny_transaction", title: "Deny transaction", description: "Reject a card transaction flagged as challenge by fraud detection", path: "/v2/{order_id}/deny", params: { order_id: orderParam } }),
  coreWrite({
    name: "capture_transaction",
    title: "Capture transaction",
    description: "Capture an authorized (pre-auth) card transaction",
    path: "/v2/capture",
    params: {
      transaction_id: { in: "body", type: "string", required: true, minLength: 1, description: "Midtrans transaction id" },
      gross_amount: { in: "body", type: "integer", min: 1, description: "IDR to capture (default the authorized amount)" },
    },
  }),
];

/** The declarative definition before the wrappers; tests use it for the generated contract suite. */
export const restDefinition = defineRestPlugin({
  name: "midtrans",
  version: "0.1.0",
  description: "Midtrans (Indonesia): Snap payment pages and Core API transaction status; cancel, expire, refund and capture node only",
  apiName: "Midtrans Core API",
  baseUrl: (environment) => selectMidtransHosts(environment).core,
  allowedHostSuffix: ".midtrans.com",
  extraEnv: ["MIDTRANS_ENV", "MIDTRANS_TOOL_MAX_AMOUNT", "MIDTRANS_TOOL_API_EXTRA_PATHS"],
  // Server key as the Basic user, empty password (https://docs.midtrans.com/reference/https-header).
  auth: { type: "basic", tokenEnv: "MIDTRANS_SERVER_KEY", password: "" },
  defaultHeaders: { accept: "application/json" },
  // Core API POSTs accept Idempotency-Key (max 46 characters; a UUID is 36), kept 24 hours.
  idempotencyKeyHeader: "Idempotency-Key",
  // Core API: {"status_code": "404", "status_message": "..."}; Snap: {"error_messages": ["..."]}.
  errors: { messagePath: ["status_message", "error_messages.0"] },
  apiRequest: { examplePath: "/v2/ORDER-1/status" },
  operations: [...snapOperations, ...coreOperations],
});

const statusCheckedDefinition = checkBodyStatusCodes(restDefinition, {
  get_transaction_status: ["200", "201", "202", "407"],
  get_b2b_transaction_status: ["200", "201", "202", "407"],
  cancel_transaction: ["200"],
  expire_transaction: ["200", "407"],
  refund_transaction: ["200"],
  direct_refund_transaction: ["200"],
  approve_transaction: ["200"],
  deny_transaction: ["200"],
  capture_transaction: ["200"],
});
const cappedDefinition = capToolAmounts(statusCheckedDefinition, {
  operationNames: ["create_snap_transaction"],
  maxAmountEnv: "MIDTRANS_TOOL_MAX_AMOUNT",
  readCharges: (args) => [{ amount: args.gross_amount }],
  unitLabel: "IDR",
});

const guardedDefinition = guardToolApiRequest(cappedDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "MIDTRANS_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read transaction and subscription status; use a workflow node",
});

export const pluginDefinition = addKeyModeHint(guardedDefinition);
