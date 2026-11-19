/**
 * Stateless cursors: a snapshot (root, options and per-entry type, size and
 * mtime) compressed with raw deflate and base64url-encoded behind "fw1.".
 * The plugin keeps nothing between calls, so a cursor survives restarts and
 * can be stored by a workflow.
 *
 * A cursor comes back from the caller, so it is untrusted: decompression is
 * capped (no zip bombs), the shape is checked, and its root is checked against
 * the allowlist again by the caller of decodeCursor.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { invalidInput } from "./errors.mjs";

const CURSOR_PREFIX = "fw1.";
const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Encodes a snapshot as a cursor.
 *
 * @param snapshot - `{root, options, takenAt, truncated, entries: [[relativePath, type, size, mtimeMs]]}` (object)
 * @returns Cursor text (string)
 */
export function encodeCursor(snapshot) {
  return `${CURSOR_PREFIX}${deflateRawSync(Buffer.from(JSON.stringify(snapshot))).toString("base64url")}`;
}

/**
 * Decodes and checks a cursor.
 *
 * @param cursor - Cursor text from snapshot, list_changes or wait_for_change (string)
 * @param options - `{maxBytes}` cap on the decompressed size (object, optional)
 * @returns The snapshot (object)
 * @throws PluginError kind `invalid_input` - When the cursor is malformed or too large
 */
export function decodeCursor(cursor, { maxBytes = DEFAULT_MAX_DECODED_BYTES } = {}) {
  const body = typeof cursor === "string" && cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : null;
  if (!body || !BASE64URL_PATTERN.test(body)) throw invalidInput("`cursor` is not a file-watcher cursor (it starts with fw1.)");
  let snapshot;
  try {
    snapshot = JSON.parse(inflateRawSync(Buffer.from(body, "base64url"), { maxOutputLength: maxBytes }).toString("utf8"));
  } catch (decodeError) {
    throw invalidInput(`\`cursor\` could not be decoded (${decodeError.code === "ERR_BUFFER_TOO_LARGE" ? "too large" : "damaged"})`);
  }
  assertSnapshotShape(snapshot);
  return snapshot;
}

function assertSnapshotShape(snapshot) {
  const isValid = typeof snapshot?.root === "string"
    && typeof snapshot.options === "object" && snapshot.options !== null
    && Number.isInteger(snapshot.options.maxDepth)
    && Array.isArray(snapshot.entries)
    && snapshot.entries.every((entry) => Array.isArray(entry) && entry.length === 4 && typeof entry[0] === "string" && typeof entry[1] === "string" && typeof entry[2] === "number" && typeof entry[3] === "number");
  if (!isValid) throw invalidInput("`cursor` is damaged (unexpected content)");
}
