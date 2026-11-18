/**
 * Send rate limiting for a personal WhatsApp account: a minimum interval
 * between sends and a daily cap, persisted as JSON so they hold across
 * plugin restarts. The "day" is the local calendar day of the clock.
 *
 * State file: `{ "day": "2026-11-18", "count": 3, "last_send_at": 1763467200000 }`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { sleepUnlessCancelled } from "./shared/sleep.mjs";

/** Longest interval wait done inline; longer waits fail with `rate_limited` instead. */
export const MAX_INLINE_WAIT_MS = 60000;

const SYSTEM_CLOCK = {
  now: () => Date.now(),
  sleep: (delayMs, signal) => sleepUnlessCancelled(delayMs, signal, "WhatsApp Web send cancelled"),
};

/**
 * Creates a send guard.
 *
 * @param options - Guard options (object)
 * @param options.stateFilePath - JSON file holding the counters (string)
 * @param options.minIntervalMs - Minimum time between two sends (number)
 * @param options.dailyLimit - Maximum sends per local day; 0 disables sending (number)
 * @param options.clock - `{now(), sleep(ms, signal)}`, injectable for tests (object, optional)
 * @returns `{reserveSend({signal}), getUsage()}` (object)
 *
 * @example
 * const guard = createSendGuard({ stateFilePath, minIntervalMs: 5000, dailyLimit: 50 });
 * await guard.reserveSend({ signal }); // waits or throws rate_limited, then counts the send
 */
export function createSendGuard({ stateFilePath, minIntervalMs, dailyLimit, clock = SYSTEM_CLOCK }) {
  const readState = () => readSendState(stateFilePath, formatLocalDay(clock.now()));
  return {
    /**
     * Waits out the minimum interval, enforces the daily cap and records one send.
     * Called right before a message is sent, so attempts count even if the send then fails.
     *
     * @returns `{sends_today, daily_limit}` (Promise<object>)
     * @throws PluginError kind `rate_limited` (daily cap, or an interval longer than MAX_INLINE_WAIT_MS), `cancelled`
     */
    async reserveSend({ signal } = {}) {
      assertUnderDailyLimit(await readState(), dailyLimit, clock.now());
      await waitForInterval((await readState()).last_send_at, minIntervalMs, clock, signal);
      const currentState = await readState();
      assertUnderDailyLimit(currentState, dailyLimit, clock.now());
      const nextState = { day: formatLocalDay(clock.now()), count: currentState.count + 1, last_send_at: clock.now() };
      await writeStateAtomically(stateFilePath, nextState);
      return { sends_today: nextState.count, daily_limit: dailyLimit };
    },
    /** @returns `{sends_today, daily_limit, last_send_at}` (Promise<object>) */
    async getUsage() {
      const currentState = await readState();
      return { sends_today: currentState.count, daily_limit: dailyLimit, last_send_at: currentState.last_send_at };
    },
  };
}

async function waitForInterval(lastSendAt, minIntervalMs, clock, signal) {
  if (!lastSendAt) return;
  const remainingMs = lastSendAt + minIntervalMs - clock.now();
  if (remainingMs <= 0) return;
  if (remainingMs > MAX_INLINE_WAIT_MS) {
    throw new PluginError(`WhatsApp Web send interval: next send allowed in ${Math.ceil(remainingMs / 1000)} s`, {
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: remainingMs,
    });
  }
  await clock.sleep(remainingMs, signal);
}

function assertUnderDailyLimit(sendState, dailyLimit, nowMs) {
  if (sendState.count < dailyLimit) return;
  const msUntilMidnight = startOfNextLocalDay(nowMs) - nowMs;
  throw new PluginError(
    `WhatsApp Web daily send limit of ${dailyLimit} reached (WHATSAPP_WEB_DAILY_SEND_LIMIT); it resets at local midnight in ${Math.ceil(msUntilMidnight / 60000)} min`,
    { kind: "rate_limited", retryable: false, retryAfterMs: msUntilMidnight },
  );
}

async function readSendState(stateFilePath, today) {
  const emptyState = { day: today, count: 0, last_send_at: null };
  let savedState;
  try {
    savedState = JSON.parse(await readFile(stateFilePath, "utf8"));
  } catch (readError) {
    if (readError.code !== "ENOENT") console.error(`[whatsapp-web] ignoring unreadable send state ${stateFilePath}: ${readError.message}`);
    return emptyState;
  }
  const lastSendAt = Number.isFinite(savedState?.last_send_at) ? savedState.last_send_at : null;
  if (savedState?.day !== today) return { ...emptyState, last_send_at: lastSendAt };
  return { day: today, count: Number.isInteger(savedState.count) ? savedState.count : 0, last_send_at: lastSendAt };
}

async function writeStateAtomically(stateFilePath, sendState) {
  await mkdir(dirname(stateFilePath), { recursive: true });
  const temporaryPath = `${stateFilePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(sendState)}\n`);
  await rename(temporaryPath, stateFilePath);
}

function formatLocalDay(timestampMs) {
  const date = new Date(timestampMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfNextLocalDay(timestampMs) {
  const date = new Date(timestampMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}
