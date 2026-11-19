/**
 * api_request guard for agent tools. Typeform has secret-bearing GET endpoints (webhooks return their HMAC
 * signing `secret`), so tools may only call an ALLOWLIST of read paths: account, forms, responses, form messages,
 * workspaces, themes, images and insights. Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

// Ids are letters, digits, "_" and "-": no dots, percent escapes or empty segments, so no traversal or encoding tricks.
const ID = "[A-Za-z0-9_-]+";
const READ_PATH_PATTERNS = [
  /^\/me$/,
  /^\/forms$/,
  new RegExp(`^/forms/${ID}$`),
  new RegExp(`^/forms/${ID}/(responses|messages)$`),
  /^\/workspaces$/,
  new RegExp(`^/workspaces/${ID}$`),
  /^\/themes$/,
  new RegExp(`^/themes/${ID}$`),
  /^\/images$/,
  new RegExp(`^/insights/${ID}/summary$`),
];

/**
 * Whether an api_request path is one of Typeform's allowed read endpoints.
 *
 * @param path - api_request `path`, e.g. "/forms/u6nXL7?x=1" (string)
 * @returns True for allowed reads (boolean)
 *
 * @example
 * isTypeformReadPath("/forms/u6nXL7/responses"); // true
 * isTypeformReadPath("/forms/u6nXL7/webhooks"); // false
 */
export function isTypeformReadPath(path) {
  const pathname = String(path ?? "").split(/[?#]/)[0];
  const withoutTrailingSlash = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return READ_PATH_PATTERNS.some((pattern) => pattern.test(withoutTrailingSlash));
}

/**
 * Wraps the generated api_request so tool calls can only reach the allowed read paths.
 *
 * @param apiRequestOperation - Generated api_request operation (object)
 * @returns Operation with the same schema and a guarded run (object)
 */
export function restrictApiRequestForTools(apiRequestOperation) {
  return {
    ...apiRequestOperation,
    description: `${apiRequestOperation.description} Agent tools may only read /me, /forms, /forms/{id}, /forms/{id}/responses, /forms/{id}/messages, /workspaces, /themes, /images and /insights/{id}/summary.`,
    run: (context) => {
      if (context.source === "tool" && !isTypeformReadPath(context.args?.path)) {
        throw new PluginError("api_request as an agent tool only reads forms, responses, workspaces, themes, images and insights (webhook endpoints hold signing secrets)", { kind: "permission_denied" });
      }
      return apiRequestOperation.run(context);
    },
  };
}
