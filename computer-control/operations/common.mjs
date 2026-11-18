/**
 * Parameter schemas and limits shared by the computer-control operations.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";

export const APP_PROPERTY = {
  type: "string",
  description: "App name or bundle id as shown by list_apps, e.g. \"Finder\" or \"net.whatsapp.WhatsApp\" (must be in COMPUTER_CONTROL_ALLOWED_APPS)",
};
export const WINDOW_PROPERTY = { type: "integer", minimum: 1, maximum: 50, default: 1, description: "1-based window index from list_windows (1 = frontmost)" };
export const REF_PROPERTY = {
  type: "string",
  description: "Element ref exactly as read_ui or find_elements returned it, e.g. \"w1/3/2#0a1b2c3\" (the #fingerprint makes a changed UI fail instead of acting on another element)",
};
export const ROOT_REF_PROPERTY = { type: "string", description: "Read only the sub-tree under this ref (e.g. \"w1/3#0a1b2c3\") instead of the whole window" };

/** Timeout for scripts that walk the Accessibility tree. */
export const TREE_SCRIPT_TIMEOUT_MS = 60000;
/** Hard cap on elements a tree walk inspects, whatever the filters. */
export const MAX_VISITED_ELEMENTS = 5000;
/** Longest text accepted by type_text, set_value and set_clipboard. */
export const MAX_TEXT_INPUT_LENGTH = 10000;
/** Longest text type_text sends key by key: long keystroke runs hold the keyboard for a long time. */
export const MAX_KEYSTROKE_TEXT_LENGTH = 1000;

/**
 * Normalises line endings to "\n" (Windows "\r\n" and old Mac "\r").
 *
 * @param text - Text to type or set (string)
 * @returns Text with "\n" line endings (string)
 */
export function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Rejects text longer than MAX_TEXT_INPUT_LENGTH.
 *
 * @param parameterName - Argument name for the error message (string)
 * @param text - Text to check (string)
 * @returns The same text (string)
 * @throws PluginError kind `invalid_input`
 */
export function requireTextWithinLimit(parameterName, text) {
  if (text.length > MAX_TEXT_INPUT_LENGTH) {
    throw new PluginError(`\`${parameterName}\` is longer than ${MAX_TEXT_INPUT_LENGTH} characters`, { kind: "invalid_input" });
  }
  return text;
}
