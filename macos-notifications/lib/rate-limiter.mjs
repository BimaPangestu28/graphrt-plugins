/**
 * A sliding one-minute window for tool calls, kept in memory for the life of
 * the plugin process (graphrt keeps the process running between calls).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const WINDOW_MS = 60000;

/**
 * Creates a rate limiter.
 *
 * @param now - Clock in milliseconds (function)
 * @returns `{take: (limitPerMinute) => void}`; take throws when the window is full (object)
 */
export function createRateLimiter(now) {
  const callTimes = [];
  return {
    take: (limitPerMinute) => {
      const currentMs = now();
      while (callTimes.length > 0 && callTimes[0] <= currentMs - WINDOW_MS) callTimes.shift();
      if (callTimes.length >= limitPerMinute) {
        const retryAfterMs = callTimes[0] + WINDOW_MS - currentMs;
        throw new PluginError(`Agents may post at most ${limitPerMinute} notifications a minute (MACOS_NOTIFICATIONS_TOOL_RATE_LIMIT); try again in ${Math.ceil(retryAfterMs / 1000)} s`, { kind: "rate_limited", retryable: true, retryAfterMs });
      }
      callTimes.push(currentMs);
    },
  };
}
