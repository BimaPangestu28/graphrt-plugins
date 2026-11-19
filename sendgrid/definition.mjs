/**
 * sendgrid plugin definition: the Twilio SendGrid v3 Web API (https://www.twilio.com/docs/sendgrid/api-reference).
 * Send email (simple fields or a dynamic template), read templates, global stats, suppression lists (bounces,
 * blocks, spam reports, invalid emails, global unsubscribes) and unsubscribe groups. Built with the declarative REST
 * layer (docs/declarative-plugins.md); `send_mail` builds SendGrid's personalizations body from simple fields
 * (lib/sendgrid-mail.mjs). SENDGRID_REGION=eu selects the EU host for EU regional subusers.
 *
 * Agent policy: `send_mail` needs SENDGRID_TOOL_ALLOW_SEND=1 as a tool, and SENDGRID_TOOL_RECIPIENT_ALLOWLIST further
 * limits tool recipients. `send_mail_raw` (any body, many personalizations) is node only. api_request as a tool may
 * only read an allowlist of paths (lib/api-request-allowlist.mjs), because other GET endpoints expose API keys,
 * webhook and account settings.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";
import { replaceOperation } from "./lib/recipient-policy.mjs";
import { RECIPIENT_ALLOWLIST_ENV, SEND_OPT_IN_ENV, wrapSendMail } from "./lib/sendgrid-mail.mjs";

const REGION_ENV = "SENDGRID_REGION";
const HOSTS_BY_REGION = { global: "https://api.sendgrid.com/v3", eu: "https://api.eu.sendgrid.com/v3" };
const TOOL_READ_PATH_PREFIXES = ["/templates", "/stats", "/categories", "/suppression", "/asm", "/messages", "/verified_senders", "/whitelabel/domains", "/geo/stats", "/devices/stats", "/clients/stats","/mailbox_providers/stats", "/browsers/stats"];
const SEND_CHECK_HINT = "look the message up in Email Activity (dashboard or /v3/messages) by recipient and subject";

/**
 * Picks the API host from SENDGRID_REGION.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws Error - When SENDGRID_REGION is neither global nor eu (the layer reports invalid_input)
 */
function resolveRegionalBaseUrl(environment) {
  const region = (environment?.[REGION_ENV]?.trim() || "global").toLowerCase();
  if (!HOSTS_BY_REGION[region]) throw new Error(`${REGION_ENV} must be global or eu`);
  return HOSTS_BY_REGION[region];
}

const unixTime = (description) => ({ in: "query", type: "integer", min: 0, description });
const suppressionList = (name, title, path, description) => ({
  name,
  title,
  description,
  path,
  params: {
    start_time: unixTime("Only entries created at or after this Unix time"),
    end_time: unixTime("Only entries created at or before this Unix time"),
    email: { in: "query", type: "string", description: "Only addresses starting with this text, e.g. ada@ (use %25 as a wildcard)" },
  },
  response: { offsetPagination: { offsetParam: "offset", limitParam: "limit" }, maxLimit: 500, defaultLimit: 100 },
});

const mailOperations = [
  {
    name: "send_mail",
    title: "Send email",
    description: "Send an email (text/html or a dynamic template) to one set of recipients; accepted with 202 and no body",
    method: "POST",
    path: "/mail/send",
    write: "unsafe",
    toolPolicy: `optIn:${SEND_OPT_IN_ENV}`,
    checkHint: SEND_CHECK_HINT,
    // lib/sendgrid-mail.mjs builds these from simple fields.
    params: {
      personalizations: { in: "body", type: "array", items: { type: "object" }, maxItems: 1 },
      from: { in: "body", type: "object" },
      reply_to: { in: "body", type: "object" },
      subject: { in: "body", type: "string" },
      content: { in: "body", type: "array", items: { type: "object" } },
      template_id: { in: "body", type: "string" },
      categories: { in: "body", type: "array", items: { type: "string" } },
      send_at: { in: "body", type: "integer" },
      asm: { in: "body", type: "object" },
      mail_settings: { in: "body", type: "object" },
    },
  },
  {
    name: "send_mail_raw",
    title: "Send email (raw body)",
    description: "Send a full mail/send body (many personalizations, attachments, tracking settings); recipients are not checked",
    method: "POST",
    path: "/mail/send",
    write: "unsafe",
    nodeOnly: true,
    checkHint: SEND_CHECK_HINT,
    bodyMode: "raw",
    params: { message: { in: "body", type: "object", required: true, description: "The mail/send JSON body: {personalizations, from, subject, content, ...}" } },
  },
];

const templateOperations = [
  {
    name: "list_templates",
    title: "List templates",
    description: "Transactional templates (dynamic by default) with their versions",
    path: "/templates",
    params: { generations: { in: "query", type: "string", enum: ["legacy", "dynamic", "legacy,dynamic"], default: "dynamic", description: "Template generations to list" } },
    response: { dataPath: "result", nextUrlPath: "_metadata.next", limitParam: "page_size", maxLimit: 200, defaultLimit: 50 },
  },
  {
    name: "get_template",
    title: "Get template",
    description: "One template with all its versions (subject, html and plain content, active flag)",
    path: "/templates/{template_id}",
    params: { template_id: { in: "path", type: "string", required: true, description: "Template id, e.g. d-0123..." } },
  },
];

const statsAndSuppressionOperations = [
  {
    name: "get_global_stats",
    title: "Email stats",
    description: "Account-wide counts per day/week/month: requests, delivered, opens, clicks, bounces, spam reports, unsubscribes",
    path: "/stats",
    params: {
      start_date: { in: "query", type: "string", required: true, description: "First day, YYYY-MM-DD" },
      end_date: { in: "query", type: "string", description: "Last day, YYYY-MM-DD (default today)" },
      aggregated_by: { in: "query", type: "string", enum: ["day", "week", "month"], description: "Grouping (default day)" },
    },
  },
  suppressionList("list_bounces", "List bounces", "/suppression/bounces", "Addresses on the bounce list, with the bounce reason and SMTP status"),
  suppressionList("list_blocks", "List blocks", "/suppression/blocks", "Addresses whose receiving server blocked a message, with the reason"),
  suppressionList("list_spam_reports", "List spam reports", "/suppression/spam_reports", "Addresses that marked a message as spam"),
  suppressionList("list_invalid_emails", "List invalid emails", "/suppression/invalid_emails", "Addresses SendGrid found invalid, with the reason"),
  suppressionList("list_global_unsubscribes", "List global unsubscribes", "/suppression/unsubscribes", "Addresses that unsubscribed from all email"),
  {
    name: "list_unsubscribe_groups",
    title: "List unsubscribe groups",
    description: "Unsubscribe (suppression) groups with their unsubscribe counts; ids for send_mail asm_group_id",
    path: "/asm/groups",
  },
];

export const restDefinition = defineRestPlugin({
  name: "sendgrid",
  version: "0.1.0",
  description: "Twilio SendGrid: send email (simple fields or dynamic templates; agent sends need an opt-in and an optional recipient allowlist), templates, stats and suppression lists",
  apiName: "SendGrid v3 API",
  baseUrl: resolveRegionalBaseUrl,
  allowedHostSuffix: ".sendgrid.com",
  auth: { type: "bearer", env: "SENDGRID_API_KEY" },
  extraEnv: [REGION_ENV, RECIPIENT_ALLOWLIST_ENV],
  // Errors are {"errors": [{"message", "field", "help"}]}; the status gives the kind (401 auth, 403 permission, 429 rate).
  errors: { messagePath: ["errors.0.message", "message"] },
  apiRequest: { examplePath: "/categories" },
  operations: [...mailOperations, ...templateOperations, ...statsAndSuppressionOperations],
});

const guardApiRequest = (operation) => restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES);

export const pluginDefinition = [
  ["send_mail", wrapSendMail],
  ["api_request", guardApiRequest],
].reduce((definition, [operationName, wrap]) => replaceOperation(definition, operationName, wrap), restDefinition);
