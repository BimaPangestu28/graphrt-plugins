/**
 * Reads the shell-exec plugin's environment: the executable allowlist, the
 * working-directory allowlist, the tool allowlist and the limits.
 */
import { homedir } from "node:os";
import { basename, isAbsolute, normalize } from "node:path";
import { expandHome, readInteger, readText } from "./environment-readers.mjs";
import { invalidInput } from "./errors.mjs";

export const VARIABLES = {
  commands: "SHELL_EXEC_COMMANDS",
  allowedDirs: "SHELL_EXEC_ALLOWED_DIRS",
  toolRules: "SHELL_EXEC_TOOL_RULES",
  timeoutMs: "SHELL_EXEC_TIMEOUT_MS",
  maxOutputBytes: "SHELL_EXEC_MAX_OUTPUT_BYTES",
};
/** The manifest's per-call limit; a command's own timeout stays below it. */
export const CALL_TIMEOUT_MS = 620000;

function readList(environment, variableName) {
  return (readText(environment, variableName) ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function readCommands(environment) {
  return readList(environment, VARIABLES.commands).map((entry) => {
    if (!isAbsolute(entry) || normalize(entry) !== entry) throw invalidInput(`${VARIABLES.commands} entries must be absolute, normalised executable paths, got ${JSON.stringify(entry)}`);
    return { path: entry, name: basename(entry) };
  });
}

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{commands, allowedDirectories, toolRulesText, maxTimeoutMs, maxOutputBytes, homeDirectory, environment}` (object)
 * @throws PluginError kind `invalid_input` - When a variable is invalid
 */
export function readShellExecSettings(environment = {}) {
  const homeDirectory = environment?.HOME || homedir();
  return {
    commands: readCommands(environment),
    allowedDirectories: readList(environment, VARIABLES.allowedDirs).map((entry) => expandHome(entry, homeDirectory, VARIABLES.allowedDirs)),
    toolRulesText: typeof environment?.[VARIABLES.toolRules] === "string" ? environment[VARIABLES.toolRules].trim() : "",
    maxTimeoutMs: readInteger(environment, VARIABLES.timeoutMs, 30000, { minimum: 100, maximum: CALL_TIMEOUT_MS - 20000 }),
    maxOutputBytes: readInteger(environment, VARIABLES.maxOutputBytes, 1024 * 1024, { minimum: 1024, maximum: 64 * 1024 * 1024 }),
    homeDirectory,
    environment,
  };
}
