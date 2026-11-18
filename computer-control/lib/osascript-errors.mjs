/**
 * Maps osascript / JXA / screencapture failures to PluginError kinds, with the
 * System Settings pane to fix permission problems.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const ACCESSIBILITY_HINT =
  "macOS Accessibility permission is missing. Open System Settings → Privacy & Security → Accessibility and enable the app that runs graphrt (e.g. Terminal), then retry.";
export const AUTOMATION_HINT =
  "macOS Automation permission is missing. Open System Settings → Privacy & Security → Automation and allow the app that runs graphrt to control \"System Events\", then retry.";
export const SCREEN_RECORDING_HINT =
  "macOS Screen Recording permission is missing. Open System Settings → Privacy & Security → Screen & System Audio Recording and enable the app that runs graphrt, then retry.";

// Matched on the message text, not bare codes: -1719 is also AppleScript's "invalid index".
// -25211 is kAXErrorAPIDisabled; "not allowed to send keystrokes" comes with error 1002.
const ACCESSIBILITY_PATTERN = /not allowed assistive access|-25211\b|kAXErrorAPIDisabled|not allowed to send keystrokes/i;
// -1743: errAEEventNotPermitted (Automation / Apple Events consent).
const AUTOMATION_PATTERN = /-1743\b|not authori[sz]ed to send apple events/i;
const APP_NOT_FOUND_PATTERN = /application can.t be found|unable to find application|-10814\b/i;
const SCREEN_CAPTURE_DENIED_PATTERN = /could not create image|screen ?recording|not authori[sz]ed to capture/i;
const MAX_DETAIL_LENGTH = 300;

/**
 * Maps the text of an osascript failure (stderr, or a caught JXA error message).
 *
 * @param failureText - stderr or error message (string)
 * @returns Error to throw (PluginError)
 */
export function mapOsascriptFailure(failureText) {
  const detail = summarize(failureText);
  if (AUTOMATION_PATTERN.test(detail)) return new PluginError(AUTOMATION_HINT, { kind: "permission_denied" });
  if (ACCESSIBILITY_PATTERN.test(detail)) return new PluginError(ACCESSIBILITY_HINT, { kind: "permission_denied" });
  if (APP_NOT_FOUND_PATTERN.test(detail)) return new PluginError(`App not found: ${detail}`, { kind: "not_found" });
  return new PluginError(`osascript failed: ${detail || "no error output"}`, { kind: "plugin_error" });
}

/**
 * Maps a structured failure returned by a JXA script (see jxa/prelude.js).
 *
 * @param scriptFailure - `{kind, message, number?}` (object)
 * @returns Error to throw (PluginError)
 */
export function mapScriptFailure(scriptFailure) {
  const message = summarize(scriptFailure?.message);
  switch (scriptFailure?.kind) {
    case "accessibility_denied":
      return new PluginError(ACCESSIBILITY_HINT, { kind: "permission_denied" });
    case "permission_denied":
      return new PluginError(message, { kind: "permission_denied" });
    case "not_found":
    case "stale_ref":
      return new PluginError(message, { kind: "not_found" });
    case "invalid_input":
      return new PluginError(message, { kind: "invalid_input" });
    case "action_failed":
      return new PluginError(message, { kind: "plugin_error" });
    default:
      return mapOsascriptFailure(`${message}${scriptFailure?.number !== undefined ? ` (${scriptFailure.number})` : ""}`);
  }
}

/**
 * Maps a failed `screencapture` run.
 *
 * @param stderrText - screencapture stderr (string)
 * @returns Error to throw (PluginError)
 */
export function mapScreenCaptureFailure(stderrText) {
  const detail = summarize(stderrText);
  if (!detail || SCREEN_CAPTURE_DENIED_PATTERN.test(detail)) {
    return new PluginError(`${SCREEN_RECORDING_HINT}${detail ? ` (screencapture: ${detail})` : ""}`, { kind: "permission_denied" });
  }
  return new PluginError(`screencapture failed: ${detail}`, { kind: "plugin_error" });
}

function summarize(text) {
  const singleLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_DETAIL_LENGTH ? `${singleLine.slice(0, MAX_DETAIL_LENGTH)}…` : singleLine;
}
