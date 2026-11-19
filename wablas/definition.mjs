/**
 * wablas plugin definition: Wablas, an Indonesian WhatsApp gateway (https://pati.wablas.com/documentation/api).
 * Each account lives on its own server (pati.wablas.com, jkt.wablas.com, ...), so the base URL comes from
 * WABLAS_DOMAIN and must be a *.wablas.com host. Built with the declarative REST layer
 * (docs/declarative-plugins.md); requests carry `Authorization: <token>.<secret_key>` (custom auth), and
 * `get_device_info`, which takes the token as a query parameter instead, is hand-written (lib/device-info.mjs).
 *
 * Agent policy: the sends need WABLAS_TOOL_ALLOW_SEND=1 as tools and the recipient in
 * WABLAS_TOOL_RECIPIENT_ALLOWLIST (E.164 numbers or prefixes; unset refuses tool sends). Each send has one
 * recipient (the v2 batch of up to 50 rows is not exposed). Resending is node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardRecipients, normalizeE164, wrapOperations } from "./lib/recipient-policy.mjs";
import { createDeviceInfoOperation, TOKEN_ENV } from "./lib/device-info.mjs";

export const SEND_OPT_IN_ENV = "WABLAS_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "WABLAS_TOOL_RECIPIENT_ALLOWLIST";
const DOMAIN_ENV = "WABLAS_DOMAIN";
const SECRET_KEY_ENV = "WABLAS_SECRET_KEY";
const RECIPIENT_POLICY = { optInEnv: SEND_OPT_IN_ENV, allowlistEnv: RECIPIENT_ALLOWLIST_ENV, entryKind: "phone" };
const WABLAS_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.wablas\.com$/;
const SEND_CHECK_HINT = "list_message_reports with the phone (or ref_id) before sending again";

// Fields of one v2 data row, besides `phone`; the wrapper below builds `{data: [row]}`.
const ROW_FIELDS = {
  send_message: { message: { type: "string", minLength: 1, description: "Message text" } },
  send_image: { image: { type: "string", description: "Public URL of a JPG or PNG (max 2 MB)" }, caption: { type: "string", description: "Caption (up to 1024 characters)" } },
  send_document: { document: { type: "string", description: "Public URL of a doc, docx, pdf, odt, csv, ppt, pptx, xls, xlsx or txt file" }, caption: { type: "string", description: "Document name / caption" } },
  send_video: { video: { type: "string", description: "Public URL of an MP4 video" }, caption: { type: "string", description: "Caption" } },
};
const REQUIRED_ROW_FIELDS = { send_message: ["message"], send_image: ["image"], send_document: ["document"], send_video: ["video", "caption"] };

const sendOperation = (name, title, description, path) => ({
  name,
  title,
  description,
  method: "POST",
  path,
  write: "unsafe",
  toolPolicy: `optIn:${SEND_OPT_IN_ENV}`,
  checkHint: SEND_CHECK_HINT,
  params: { rows: { in: "body", type: "array", items: { type: "object" }, maxItems: 1, wireName: "data", description: "Built from phone and the content fields" } },
});
const messageIdQuery = { in: "query", type: "string", required: true, wireName: "id", description: "Message id from a send or a report" };

const operations = [
  {
    name: "list_message_reports",
    title: "Message reports",
    description: "Sent and received messages with their status (pending, sent, read, cancel), newest first",
    path: "/api/report/message",
    params: {
      phone: { in: "query", type: "string", description: "Only this number (digits with country code, e.g. 6281234567890)" },
      ref_id: { in: "query", type: "string", description: "Only messages with this ref_id" },
      status: { in: "query", type: "string", enum: ["pending", "sent", "read", "cancel"] },
      date: { in: "query", type: "string", description: "Only this day, YYYY-MM-DD" },
      message_id: { in: "query", type: "string", description: "One message id" },
    },
    response: { dataPath: "message", pagePagination: { pageParam: "page", sizeParam: "perPage", totalPagesPath: "totalPage" }, maxLimit: 100, defaultLimit: 20 },
  },
  sendOperation("send_message", "Send message", "Send a WhatsApp text to one number (queued; paid from the device quota)", "/api/v2/send-message"),
  sendOperation("send_image", "Send image", "Send a WhatsApp image by URL to one number", "/api/v2/send-image"),
  sendOperation("send_document", "Send document", "Send a WhatsApp document by URL to one number", "/api/v2/send-document"),
  sendOperation("send_video", "Send video", "Send a WhatsApp video by URL to one number", "/api/v2/send-video"),
  {
    name: "cancel_message",
    title: "Cancel message",
    description: "Cancel a pending message so it is not sent",
    path: "/api/cancel-message",
    write: "idempotent",
    toolPolicy: `optIn:${SEND_OPT_IN_ENV}`,
    params: { message_id: messageIdQuery },
  },
  {
    name: "resend_message",
    title: "Resend message",
    description: "Send a failed or pending message again",
    path: "/api/resend-message",
    write: "unsafe",
    nodeOnly: true,
    checkHint: SEND_CHECK_HINT,
    params: { message_id: messageIdQuery },
  },
];

/**
 * Resolves WABLAS_DOMAIN (a host such as pati.wablas.com, or its https URL) to the base URL.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws Error - Not a *.wablas.com host (becomes invalid_input)
 */
export function buildWablasBaseUrl(environment) {
  const host = String(environment[DOMAIN_ENV] ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, "");
  if (!WABLAS_HOST_PATTERN.test(host)) throw new Error(`${DOMAIN_ENV} must be your Wablas server host, e.g. pati.wablas.com (see Device → Settings)`);
  return `https://${host}`;
}

/**
 * Wraps a {message: kind} table so lookups ignore case, surrounding spaces and a trailing period ("Token Invalid.",
 * "TOKEN INVALID" and "token invalid" are one code). The REST layer reads kindByCode with a plain property lookup,
 * so a Proxy keeps the spec declarative.
 *
 * @param kindsByMessage - Lower-case messages without trailing period, mapped to error kinds (object)
 * @returns Lookup object (Proxy)
 *
 * @example
 * createCaseInsensitiveKinds({ "token invalid": "auth_error" })["Token Invalid."]; // "auth_error"
 */
export function createCaseInsensitiveKinds(kindsByMessage) {
  const normalize = (message) => String(message).trim().replace(/\.$/, "").replace(/\s+/g, " ").toLowerCase();
  return new Proxy(kindsByMessage, {
    get: (table, message) => (typeof message === "string" ? table[normalize(message)] : Reflect.get(table, message)),
  });
}

/**
 * Sets `Authorization: <token>.<secret_key>` (just the token when no secret key is set).
 *
 * @param signing - `{headers, credential, environment}` from the REST layer (object)
 * @returns Extra secrets to redact (string[])
 */
function authorizeWablas({ headers, credential, environment }) {
  const secretKey = String(environment?.[SECRET_KEY_ENV] ?? "").trim();
  const headerValue = secretKey ? `${credential}.${secretKey}` : credential;
  headers.authorization = headerValue;
  return secretKey ? [secretKey, headerValue] : [];
}

const restDefinition = defineRestPlugin({
  name: "wablas",
  version: "0.1.0",
  description: "Wablas WhatsApp gateway (Indonesia): send text, images, documents and videos to one number, message reports, cancel, device info; agent sends need an opt-in and an E.164 recipient allowlist",
  apiName: "Wablas API",
  baseUrl: buildWablasBaseUrl,
  allowedHostSuffix: ".wablas.com",
  auth: { type: "custom", env: TOKEN_ENV, authorize: authorizeWablas },
  extraEnv: [DOMAIN_ENV, SECRET_KEY_ENV, RECIPIENT_ALLOWLIST_ENV],
  // Successful bodies have `status: true`; failures `status: false` and a `message`, with 4xx/5xx or 200. Business
  // errors come as 500 with a fixed message (a bad token answers 500 "token invalid"), so the message doubles as the
  // code: mapped messages are not server failures and are neither retried nor reported as "outcome unknown".
  errors: {
    messagePath: ["error", "message"],
    codePath: "message",
    okPath: "status",
    okValue: true,
    retryAfterPath: "retry_after",
    kindByCode: createCaseInsensitiveKinds({
      "token invalid": "auth_error",
      "token invalid or device expired": "auth_error",
      "token is null": "auth_error",
      "secret key invalid": "auth_error",
      unauthenticated: "auth_error",
      "quota is not enough, please top up your quota": "permission_denied",
    }),
  },
  // Wablas runs writes as GET (cancel, resend, blacklist), so there is no GET-only api_request.
  apiRequest: false,
  operations,
});

/**
 * Wraps a v2 send: `phone` plus the row fields become `{data: [row]}`, and the recipient is checked.
 *
 * @param operation - Generated send operation (object)
 * @returns Operation with simple parameters (object)
 */
function wrapSend(operation) {
  const rowFields = ROW_FIELDS[operation.name];
  const properties = {
    phone: { type: "string", description: 'Recipient in E.164 with +, e.g. "+6281234567890"' },
    ...rowFields,
    ref_id: { type: "string", description: "Your reference, to find the message in reports" },
  };
  const prepareSend = (args) => {
    const phone = normalizeE164(args.phone, "phone");
    const row = Object.fromEntries(Object.entries({ ...args, phone: phone.slice(1) }).filter(([fieldName, value]) => fieldName in properties && value !== undefined));
    return { args: { rows: [row] }, recipients: [phone] };
  };
  const guarded = guardRecipients(operation, prepareSend, RECIPIENT_POLICY);
  return { ...guarded, parameters: { type: "object", properties, required: ["phone", ...REQUIRED_ROW_FIELDS[operation.name]] } };
}

const wrappedDefinition = wrapOperations(restDefinition, Object.fromEntries(Object.keys(ROW_FIELDS).map((operationName) => [operationName, wrapSend])));

export const pluginDefinition = { ...wrappedDefinition, operations: [createDeviceInfoOperation(), ...wrappedDefinition.operations] };
