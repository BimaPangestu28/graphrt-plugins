/**
 * Daily send cap for one SMTP account, persisted as JSON so it holds across
 * plugin restarts. Every recipient (to + cc + bcc) of every attempted message
 * counts once; the "day" is the local calendar day of the clock.
 *
 * Fails closed: an unreadable or corrupt state file blocks sending
 * (`rate_limited`) instead of resetting the counter, and a clock that moved
 * back to an earlier day keeps the saved day's count. Reservations are
 * serialised within the process, and each read-modify-write runs under a
 * lock file (`<state file>.lock`, see file-lock.mjs) so several plugin
 * processes sharing the state directory cannot lose updates or together pass
 * the cap.
 *
 * State file: `{ "day": "2026-11-18", "count": 12, "last_send_at": 1763467200000 }`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { withFileLock } from "./file-lock.mjs";

const SYSTEM_CLOCK = { now: () => Date.now() };
/** Longest wait for another process's reservation; a reservation itself takes milliseconds. */
export const DEFAULT_LOCK_TIMEOUT_MS = 10000;

/**
 * Creates a send guard.
 *
 * @param options - Guard options (object)
 * @param options.stateFilePath - JSON file holding the counter (string)
 * @param options.dailyLimit - Maximum recipients per local day; 0 disables sending (number)
 * @param options.clock - `{now()}`, injectable for tests (object, optional)
 * @param options.lockTimeoutMs - Wait for the counter lock held by another process (number, optional)
 * @returns `{reserveSend(recipientCount), getUsage()}` (object)
 *
 * @example
 * const guard = createSendGuard({ stateFilePath, dailyLimit: 200 });
 * await guard.reserveSend(3); // throws rate_limited when 3 more would pass the cap
 */
export function createSendGuard({ stateFilePath, dailyLimit, clock = SYSTEM_CLOCK, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }) {
  let reservationQueue = Promise.resolve();
  const readState = () => readSendState(stateFilePath, formatLocalDay(clock.now()));
  const updateCounter = async (recipientCount) => {
    const currentState = await readState();
    assertUnderDailyLimit(currentState, recipientCount, dailyLimit, clock.now());
    const nextState = { day: currentState.day, count: currentState.count + recipientCount, last_send_at: clock.now() };
    await writeStateAtomically(stateFilePath, nextState);
    return { sends_today: nextState.count, daily_limit: dailyLimit };
  };
  const reserve = async (recipientCount) => {
    await mkdir(dirname(stateFilePath), { recursive: true, mode: 0o700 });
    return withFileLock(`${stateFilePath}.lock`, () => updateCounter(recipientCount), {
      timeoutMs: lockTimeoutMs,
      onTimeout: () => lockBusyError(stateFilePath, lockTimeoutMs),
    });
  };
  return {
    /**
     * Checks the cap and records the recipients, right before the message is handed to SMTP
     * (so attempts count even when the send then fails).
     *
     * @param recipientCount - Recipients of the message (number)
     * @returns `{sends_today, daily_limit}` (Promise<object>)
     * @throws PluginError kind `rate_limited` - Cap reached, or the state file is unusable
     */
    reserveSend(recipientCount) {
      const reservation = reservationQueue.then(() => reserve(recipientCount));
      reservationQueue = reservation.catch(() => {});
      return reservation;
    },
    /** @returns `{sends_today, daily_limit, last_send_at}` (Promise<object>) */
    async getUsage() {
      const currentState = await readState();
      return { sends_today: currentState.count, daily_limit: dailyLimit, last_send_at: currentState.last_send_at };
    },
  };
}

function assertUnderDailyLimit(sendState, recipientCount, dailyLimit, nowMs) {
  if (sendState.count + recipientCount <= dailyLimit) return;
  const msUntilMidnight = startOfNextLocalDay(nowMs) - nowMs;
  const remaining = Math.max(0, dailyLimit - sendState.count);
  throw new PluginError(
    `Email daily send limit reached: ${sendState.count} of ${dailyLimit} recipients used today (EMAIL_DAILY_SEND_LIMIT), ` +
      `this message has ${recipientCount} and ${remaining} remain; it resets at local midnight in ${Math.ceil(msUntilMidnight / 60000)} min`,
    { kind: "rate_limited", retryable: false, retryAfterMs: msUntilMidnight },
  );
}

async function readSendState(stateFilePath, today) {
  let rawContent;
  try {
    rawContent = await readFile(stateFilePath, "utf8");
  } catch (readError) {
    if (readError.code === "ENOENT") return { day: today, count: 0, last_send_at: null };
    throw unusableStateError(stateFilePath, readError.message);
  }
  const savedState = parseSavedState(rawContent);
  if (!savedState) throw unusableStateError(stateFilePath, "its content is not a valid send state");
  // Days compare as YYYY-MM-DD strings; a saved day "ahead" of the clock means the clock moved back.
  if (savedState.day >= today) return savedState;
  return { day: today, count: 0, last_send_at: savedState.last_send_at };
}

function parseSavedState(rawContent) {
  let savedState;
  try {
    savedState = JSON.parse(rawContent);
  } catch {
    return null;
  }
  const isValid =
    savedState !== null &&
    typeof savedState === "object" &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(savedState.day)) &&
    Number.isInteger(savedState.count) &&
    savedState.count >= 0 &&
    (savedState.last_send_at === null || Number.isFinite(savedState.last_send_at));
  return isValid ? { day: savedState.day, count: savedState.count, last_send_at: savedState.last_send_at } : null;
}

function unusableStateError(stateFilePath, reason) {
  return new PluginError(
    `Email sending is blocked: the send counter file ${stateFilePath} cannot be used (${reason}). ` +
      "Fix it, or delete it to reset today's count (the daily limit then starts again from 0).",
    { kind: "rate_limited", retryable: false },
  );
}

function lockBusyError(stateFilePath, lockTimeoutMs) {
  return new PluginError(
    `Email sending is busy: another process held the send counter lock ${stateFilePath}.lock for over ${lockTimeoutMs / 1000} s. ` +
      "Nothing was sent; try again shortly. If no other graphrt run is sending, delete the lock file.",
    { kind: "rate_limited", retryable: true, retryAfterMs: 1000 },
  );
}

async function writeStateAtomically(stateFilePath, sendState) {
  const temporaryPath = `${stateFilePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(sendState)}\n`, { mode: 0o600 });
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
