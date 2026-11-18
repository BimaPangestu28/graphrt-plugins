/**
 * Limits and validators shared by the state-store operations.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const MAX_SEEN_IDS_PER_NAMESPACE = 100000;
export const MAX_IDS_PER_CALL = 10000;
// Measured in UTF-8 bytes as stored (JSON-escaped). A stored seen entry is the id plus ~35 bytes of quotes,
// timestamps and brackets, so 100k ids take at most ~29 MB: the id cap is always reached before MAX_FILE_BYTES.
export const MAX_ID_BYTES = 256;
export const MAX_KEY_LENGTH = 512;
export const MAX_VALUE_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_TTL_DAYS = 90;
export const MAX_TTL_DAYS = 3650;
export const MAX_TTL_SECONDS = MAX_TTL_DAYS * 86400;
export const DAY_MS = 86400000;
// Re-marking an id moves its expiry only when that moves it by at least this much: otherwise a poll that
// sees only known ids would rewrite the whole file on every run.
export const SEEN_EXPIRY_REFRESH_MIN_MS = 3600000;
// A write this long after the file's last write that would purge more than this share of the seen ids looks
// like a clock that jumped forward: the purge is skipped (see purgeExpiredUnlessClockJumped in client.mjs).
export const CLOCK_JUMP_SUSPECT_AFTER_MS = 30 * DAY_MS;
export const CLOCK_JUMP_SUSPECT_PURGE_SHARE = 0.5;

/**
 * Checks a namespace name. It becomes a file name; the pattern has no "/", so it cannot leave the store directory.
 *
 * @param namespace - Namespace name (string)
 * @returns The namespace (string)
 * @throws PluginError kind `invalid_input` - When it does not match NAMESPACE_PATTERN
 */
export function requireNamespace(namespace) {
  if (typeof namespace === "string" && NAMESPACE_PATTERN.test(namespace)) return namespace;
  throw new PluginError(
    `\`namespace\` ${JSON.stringify(namespace)} is invalid: use 1-64 characters a-z, 0-9, "_", "." or "-", starting with a letter or digit`,
    { kind: "invalid_input" },
  );
}

/**
 * Normalises a list of ids: numbers become strings, duplicates are dropped (first occurrence wins).
 *
 * @param ids - Ids from the caller (Array<string | number>)
 * @returns Unique ids in input order (string[])
 * @throws PluginError kind `invalid_input` - When an id is empty, over MAX_ID_BYTES, not a string/integer, or there are too many
 */
export function normalizeIds(ids) {
  if (!Array.isArray(ids)) throw new PluginError("`ids` must be an array of strings", { kind: "invalid_input" });
  if (ids.length > MAX_IDS_PER_CALL) throw new PluginError(`\`ids\` may hold at most ${MAX_IDS_PER_CALL} ids per call`, { kind: "invalid_input" });
  return [...new Set(ids.map((id, index) => normalizeId(id, `ids[${index}]`)))];
}

/**
 * Normalises one id (see normalizeIds).
 *
 * @param id - Id (string | number)
 * @param argumentName - Name used in error messages (string)
 * @returns The id as a string (string)
 * @throws PluginError kind `invalid_input`
 */
export function normalizeId(id, argumentName = "id") {
  const isExactNumber = typeof id === "number" && Number.isSafeInteger(id);
  if (typeof id !== "string" && !isExactNumber) {
    throw new PluginError(`\`${argumentName}\` must be a string (or a safe integer)`, { kind: "invalid_input" });
  }
  const normalized = String(id);
  if (normalized.length === 0 || measureStoredBytes(normalized) > MAX_ID_BYTES) {
    throw new PluginError(`\`${argumentName}\` must be 1-${MAX_ID_BYTES} bytes as UTF-8 (JSON-escaped); hash longer ids first`, { kind: "invalid_input" });
  }
  return normalized;
}

// Bytes the id takes inside the JSON file, without its quotes.
function measureStoredBytes(text) {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/**
 * Checks a key name.
 *
 * @param key - Key (string)
 * @returns The key (string)
 * @throws PluginError kind `invalid_input` - When it is empty or longer than MAX_KEY_LENGTH
 */
export function requireKey(key) {
  if (typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH) return key;
  throw new PluginError(`\`key\` must be a string of 1-${MAX_KEY_LENGTH} characters`, { kind: "invalid_input" });
}

/**
 * Checks that a value is JSON and at most MAX_VALUE_BYTES once serialised.
 *
 * @param value - Any JSON value (unknown)
 * @returns The value (unknown)
 * @throws PluginError kind `invalid_input` - When it is too large or not JSON-serialisable
 */
export function requireStorableValue(value) {
  const serialized = value === undefined ? undefined : JSON.stringify(value);
  if (serialized === undefined) throw new PluginError("`value` must be a JSON value", { kind: "invalid_input" });
  const valueBytes = Buffer.byteLength(serialized);
  if (valueBytes > MAX_VALUE_BYTES) {
    throw new PluginError(`\`value\` is ${valueBytes} bytes as JSON; the limit is ${MAX_VALUE_BYTES} (1 MB)`, { kind: "invalid_input" });
  }
  return value;
}
