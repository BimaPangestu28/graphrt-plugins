/**
 * The computer-control "client": the allowlist, the injectable side-effect
 * dependencies (osascript runner, process runner, clock, sleep, logger) and the
 * helpers every operation uses. There is no HTTP API and no token.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { sleepUnlessCancelled } from "./shared/sleep.mjs";
import { parseAllowedApps, requireAllowedApp } from "./allowlist.mjs";
import { createJxaRunner } from "./jxa-runner.mjs";
import { runProcess } from "./process-runner.mjs";

export const SCREENSHOT_DIR_ENV = "COMPUTER_CONTROL_SCREENSHOT_DIR";
/** Opt-in for get_clipboard: the clipboard can hold anything the user copied from any app (passwords too). */
export const ALLOW_CLIPBOARD_READ_ENV = "COMPUTER_CONTROL_ALLOW_CLIPBOARD_READ";
/** Opt-in for full-screen screenshots, which show every app, not only allowed ones. */
export const ALLOW_FULL_SCREENSHOT_ENV = "COMPUTER_CONTROL_ALLOW_FULL_SCREENSHOT";
const OPT_IN_VALUE = "1";
const SUPPORTED_PLATFORM = "darwin";

/**
 * Builds the default side-effecting dependencies. Tests pass fakes instead.
 *
 * @returns `{platform, runJxa, runCommand, sleep, now, logAction, temporaryDirectory}` (object)
 */
export function createDefaultDependencies() {
  return {
    platform: process.platform,
    runJxa: createJxaRunner(),
    runCommand: runProcess,
    sleep: sleepUnlessCancelled,
    now: () => new Date(),
    logAction: logActionToStderr,
    temporaryDirectory: tmpdir(),
  };
}

/**
 * Creates the per-call client.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - Overrides for createDefaultDependencies() (object)
 * @returns Client with `allowedApps`, the dependencies, `requireApp(name)`, `requireOptIn(envName, action)` and `screenshotDirectory` (object)
 * @throws PluginError kind `invalid_input` - Not macOS; `permission_denied` - COMPUTER_CONTROL_ALLOWED_APPS unset
 */
export function createComputerControlClient(environment, dependencies) {
  if (dependencies.platform !== SUPPORTED_PLATFORM) {
    throw new PluginError(`computer-control is macOS only (this is ${dependencies.platform})`, { kind: "invalid_input" });
  }
  const allowedApps = parseAllowedApps(environment?.COMPUTER_CONTROL_ALLOWED_APPS);
  return {
    ...dependencies,
    allowedApps,
    requireApp: (appName) => requireAllowedApp(appName, allowedApps),
    requireOptIn: (environmentName, actionDescription) => requireOptIn(environment, environmentName, actionDescription),
    screenshotDirectory: environment?.[SCREENSHOT_DIR_ENV]?.trim() || join(dependencies.temporaryDirectory, "graphrt-computer-control"),
  };
}

/**
 * Fails unless an opt-in variable is exactly "1". Used for operations that are not tied to one
 * allowed app (reading the clipboard, capturing the whole screen).
 *
 * @param environment - Environment variables (object)
 * @param environmentName - e.g. ALLOW_CLIPBOARD_READ_ENV (string)
 * @param actionDescription - What the opt-in unlocks, for the message (string)
 * @throws PluginError kind `permission_denied` - When the variable is not "1"
 */
export function requireOptIn(environment, environmentName, actionDescription) {
  if (environment?.[environmentName] === OPT_IN_VALUE) return;
  throw new PluginError(`${actionDescription} is off: set ${environmentName}=1 to allow it`, { kind: "permission_denied" });
}

/**
 * Writes one action line to stderr (stdout carries the plugin protocol).
 * Typed text and clipboard contents are never logged, only their length.
 *
 * @param operationName - Operation being run (string)
 * @param details - Small JSON-serialisable summary (object)
 */
export function logActionToStderr(operationName, details) {
  console.error(`[computer-control] ${new Date().toISOString()} ${operationName} ${JSON.stringify(details)}`);
}
