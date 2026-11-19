/**
 * Small validated readers for environment variables, plus the agent write policy.
 * This file is identical in the postgres, mysql and sqlite plugins; keep the copies in step.
 */
import { invalidInput, permissionDenied } from "./errors.mjs";

/**
 * Reads a trimmed text variable.
 *
 * @param environment - Environment variables (object)
 * @param variableName - Variable to read (string)
 * @returns The trimmed value, or null when unset or blank (string | null)
 * @throws PluginError kind `invalid_input` - When the value contains a line break or NUL
 */
export function readText(environment, variableName) {
  const rawValue = environment?.[variableName];
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
  if (/[\r\n\0]/.test(trimmed)) throw invalidInput(`${variableName} must not contain line breaks`);
  return trimmed || null;
}

/**
 * Reads an integer variable within bounds.
 *
 * @param environment - Environment variables (object)
 * @param variableName - Variable to read (string)
 * @param defaultValue - Value when unset (number)
 * @param bounds - `{minimum, maximum}` (object)
 * @returns The integer (number)
 * @throws PluginError kind `invalid_input` - When the value is not an integer within bounds
 */
export function readInteger(environment, variableName, defaultValue, { minimum, maximum }) {
  const rawValue = readText(environment, variableName);
  if (rawValue === null) return defaultValue;
  const numericValue = Number(rawValue);
  if (!Number.isInteger(numericValue) || numericValue < minimum || numericValue > maximum) {
    throw invalidInput(`${variableName} must be an integer from ${minimum} to ${maximum}, got ${JSON.stringify(rawValue)}`);
  }
  return numericValue;
}

/**
 * Reads an opt-in flag: only the exact value "1" turns it on.
 *
 * @param environment - Environment variables (object)
 * @param variableName - Variable to read (string)
 * @returns True when the variable is "1" (boolean)
 */
export function readOptInFlag(environment, variableName) {
  return readText(environment, variableName) === "1";
}

/**
 * Allows a write only from a workflow node, or from anything when the plugin's opt-in variable is "1".
 * A call without a known source fails closed.
 *
 * @param options - Policy inputs (object)
 * @param options.source - "node" or "tool" (string)
 * @param options.environment - Environment variables (object)
 * @param options.optInVariable - e.g. "POSTGRES_TOOL_ALLOW_WRITES" (string)
 * @param options.operationName - Operation being refused, for the message (string)
 * @throws PluginError kind `permission_denied` - For tool calls (or calls without a source) without the opt-in
 */
export function assertToolWriteAllowed({ source, environment, optInVariable, operationName }) {
  if (source === "node" || readOptInFlag(environment, optInVariable)) return;
  throw permissionDenied(
    `\`${operationName}\` can change the database, so agents may not call it. Use a workflow node, or set ${optInVariable}=1 to allow it for agents.`,
  );
}
