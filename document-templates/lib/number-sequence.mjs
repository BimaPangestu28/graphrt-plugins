/**
 * Running document numbers such as INV-2026-0042.
 *
 * A pattern has date tokens ({YYYY}, {YY}, {MM}, {DD}, {ROMAN} for the month
 * as a Roman numeral, common in Indonesian numbering) and one sequence
 * token ({SEQ} or {SEQ:4} for zero padding). The pattern with its date
 * tokens filled is the counter's name, so "INV-{YYYY}-{SEQ:4}" starts again
 * at 1 every year and "INV-{YYYY}{MM}-{SEQ:3}" every month.
 *
 * Counters live in `.document-templates/numbering.json` inside the output
 * directory. A lock file (created exclusively) serialises updates between
 * processes, and the file is replaced with rename(), so a crash never leaves
 * half a counter file.
 */
import { promises as defaultFileSystem } from "node:fs";
import { join } from "node:path";
import { invalidInput, operationFailed } from "./errors.mjs";
import { parseIsoDate } from "./formatting.mjs";

export const DEFAULT_NUMBER_PATTERN = "INV-{YYYY}-{SEQ:4}";
const STATE_DIRECTORY_NAME = ".document-templates";
const STATE_FILE_NAME = "numbering.json";
const LOCK_FILE_NAME = "numbering.lock";
const SEQUENCE_TOKEN_PATTERN = /\{SEQ(?::(\d{1,2}))?\}/g;
const ALLOWED_PATTERN = /^[A-Za-z0-9 ._\/#-]*$/;
const MAX_PATTERN_LENGTH = 60;
const MAX_COUNTERS = 2000;
const MAX_SEQUENCE = 999999999;
const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 40;
const STALE_LOCK_MS = 30000;
const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

/**
 * Splits a number pattern into its counter name and a formatter.
 *
 * @param pattern - e.g. "INV-{YYYY}-{SEQ:4}" (string)
 * @param date - Date whose year, month and day fill the date tokens (Date, read as UTC)
 * @returns `{counterName, format(sequence)}` (object)
 * @throws PluginError kind `invalid_input` - When the pattern has no single {SEQ} token or unsupported characters
 *
 * @example
 * resolveNumberPattern("INV-{YYYY}-{SEQ:4}", new Date("2026-11-27")).format(42); // "INV-2026-0042"
 */
export function resolveNumberPattern(pattern, date) {
  if (typeof pattern !== "string" || pattern.trim() === "" || pattern.length > MAX_PATTERN_LENGTH) throw invalidInput(`\`pattern\` must be a text of at most ${MAX_PATTERN_LENGTH} characters such as ${DEFAULT_NUMBER_PATTERN}`);
  const pad = (numericValue) => String(numericValue).padStart(2, "0");
  const dateTokens = { "{YYYY}": String(date.getUTCFullYear()), "{YY}": pad(date.getUTCFullYear() % 100), "{MM}": pad(date.getUTCMonth() + 1), "{DD}": pad(date.getUTCDate()), "{ROMAN}": ROMAN_MONTHS[date.getUTCMonth()] };
  let counterName = pattern.trim();
  for (const [token, value] of Object.entries(dateTokens)) counterName = counterName.replaceAll(token, value);
  const sequenceTokens = [...counterName.matchAll(SEQUENCE_TOKEN_PATTERN)];
  if (sequenceTokens.length !== 1) throw invalidInput("`pattern` needs exactly one {SEQ} token (or {SEQ:4} for four digits), e.g. INV-{YYYY}-{SEQ:4}");
  if (!ALLOWED_PATTERN.test(counterName.replace(SEQUENCE_TOKEN_PATTERN, ""))) throw invalidInput("`pattern` may use letters, digits, spaces, . _ - / # and the tokens {YYYY} {YY} {MM} {DD} {ROMAN} {SEQ}");
  const padding = Number(sequenceTokens[0][1] ?? 1);
  return { counterName, format: (sequence) => counterName.replace(SEQUENCE_TOKEN_PATTERN, String(sequence).padStart(padding, "0")) };
}

/**
 * Reads the date a number is issued for.
 *
 * @param rawDate - ISO date (string, optional)
 * @param now - Current local time (Date)
 * @returns The date at UTC midnight (Date)
 * @throws PluginError kind `invalid_input` - When `rawDate` is given but is not an ISO date
 */
export function readNumberDate(rawDate, now) {
  if (rawDate === undefined || rawDate === null || rawDate === "") return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const parsed = parseIsoDate(rawDate);
  if (!parsed) throw invalidInput(`\`date\` must be a date such as 2026-11-27, got ${JSON.stringify(rawDate)}`);
  return parsed;
}

/**
 * Issues (or previews) the next number of a counter.
 *
 * @param outputRoot - Real path of the output directory (string)
 * @param request - `{pattern, date, startAt, isPreview}` (object)
 * @param dependencies - `{fileSystem, now, sleep, platform}` overrides for tests (object, optional)
 * @returns `{number, sequence, counter, reserved}` (object)
 * @throws PluginError kinds `invalid_input` (bad pattern, counter file damaged), `plugin_error` (lock not obtained, I/O failure)
 */
export async function issueNextNumber(outputRoot, { pattern, date, startAt, isPreview }, dependencies = {}) {
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;
  const now = dependencies.now ?? (() => new Date());
  const { counterName, format } = resolveNumberPattern(pattern, date);
  const stateDirectory = join(outputRoot, STATE_DIRECTORY_NAME);
  const statePath = join(stateDirectory, STATE_FILE_NAME);
  if (isPreview) {
    const sequence = nextSequence(await readState(fileSystem, statePath), counterName, startAt);
    return { number: format(sequence), sequence, counter: counterName, reserved: false };
  }
  await fileSystem.mkdir(stateDirectory, { recursive: true });
  const releaseLock = await acquireLock(fileSystem, join(stateDirectory, LOCK_FILE_NAME), now, dependencies.sleep ?? defaultSleep, dependencies.platform ?? process.platform);
  try {
    const state = await readState(fileSystem, statePath);
    const sequence = nextSequence(state, counterName, startAt);
    if (!Object.hasOwn(state.counters, counterName) && Object.keys(state.counters).length >= MAX_COUNTERS) throw invalidInput(`The numbering file already has ${MAX_COUNTERS} counters; remove old ones from ${STATE_DIRECTORY_NAME}/${STATE_FILE_NAME}`);
    state.counters[counterName] = { last: sequence, updated_at: now().toISOString() };
    await writeState(fileSystem, statePath, state);
    return { number: format(sequence), sequence, counter: counterName, reserved: true };
  } finally {
    await releaseLock();
  }
}

function nextSequence(state, counterName, startAt) {
  const last = Object.hasOwn(state.counters, counterName) ? state.counters[counterName].last : startAt - 1;
  if (!Number.isSafeInteger(last) || last < 0 || last >= MAX_SEQUENCE) throw invalidInput(`The counter ${JSON.stringify(counterName)} in ${STATE_DIRECTORY_NAME}/${STATE_FILE_NAME} has an invalid value`);
  return last + 1;
}

async function readState(fileSystem, statePath) {
  const text = await fileSystem.readFile(statePath, "utf8").catch((readError) => {
    if (readError?.code === "ENOENT") return null;
    throw operationFailed(`Could not read the numbering file: ${readError.code ?? readError.message}`);
  });
  if (text === null) return { version: 1, counters: {} };
  try {
    const state = JSON.parse(text);
    if (state?.version !== 1 || typeof state.counters !== "object" || state.counters === null || Array.isArray(state.counters)) throw new Error("unexpected content");
    return { version: 1, counters: { ...state.counters } };
  } catch (parseError) {
    throw invalidInput(`${STATE_DIRECTORY_NAME}/${STATE_FILE_NAME} is damaged (${parseError.message}); repair or remove it, then pass \`start_at\` to continue the numbering`);
  }
}

async function writeState(fileSystem, statePath, state) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  try {
    await fileSystem.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fileSystem.rename(temporaryPath, statePath);
  } catch (writeError) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw operationFailed(`Could not write the numbering file: ${writeError.code ?? writeError.message}`);
  }
}

// The lock is a file created exclusively; one left behind by a crashed process is taken over after 30 s.
// On Windows, creating the lock just after another call removed it can fail with EPERM (the removed file is still
// going away), so that is waited out like a held lock; if it lasts until the deadline it is reported as it is.
async function acquireLock(fileSystem, lockPath, now, sleep, platform) {
  const deadline = now().getTime() + LOCK_WAIT_MS;
  for (;;) {
    let isHeld = true;
    try {
      const lockHandle = await fileSystem.open(lockPath, "wx", 0o600);
      await lockHandle.close();
      return () => fileSystem.rm(lockPath, { force: true }).catch(() => {});
    } catch (lockError) {
      isHeld = lockError?.code === "EEXIST";
      const isBeingRemoved = platform === "win32" && lockError?.code === "EPERM";
      if (!isHeld && (!isBeingRemoved || now().getTime() > deadline)) throw operationFailed(`Could not lock the numbering file: ${lockError.code ?? lockError.message}`);
    }
    const lockStats = isHeld ? await fileSystem.stat(lockPath).catch(() => null) : null;
    if (lockStats && now().getTime() - lockStats.mtimeMs > STALE_LOCK_MS) await fileSystem.rm(lockPath, { force: true }).catch(() => {});
    else if (isHeld && now().getTime() > deadline) throw operationFailed("Another call is issuing a number and did not finish within 5 seconds; try again");
    else await sleep(LOCK_RETRY_MS);
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
