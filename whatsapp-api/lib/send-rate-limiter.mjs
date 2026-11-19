/**
 * Client-side send limits for agent tool calls, kept in memory for the life of
 * the plugin process (graphrt keeps the process running between calls).
 *
 * WhatsApp enforces its own limits (messaging tiers per business portfolio,
 * 80 messages/s per number, one message every 6 s to the same user), and a
 * number whose quality drops gets restricted (131048). An agent stuck in a loop
 * can burn through that in seconds, so tool sends get a per-minute cap
 * (WHATSAPP_TOOL_SEND_RATE_LIMIT, default 20, `0` turns the limits off) and the
 * pair rate is applied before the request instead of after a 131056.
 * Workflow nodes are not limited: their volume is fixed by the workflow author.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const SEND_RATE_LIMIT_VARIABLE = "WHATSAPP_TOOL_SEND_RATE_LIMIT";
export const DEFAULT_SENDS_PER_MINUTE = 20;
export const PAIR_INTERVAL_MS = 6000;
const MAXIMUM_SENDS_PER_MINUTE = 1000;
const WINDOW_MS = 60000;

/**
 * Reads WHATSAPP_TOOL_SEND_RATE_LIMIT.
 *
 * @param environment - Environment variables (object)
 * @returns Sends per minute; 0 means no client-side limit (number)
 * @throws PluginError kind `invalid_input` - When the value is not an integer from 0 to 1000
 */
export function readSendsPerMinute(environment) {
  const rawValue = typeof environment?.[SEND_RATE_LIMIT_VARIABLE] === "string" ? environment[SEND_RATE_LIMIT_VARIABLE].trim() : "";
  if (rawValue === "") return DEFAULT_SENDS_PER_MINUTE;
  const sendsPerMinute = /^\d+$/.test(rawValue) ? Number(rawValue) : Number.NaN;
  if (!(sendsPerMinute <= MAXIMUM_SENDS_PER_MINUTE)) {
    throw new PluginError(`${SEND_RATE_LIMIT_VARIABLE} must be an integer from 0 to ${MAXIMUM_SENDS_PER_MINUTE} (0 turns the limit off), got ${JSON.stringify(rawValue)}`, { kind: "invalid_input" });
  }
  return sendsPerMinute;
}

/**
 * Creates the limiter.
 *
 * @param now - Clock in milliseconds (function)
 * @returns `{take({recipient, sendsPerMinute})}`; take records the send or throws `rate_limited` (object)
 */
export function createSendRateLimiter(now) {
  const sendTimes = [];
  const lastSendByRecipient = new Map();
  return {
    take: ({ recipient, sendsPerMinute }) => {
      if (sendsPerMinute === 0) return;
      const currentMs = now();
      while (sendTimes.length > 0 && sendTimes[0] <= currentMs - WINDOW_MS) sendTimes.shift();
      forgetQuietRecipients(lastSendByRecipient, currentMs);
      if (sendTimes.length >= sendsPerMinute) {
        throw rateLimited(`Agents may send at most ${sendsPerMinute} WhatsApp messages a minute (${SEND_RATE_LIMIT_VARIABLE})`, sendTimes[0] + WINDOW_MS - currentMs);
      }
      const lastSendMs = lastSendByRecipient.get(recipient);
      if (lastSendMs !== undefined && currentMs - lastSendMs < PAIR_INTERVAL_MS) {
        throw rateLimited("WhatsApp allows one message every 6 s to the same recipient (pair rate limit)", lastSendMs + PAIR_INTERVAL_MS - currentMs);
      }
      sendTimes.push(currentMs);
      lastSendByRecipient.set(recipient, currentMs);
    },
  };
}

/** Drops recipients whose last send is outside the pair interval, so the map stays small. */
function forgetQuietRecipients(lastSendByRecipient, currentMs) {
  for (const [recipient, lastSendMs] of lastSendByRecipient) {
    if (currentMs - lastSendMs >= PAIR_INTERVAL_MS) lastSendByRecipient.delete(recipient);
  }
}

function rateLimited(reason, retryAfterMs) {
  return new PluginError(`${reason}; try again in ${Math.ceil(retryAfterMs / 1000)} s`, { kind: "rate_limited", retryable: true, retryAfterMs });
}
