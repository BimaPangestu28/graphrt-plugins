/**
 * Receiving updates by long polling (getUpdates).
 *
 * Telegram confirms (drops) every update below the `offset` of a call, so pass `next_cursor` back as
 * `cursor`: without it the same updates come back again. getUpdates fails with 409 while a webhook is set.
 */
import { ALLOWED_UPDATES_PROPERTY, rejectInput } from "../lib/arguments.mjs";
import { callBotMethod } from "../lib/client.mjs";

const MAX_LONG_POLL_SECONDS = 25;
// Telegram answers a long poll after `timeout` seconds; the request gets this much on top before it is abandoned.
const LONG_POLL_MARGIN_MS = 10000;
const OFFSET_PATTERN = /^-?\d+$/;

/**
 * Per-request timeout for a getUpdates call with the given long-poll timeout.
 *
 * @param longPollSeconds - getUpdates `timeout` (number, 0-25)
 * @returns Request timeout in milliseconds (number)
 *
 * @example
 * getUpdatesTimeoutMs(25); // 35000
 */
export function getUpdatesTimeoutMs(longPollSeconds) {
  return longPollSeconds * 1000 + LONG_POLL_MARGIN_MS;
}

function resolveOffset(args) {
  const cursorOffset = args.cursor === undefined ? undefined : args.cursor.trim();
  const isValidCursor = cursorOffset === undefined || (OFFSET_PATTERN.test(cursorOffset) && Number.isSafeInteger(Number(cursorOffset)));
  if (!isValidCursor) rejectInput("`cursor` must be an update offset (an integer) from next_cursor");
  if (cursorOffset !== undefined && args.offset !== undefined && Number(cursorOffset) !== args.offset) {
    rejectInput("Pass `cursor` or `offset`, not two different values");
  }
  return args.offset ?? (cursorOffset === undefined ? undefined : Number(cursorOffset));
}

function nextCursorOf(updates) {
  if (!Array.isArray(updates) || updates.length === 0) return null;
  const highestUpdateId = Math.max(...updates.map((update) => Number(update.update_id)));
  return Number.isFinite(highestUpdateId) ? String(highestUpdateId + 1) : null;
}

async function runGetUpdates({ client, args, signal }) {
  const params = {
    offset: resolveOffset(args),
    limit: args.limit,
    timeout: args.long_poll_seconds,
    // The shared client joins string arrays with commas; Telegram wants a JSON array.
    allowed_updates: args.allowed_updates === undefined ? undefined : JSON.stringify(args.allowed_updates),
  };
  const updates = await callBotMethod(client, "getUpdates", { params, signal, read: true, timeoutMs: getUpdatesTimeoutMs(args.long_poll_seconds) });
  return { data: updates ?? [], next_cursor: nextCursorOf(updates) };
}

export const updateOperations = [
  {
    name: "get_updates",
    title: "Get Telegram updates",
    description:
      "Fetch new messages, button presses and other updates by long polling. Pass next_cursor back as cursor (or store it with state-store); it also confirms the updates already received. Fails while a webhook is set.",
    parameters: {
      type: "object",
      properties: {
        cursor: { type: "string", description: "next_cursor from a previous call (last update_id + 1)" },
        offset: { type: "integer", description: "Raw getUpdates offset instead of cursor; negative values read from the end of the queue" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 100, description: "Maximum updates to return" },
        long_poll_seconds: { type: "integer", minimum: 0, maximum: MAX_LONG_POLL_SECONDS, default: 0, description: "Long-poll seconds to wait for updates (0 = return at once; sent as `timeout`)" },
        allowed_updates: ALLOWED_UPDATES_PROPERTY,
      },
    },
    run: runGetUpdates,
  },
];
