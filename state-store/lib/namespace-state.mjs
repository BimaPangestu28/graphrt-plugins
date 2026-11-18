/**
 * In-memory model of one namespace and its (de)serialisation. Pure functions: no I/O, the clock is passed in.
 *
 * State: `{namespace, updatedAt, seen: Map<id, {seenAt, expiresAt}>, values: Map<key, {value, updatedAt, expiresAt}>}`,
 * where `updatedAt` is the file's last write (epoch ms, null for a new namespace).
 * `seen` keeps insertion order = least recently seen first, which is the order ids are dropped in when the
 * namespace is over MAX_SEEN_IDS_PER_NAMESPACE. On disk both maps are arrays, because JSON object keys that
 * look like integers would be reordered.
 *
 * Both maps record whether they were changed since they were loaded (hasStateChanges), so an update that
 * changes nothing does not rewrite the file.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { MAX_SEEN_IDS_PER_NAMESPACE, SEEN_EXPIRY_REFRESH_MIN_MS } from "./limits.mjs";

export const STATE_FILE_FORMAT = "graphrt-state-store";
export const STATE_FILE_VERSION = 1;

// A Map that remembers whether any entry was set or removed. Only set and delete are used on state maps.
class ChangeTrackingMap extends Map {
  hasChanges = false;

  set(key, value) {
    this.hasChanges = true;
    return super.set(key, value);
  }

  delete(key) {
    const wasDeleted = super.delete(key);
    if (wasDeleted) this.hasChanges = true;
    return wasDeleted;
  }
}

/**
 * @param namespace - Namespace name (string)
 * @returns Empty state (object)
 */
export function createEmptyState(namespace) {
  return { namespace, updatedAt: null, seen: new ChangeTrackingMap(), values: new ChangeTrackingMap() };
}

/**
 * @param state - State (object)
 * @returns Whether any seen id or value was set or removed since the state was created or parsed (boolean)
 */
export function hasStateChanges(state) {
  return state.seen.hasChanges || state.values.hasChanges;
}

/**
 * Parses a state file. Anything unexpected is an error, never an empty state: silently resetting seen ids
 * would make a polling workflow handle every old item again.
 *
 * @param fileText - File content (string)
 * @param namespace - Expected namespace (string)
 * @param filePath - Used in error messages (string)
 * @returns State (object)
 * @throws PluginError kind `state_corrupt` - When the file is not a valid state file
 */
export function parseState(fileText, namespace, filePath) {
  let document;
  try {
    document = JSON.parse(fileText);
  } catch (parseError) {
    throw corruptStateError(filePath, `it is not valid JSON (${parseError.message})`);
  }
  if (document?.format !== STATE_FILE_FORMAT) throw corruptStateError(filePath, `\`format\` is not "${STATE_FILE_FORMAT}"`);
  if (document.version !== STATE_FILE_VERSION) {
    throw corruptStateError(filePath, `it has version ${JSON.stringify(document.version)}; this plugin reads version ${STATE_FILE_VERSION} (upgrade the plugin?)`);
  }
  if (document.namespace !== namespace) throw corruptStateError(filePath, `it belongs to namespace ${JSON.stringify(document.namespace)}`);
  const updatedAt = Date.parse(document.updated_at);
  const state = {
    namespace,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    seen: parseSeenEntries(document.seen, filePath),
    values: parseValueEntries(document.values, filePath),
  };
  state.seen.hasChanges = false;
  state.values.hasChanges = false;
  return state;
}

function parseSeenEntries(seenEntries, filePath) {
  if (!Array.isArray(seenEntries)) throw corruptStateError(filePath, "`seen` is not an array");
  const seen = new ChangeTrackingMap();
  for (const entry of seenEntries) {
    const [id, seenAt, expiresAt] = Array.isArray(entry) ? entry : [];
    if (typeof id !== "string" || !Number.isFinite(seenAt) || !Number.isFinite(expiresAt)) {
      throw corruptStateError(filePath, `a \`seen\` entry is not [id, seen_at, expires_at]: ${JSON.stringify(entry)?.slice(0, 100)}`);
    }
    seen.delete(id);
    seen.set(id, { seenAt, expiresAt });
  }
  return seen;
}

function parseValueEntries(valueEntries, filePath) {
  if (!Array.isArray(valueEntries)) throw corruptStateError(filePath, "`values` is not an array");
  const values = new ChangeTrackingMap();
  for (const entry of valueEntries) {
    const isValid = typeof entry?.key === "string" && "value" in entry && Number.isFinite(entry.updated_at) && (entry.expires_at === null || Number.isFinite(entry.expires_at));
    if (!isValid) throw corruptStateError(filePath, `a \`values\` entry is malformed: ${JSON.stringify(entry)?.slice(0, 100)}`);
    values.set(entry.key, { value: entry.value, updatedAt: entry.updated_at, expiresAt: entry.expires_at });
  }
  return values;
}

/**
 * Serialises a state to file text.
 *
 * @param state - State (object)
 * @param nowMs - Current time, recorded as `updated_at` (number)
 * @returns JSON text (string)
 */
export function serializeState(state, nowMs) {
  return JSON.stringify({
    format: STATE_FILE_FORMAT,
    version: STATE_FILE_VERSION,
    namespace: state.namespace,
    updated_at: new Date(nowMs).toISOString(),
    seen: [...state.seen].map(([id, { seenAt, expiresAt }]) => [id, seenAt, expiresAt]),
    values: [...state.values].map(([key, entry]) => ({ key, value: entry.value, updated_at: entry.updatedAt, expires_at: entry.expiresAt })),
  });
}

/**
 * Removes expired seen ids and values (in place).
 *
 * @param state - State (object)
 * @param nowMs - Current time (number)
 * @returns The same state (object)
 */
export function purgeExpired(state, nowMs) {
  for (const [id, entry] of state.seen) if (entry.expiresAt <= nowMs) state.seen.delete(id);
  for (const [key, entry] of state.values) if (isExpired(entry, nowMs)) state.values.delete(key);
  return state;
}

/**
 * Counts the seen ids that have expired.
 *
 * @param state - State (object)
 * @param nowMs - Current time (number)
 * @returns Number of expired seen ids (number)
 */
export function countExpiredSeenIds(state, nowMs) {
  let expiredCount = 0;
  for (const entry of state.seen.values()) if (entry.expiresAt <= nowMs) expiredCount += 1;
  return expiredCount;
}

/**
 * @param entry - Seen or value entry with `expiresAt` (number | null) (object)
 * @param nowMs - Current time (number)
 * @returns Whether it has expired (boolean)
 */
export function isExpired(entry, nowMs) {
  return entry.expiresAt !== null && entry.expiresAt <= nowMs;
}

/**
 * Splits ids into unseen and seen, without changing the state.
 *
 * @param state - State (object)
 * @param ids - Unique ids (string[])
 * @param nowMs - Current time (number)
 * @returns `{newIds, seenIds}` (object)
 */
export function partitionIds(state, ids, nowMs) {
  const newIds = [];
  const seenIds = [];
  for (const id of ids) {
    const entry = state.seen.get(id);
    (entry && !isExpired(entry, nowMs) ? seenIds : newIds).push(id);
  }
  return { newIds, seenIds };
}

/**
 * Marks ids seen (in place): each one moves to the newest end with a fresh expiry, keeping its first-seen
 * time, then the oldest ids are dropped while the namespace is over the cap. An id whose expiry would move by
 * less than SEEN_EXPIRY_REFRESH_MIN_MS is left as it is (expiry and position), so that re-marking known ids
 * does not rewrite the file on every poll.
 *
 * @param state - State, already purged of expired entries (object)
 * @param ids - Unique ids (string[])
 * @param options.nowMs - Current time (number)
 * @param options.ttlMs - Time to live from now (number)
 * @returns Number of ids dropped to stay under the cap (number)
 */
export function markIdsSeen(state, ids, { nowMs, ttlMs }) {
  for (const id of ids) {
    const existing = state.seen.get(id);
    const expiresAt = nowMs + ttlMs;
    if (existing && !isExpired(existing, nowMs) && Math.abs(expiresAt - existing.expiresAt) < SEEN_EXPIRY_REFRESH_MIN_MS) continue;
    state.seen.delete(id);
    state.seen.set(id, { seenAt: existing?.seenAt ?? nowMs, expiresAt });
  }
  let droppedCount = 0;
  for (const id of state.seen.keys()) {
    if (state.seen.size <= MAX_SEEN_IDS_PER_NAMESPACE) break;
    state.seen.delete(id);
    droppedCount += 1;
  }
  return droppedCount;
}

/**
 * Formats an epoch-ms time for output.
 *
 * @param epochMs - Time (number | null | undefined)
 * @returns ISO 8601 string, or null (string | null)
 */
export function formatTime(epochMs) {
  return epochMs === null || epochMs === undefined ? null : new Date(epochMs).toISOString();
}

function corruptStateError(filePath, reason) {
  return new PluginError(
    `State file ${filePath} is unreadable: ${reason}. Nothing was changed. The plugin never resets a namespace on its own, because forgetting seen ids would reprocess old items: restore the file from a backup, or move it aside to start the namespace empty`,
    { kind: "state_corrupt" },
  );
}
