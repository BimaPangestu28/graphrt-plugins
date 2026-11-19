/**
 * resend plugin definition: the Resend email API (https://resend.com/docs/api-reference/introduction). Send email
 * (html/text or a published template, scheduling, tags, topics), batch sends, read sent emails, reschedule or
 * cancel scheduled ones, and read sending domains with their DNS records. Built with the declarative REST layer
 * (docs/declarative-plugins.md). Sends carry an Idempotency-Key, so the shared client may retry them safely.
 *
 * Agent policy: `send_email` and `reschedule_email` need RESEND_TOOL_ALLOW_SEND=1 as tools, and
 * RESEND_TOOL_RECIPIENT_ALLOWLIST further limits tool recipients. Batch sends and cancelling are node only.
 * api_request as a tool may only read an allowlist of paths (lib/api-request-allowlist.mjs): other GET endpoints
 * expose API keys and webhook signing secrets, and /emails is left to get_email, whose tool results omit html/text
 * (lib/tool-result-redaction.mjs) because sent emails hold reset links and codes.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";
import { replaceOperation } from "./lib/recipient-policy.mjs";
import { RESEND_ERRORS, withInvalidApiKeyAsAuthError } from "./lib/resend-errors.mjs";
import { RECIPIENT_ALLOWLIST_ENV, SEND_OPT_IN_ENV, wrapSendEmail } from "./lib/resend-mail.mjs";
import { omitBodyFieldsForTools } from "./lib/tool-result-redaction.mjs";

const PLUGIN_VERSION = "0.1.0";
const SEND_POLICY = `optIn:${SEND_OPT_IN_ENV}`;
// No /emails: sent and received emails are read through get_email/list_emails, whose tool results omit bodies.
const TOOL_READ_PATH_PREFIXES = ["/domains", "/audiences", "/contacts", "/broadcasts", "/templates", "/topics", "/segments"];
const BODY_FIELDS = ["html", "text"];
const EMAIL_ID = { in: "path", type: "string", required: true, description: "Email id (from send_email or list_emails)" };
const DOMAIN_ID = { in: "path", type: "string", required: true, description: "Domain id (from list_domains)" };
const SEND_CHECK_HINT = "list_emails (or the Resend dashboard's Emails page) and look for the subject and recipient";
const afterIdPagination = { dataPath: "data", lastItemCursor: { itemIdPath: "id", param: "after", hasMorePath: "has_more" }, limitParam: "limit", maxLimit: 100, defaultLimit: 20 };
const addressList = (description, maxItems = 50) => ({ in: "body", type: "array", items: { type: "string" }, maxItems, description });

const sendEmailParams = {
  from: { in: "body", type: "string", description: 'Sender on a verified domain, e.g. "Acme <news@example.com>"' },
  to: addressList('Recipient addresses (max 50), e.g. ["ada@example.com"] (plain addresses)'),
  cc: addressList("Cc addresses"),
  bcc: addressList("Bcc addresses"),
  reply_to: addressList("Reply-To addresses"),
  subject: { in: "body", type: "string", description: "Subject (may come from the template)" },
  html: { in: "body", type: "string", description: "HTML body" },
  text: { in: "body", type: "string", description: "Plain-text body (generated from html when omitted)" },
  template_id: { in: "body", type: "string", wireName: "template.id", description: "Published template id or alias (instead of html/text)" },
  template_variables: { in: "body", type: "object", wireName: "template.variables", description: "Template variables, e.g. {PRODUCT: \"Acme\"}" },
  scheduled_at: { in: "body", type: "string", description: 'Send later: ISO 8601 or natural language such as "in 1 hour"' },
  tags: { in: "body", type: "array", items: { type: "object" }, maxItems: 50, description: 'Tags [{name, value}] (ASCII letters, digits, _ and -), e.g. [{"name": "category", "value": "welcome"}]' },
  topic_id: { in: "body", type: "string", description: "Topic id; contacts who opted out of the topic are skipped" },
};

const emailOperations = [
  {
    name: "send_email",
    title: "Send email",
    description: "Send an email (html/text or a template), now or scheduled; returns the email id",
    method: "POST",
    path: "/emails",
    write: "unsafe",
    idempotencyKeyHeader: "Idempotency-Key",
    toolPolicy: SEND_POLICY,
    checkHint: SEND_CHECK_HINT,
    params: sendEmailParams,
  },
  {
    name: "send_batch_emails",
    title: "Send batch",
    description: "Send up to 100 emails in one call (no attachments or scheduling); recipients are not checked",
    method: "POST",
    path: "/emails/batch",
    write: "unsafe",
    idempotencyKeyHeader: "Idempotency-Key",
    nodeOnly: true,
    checkHint: SEND_CHECK_HINT,
    bodyMode: "raw",
    params: { emails: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 100, description: "send_email bodies: [{from, to, subject, html|text}, ...]" } },
  },
  { name: "get_email", title: "Get email", description: "One sent email with its html/text, recipients, last_event and scheduled_at", path: "/emails/{email_id}", params: { email_id: EMAIL_ID } },
  { name: "list_emails", title: "List emails", description: "Emails your team sent, newest first", path: "/emails", response: afterIdPagination },
  {
    name: "reschedule_email",
    title: "Reschedule email",
    description: "Change the send time of a scheduled email",
    method: "PATCH",
    path: "/emails/{email_id}",
    // Setting the same time twice is harmless.
    write: "idempotent",
    toolPolicy: SEND_POLICY,
    params: { email_id: EMAIL_ID, scheduled_at: { in: "body", type: "string", required: true, description: "New send time, ISO 8601 or natural language" } },
  },
  { name: "cancel_email", title: "Cancel scheduled email", description: "Cancel a scheduled email before it is sent", method: "POST", path: "/emails/{email_id}/cancel", write: "idempotent", nodeOnly: true, params: { email_id: EMAIL_ID } },
];

const domainOperations = [
  { name: "list_domains", title: "List domains", description: "Sending domains with status, region and capabilities", path: "/domains", response: afterIdPagination },
  { name: "get_domain", title: "Get domain", description: "One domain with its verification status and the DNS records to publish", path: "/domains/{domain_id}", params: { domain_id: DOMAIN_ID } },
];

export const restDefinition = defineRestPlugin({
  name: "resend",
  version: PLUGIN_VERSION,
  description: "Resend: send email (idempotent retries; agent sends need an opt-in and an optional recipient allowlist), batch sends, sent emails, scheduling and domains",
  apiName: "Resend API",
  baseUrl: "https://api.resend.com",
  auth: { type: "bearer", env: "RESEND_API_KEY" },
  // Resend refuses requests without a User-Agent (403, error 1010).
  defaultHeaders: { "User-Agent": `graphrt-resend/${PLUGIN_VERSION}` },
  extraEnv: [RECIPIENT_ALLOWLIST_ENV],
  errors: RESEND_ERRORS,
  apiRequest: { examplePath: "/audiences" },
  operations: [...emailOperations, ...domainOperations],
});

const guardApiRequest = (operation) => restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES);

/**
 * Applies the plugin's wrappers: simple-field checks for send_email, the api_request path allowlist (optional, the
 * contract suite runs without it) and the invalid-key remap on every operation.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{guardApiRequestPaths}` (object)
 * @returns Wrapped definition (object)
 */
export function wrapResendDefinition(definition, { guardApiRequestPaths = true } = {}) {
  const wrapped = replaceOperation(replaceOperation(definition, "send_email", wrapSendEmail), "get_email", (operation) => omitBodyFieldsForTools(operation, BODY_FIELDS));
  const guarded = guardApiRequestPaths ? replaceOperation(wrapped, "api_request", guardApiRequest) : wrapped;
  return { ...guarded, operations: guarded.operations.map(withInvalidApiKeyAsAuthError) };
}

export const pluginDefinition = wrapResendDefinition(restDefinition);
