/**
 * Telegram Bot API client.
 *
 * The bot token is part of every URL (`https://api.telegram.org/bot<token>/<method>`), so the base URL
 * carries it and `authorize` returns it (plus the optional webhook secret) as a secret: the shared client
 * then redacts both from every error message and from `api_request` responses.
 *
 * Responses are `{ok, result}` on success and `{ok:false, error_code, description, parameters}` on failure;
 * `callBotMethod` unwraps `result`.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const TELEGRAM_ORIGIN = "https://api.telegram.org";
// "<bot id>:<secret>" as issued by @BotFather. Anything else could change the URL path, so it is refused.
const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;
const STATUS_KINDS = { 400: "invalid_input", 401: "auth_error", 403: "permission_denied", 404: "not_found", 429: "rate_limited" };
const NOT_FOUND_DESCRIPTION = /\bnot found\b/i;
const CONFLICT_HINT =
  "only one consumer may read updates: delete the webhook (telegram-bot.delete_webhook) or stop the other bot instance calling getUpdates";

/**
 * Creates a client bound to one bot token.
 *
 * @param options - `{accessToken, environment, fetchImpl}` from the operation runner (object)
 * @returns Shared API client `{request, requestWithHeaders}` (object)
 * @throws PluginError kind `auth_error` - When the token does not look like a Bot API token (the token is not echoed)
 */
export function createTelegramClient({ accessToken, environment, fetchImpl }) {
  if (typeof accessToken !== "string" || !BOT_TOKEN_PATTERN.test(accessToken)) {
    throw new PluginError('TELEGRAM_BOT_TOKEN is malformed: expected "<bot id>:<secret>" as issued by @BotFather', { kind: "auth_error" });
  }
  const webhookSecret = environment?.TELEGRAM_WEBHOOK_SECRET;
  return createApiClient({
    baseUrl: `${TELEGRAM_ORIGIN}/bot${accessToken}`,
    authorize: () => [accessToken, webhookSecret].filter(Boolean),
    parseError: parseTelegramError,
    detectBodyError: detectTelegramBodyError,
    fetchImpl,
  });
}

/**
 * Maps a Bot API error body to a message, error kind and retry hints.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind, retryAfterMs?, retryable?}`, or `{}` for non-Telegram bodies (object)
 */
export function parseTelegramError(status, body) {
  if (!body || body.ok !== false) return {};
  const errorCode = Number(body.error_code ?? status);
  const description = String(body.description ?? "Unknown Telegram error");
  const parameters = body.parameters ?? {};
  if (parameters.retry_after !== undefined) {
    return { message: `${description} (error_code ${errorCode})`, kind: "rate_limited", retryAfterMs: Number(parameters.retry_after) * 1000 };
  }
  if (parameters.migrate_to_chat_id !== undefined) {
    const message = `${description}: the group is now the supergroup ${parameters.migrate_to_chat_id}, use that chat_id`;
    return { message, kind: "invalid_input", retryable: false };
  }
  if (errorCode === 409) return { message: `${description}: ${CONFLICT_HINT}`, kind: "api_error", retryable: false };
  return { message: `${description} (error_code ${errorCode})`, kind: kindForTelegramError(errorCode, description) };
}

function kindForTelegramError(errorCode, description) {
  if (errorCode === 400 && NOT_FOUND_DESCRIPTION.test(description)) return "not_found";
  return STATUS_KINDS[errorCode] ?? "api_error";
}

/**
 * Detects `{ok:false}` inside a 2xx body (defensive: Telegram normally uses HTTP error statuses).
 *
 * @param body - Parsed response body (object)
 * @returns Error details for the shared client, or null (object | null)
 */
export function detectTelegramBodyError(body) {
  if (!body || body.ok !== false) return null;
  return parseTelegramError(Number(body.error_code) || 400, body);
}

/**
 * Calls one Bot API method and returns its `result`.
 *
 * Reads use GET with query parameters (retried on 5xx/network errors); everything else is a JSON POST,
 * which the shared client never retries after an unknown outcome.
 *
 * @param client - Client from createTelegramClient (object)
 * @param botMethod - Bot API method name, e.g. "sendMessage" (string)
 * @param options - `{params, signal, read, timeoutMs}`; `read: true` sends a GET (object)
 * @returns The method's `result` (any)
 */
export async function callBotMethod(client, botMethod, { params = {}, signal, read = false, timeoutMs } = {}) {
  const definedParams = Object.fromEntries(Object.entries(params).filter(([, paramValue]) => paramValue !== undefined));
  const requestOptions = read
    ? { method: "GET", path: `/${botMethod}`, query: definedParams, signal, timeoutMs }
    : { method: "POST", path: `/${botMethod}`, json: definedParams, signal, timeoutMs };
  const responseBody = await client.request(requestOptions);
  return responseBody?.result ?? null;
}

/**
 * Builds an operation `run` that calls one Bot API method with parameters derived from the arguments.
 *
 * @param botMethod - Bot API method name (string)
 * @param buildParams - `(args, environment) => params`; may throw invalid_input (function)
 * @param options - `{read}`; `read: true` sends a GET (object, optional)
 * @returns Operation `run` function returning `{data}` (function)
 *
 * @example
 * run: createBotMethodRunner("getChat", (args) => ({ chat_id: args.chat_id }), { read: true })
 */
export function createBotMethodRunner(botMethod, buildParams, { read = false } = {}) {
  return async ({ client, args, environment, signal }) => ({
    data: await callBotMethod(client, botMethod, { params: buildParams(args, environment), signal, read }),
  });
}
