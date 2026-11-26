/**
 * Cursors of the watch operations: small versioned JSON objects in base64url, so a host can store and resend them.
 * Every field is checked on the way back in; a damaged cursor starts over.
 */
import { invalidInput } from "./errors.mjs";

const PREFIX = "mn1.";

/**
 * @param state - JSON-serialisable state (object)
 * @returns Cursor text (string)
 */
export function encodeCursor(state) {
  return PREFIX + Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

/**
 * @param cursor - Cursor text (string)
 * @param check - `(state) => boolean` that accepts a well-formed state (function)
 * @returns The state (object)
 * @throws PluginError kind `invalid_input` - When the cursor is not one of this plugin's
 */
export function decodeCursor(cursor, check) {
  if (typeof cursor !== "string" || !cursor.startsWith(PREFIX) || cursor.length > 2048) throw invalidInput("`cursor` is not a meeting-notes cursor");
  let state;
  try {
    state = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw invalidInput("`cursor` is damaged");
  }
  if (!state || typeof state !== "object" || !check(state)) throw invalidInput("`cursor` is damaged");
  return state;
}

const isTime = (value) => value === null || (Number.isFinite(value) && value >= 0);

/** Whether `state` is a wait_for_meeting state. */
export const isMeetingWatchState = (state) => typeof state.fired === "boolean" && isTime(state.pending_since) && isTime(state.last_in_use);

/** Whether `state` is a wait_for_recording_end state. */
export const isRecordingWatchState = (state) => typeof state.since === "string" && !Number.isNaN(Date.parse(state.since));
