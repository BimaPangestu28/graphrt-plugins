/**
 * `api_request`: any Bot API method without a dedicated operation, as path "/<methodName>".
 *
 * Restrictions on top of the shared operation:
 * - the path must be a single method name, so it can never reach another bot's URL or the file endpoint;
 * - only GET and POST (the methods the Bot API accepts);
 * - methods that reroute or disable the bot (webhooks, logOut, close) and getUpdates are refused: they are
 *   node-only operations, have a dedicated operation, or are deliberately unsupported;
 * - agent tool calls may only use get* methods (even GET can send or pay in the Bot API).
 * Responses are redacted (the token is a secret) and the Bot API `result` is returned.
 */
import { createApiRequestOperation } from "../lib/shared/api-request-operation.mjs";
import { rejectInput } from "../lib/arguments.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";

const BOT_METHOD_PATH_PATTERN = /^\/[A-Za-z][A-Za-z0-9]{0,63}$/;
const ALLOWED_HTTP_METHODS = new Set(["GET", "POST"]);
// Method names are case-insensitive in the Bot API, so compare in lower case.
const REFUSED_BOT_METHODS = new Map([
  ["setwebhook", "use the node-only operation set_webhook"],
  ["deletewebhook", "use the node-only operation delete_webhook"],
  ["logout", "logging the bot out of the cloud Bot API is not supported"],
  ["close", "closing the bot instance is not supported"],
  ["getupdates", "use get_updates, which keeps the update offset consistent"],
]);
// Agent tool calls may only read: in the Bot API even GET can send, pay or delete, so the rule is by method name.
const TOOL_READ_METHOD_PATTERN = /^get/i;

const sharedApiRequestOperation = createApiRequestOperation({ apiName: "Telegram Bot API", examplePath: "/getMyCommands" });

function checkToolRequest(args, source) {
  if (source !== "tool" || TOOL_READ_METHOD_PATTERN.test(args.path.slice(1))) return;
  throw new PluginError(
    `${args.path.slice(1)} is not available to agents through api_request: only get* methods are; use a dedicated operation or a workflow node`,
    { kind: "permission_denied" },
  );
}

function checkBotMethodRequest(args) {
  if (!BOT_METHOD_PATH_PATTERN.test(args.path)) rejectInput('`path` must be a Bot API method name such as "/getMyCommands" (no other segments, query or token)');
  if (!ALLOWED_HTTP_METHODS.has(String(args.method).toUpperCase())) rejectInput("`method` must be GET or POST for the Bot API");
  const refusalReason = REFUSED_BOT_METHODS.get(args.path.slice(1).toLowerCase());
  if (refusalReason) rejectInput(`${args.path.slice(1)} is not available through api_request: ${refusalReason}`);
}

export const apiRequestOperation = {
  ...sharedApiRequestOperation,
  description:
    'Call any Telegram Bot API method that has no dedicated operation, e.g. path "/getMyCommands" (GET with query) or "/setMyCommands" (POST with JSON body). Returns the method\'s result.',
  run: async (context) => {
    checkBotMethodRequest(context.args);
    checkToolRequest(context.args, context.source);
    const { data } = await sharedApiRequestOperation.run(context);
    return { data: data?.result ?? null };
  },
};
