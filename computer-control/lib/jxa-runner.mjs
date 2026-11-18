/**
 * Runs the static JXA scripts in ../jxa through `osascript -l JavaScript`.
 *
 * The script source is always prelude.js + <script>.js from disk. Arguments travel
 * as JSON on stdin, so user input is never interpolated into script source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { mapOsascriptFailure, mapScriptFailure } from "./osascript-errors.mjs";
import { runProcess } from "./process-runner.mjs";

export const OSASCRIPT_PATH = "/usr/bin/osascript";
export const JXA_SCRIPT_NAMES = Object.freeze([
  "list_apps", "focus_app", "quit_app", "list_windows", "read_ui", "find_elements",
  "click_element", "set_value", "focus_element", "type_text", "press_keys", "click_at",
  "get_clipboard", "set_clipboard", "find_window_id", "read_focused_element",
]);
const JXA_DIRECTORY_URL = new URL("../jxa/", import.meta.url);
const DEFAULT_SCRIPT_TIMEOUT_MS = 30000;
const sourceCache = new Map();

/**
 * Returns the full source (prelude + script) for a known script name.
 *
 * @param scriptName - One of JXA_SCRIPT_NAMES (string)
 * @returns JavaScript for osascript (string)
 * @throws PluginError kind `plugin_error` - Unknown script name
 */
export function loadJxaSource(scriptName) {
  if (!JXA_SCRIPT_NAMES.includes(scriptName)) throw new PluginError(`Unknown JXA script "${scriptName}"`, { kind: "plugin_error" });
  if (!sourceCache.has(scriptName)) {
    const readScript = (fileName) => readFileSync(fileURLToPath(new URL(fileName, JXA_DIRECTORY_URL)), "utf8");
    sourceCache.set(scriptName, `${readScript("prelude.js")}\n${readScript(`${scriptName}.js`)}`);
  }
  return sourceCache.get(scriptName);
}

/**
 * Creates the `runJxa` function used by every operation.
 *
 * @param options - Runner options (object)
 * @param options.runProcessImpl - Process runner, replaced in tests (function, default runProcess)
 * @returns `runJxa(scriptName, input, {signal, timeoutMs}) => Promise<result>` (function)
 *
 * @example
 * const runJxa = createJxaRunner();
 * const apps = await runJxa("list_apps", {});
 */
export function createJxaRunner({ runProcessImpl = runProcess } = {}) {
  return async (scriptName, input, { signal, timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS } = {}) => {
    const source = loadJxaSource(scriptName);
    const processResult = await runProcessImpl(OSASCRIPT_PATH, ["-l", "JavaScript", "-e", source], {
      stdinText: JSON.stringify(input ?? {}),
      signal,
      timeoutMs,
    });
    return parseJxaOutput(processResult);
  };
}

/**
 * Turns osascript's exit code and output into the script result, or throws the mapped error.
 *
 * @param processResult - `{exitCode, stdout, stderr}` (object)
 * @returns The script's `result` value (any)
 * @throws PluginError - Mapped from stderr or the script's structured failure
 */
export function parseJxaOutput({ exitCode, stdout, stderr }) {
  if (exitCode !== 0) throw mapOsascriptFailure(stderr || stdout);
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new PluginError(`osascript returned unreadable output: ${String(stdout).slice(0, 200)}`, { kind: "plugin_error" });
  }
  if (envelope?.ok === true) return envelope.result;
  throw mapScriptFailure(envelope?.error);
}
