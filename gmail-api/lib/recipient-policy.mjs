/**
 * Recipient checks for mail sends: address validation for every caller, and an optional allowlist for agent tools.
 *
 * The allowlist env holds comma-separated entries: full addresses (`ada@example.com`) or domains (`@example.com`),
 * compared case-insensitively. When it is set, a tool call may only address recipients that match an entry. When it
 * is unset, tool sends are limited only by the operation's opt-in env. Workflow nodes are never limited by it.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

// No whitespace, control characters (C0, DEL), quotes, angle brackets, commas or semicolons: the address is used
// as-is in headers.
const EMAIL_ADDRESS_PATTERN = /^[^\s\x00-\x1f\x7f@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const MAX_ADDRESS_LENGTH = 254;

/**
 * Checks that every value is a plain email address.
 *
 * @param addresses - Addresses (string[])
 * @param fieldName - Parameter name for the message (string)
 * @returns The trimmed addresses (string[])
 * @throws PluginError kind `invalid_input` - A value is not a plain address (display names are not accepted)
 *
 * @example
 * normalizeAddresses([" ada@example.com "], "to"); // ["ada@example.com"]
 */
export function normalizeAddresses(addresses, fieldName) {
  return (addresses ?? []).map((address) => {
    const trimmed = String(address).trim();
    if (trimmed.length > MAX_ADDRESS_LENGTH || !EMAIL_ADDRESS_PATTERN.test(trimmed)) {
      throw new PluginError(`\`${fieldName}\` must hold plain email addresses like ada@example.com; got ${JSON.stringify(String(address).slice(0, 100))}`, { kind: "invalid_input" });
    }
    return trimmed;
  });
}

/**
 * Parses an allowlist env value.
 *
 * @param allowlistText - e.g. "ada@example.com, @example.org" (string, optional)
 * @returns Lower-cased entries; empty when unset (string[])
 */
export function parseRecipientAllowlist(allowlistText) {
  return String(allowlistText ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an address matches an allowlist entry (exact address, or `@domain` for the whole domain).
 *
 * @param address - Email address (string)
 * @param allowlistEntries - From parseRecipientAllowlist (string[])
 * @returns True when allowed (boolean)
 */
export function isRecipientAllowed(address, allowlistEntries) {
  const lowerAddress = address.toLowerCase();
  const domain = lowerAddress.slice(lowerAddress.lastIndexOf("@"));
  return allowlistEntries.some((entry) => (entry.startsWith("@") ? entry === domain : entry === lowerAddress));
}

/**
 * Refuses a tool call that addresses a recipient outside the allowlist (nodes and unset allowlists pass).
 *
 * @param context - Operation context `{source, environment}` (object)
 * @param addresses - Every recipient of the send (string[])
 * @param allowlistEnv - Env var holding the allowlist (string)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - A recipient is not allowed
 */
export function assertRecipientsAllowed({ source, environment }, addresses, allowlistEnv) {
  if (source !== "tool") return;
  const allowlistEntries = parseRecipientAllowlist(environment?.[allowlistEnv]);
  if (allowlistEntries.length === 0) return;
  const refused = addresses.filter((address) => !isRecipientAllowed(address, allowlistEntries));
  if (refused.length === 0) return;
  throw new PluginError(`Agent tools may only send to recipients in ${allowlistEnv}; not allowed: ${refused.join(", ")}`, { kind: "permission_denied" });
}

/**
 * Refuses a tool call whose recipients cannot be checked (e.g. a reply) while an allowlist is set.
 *
 * @param context - Operation context `{source, environment}` (object)
 * @param allowlistEnv - Env var holding the allowlist (string)
 * @param operationName - Operation name for the message (string)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - Tool call while the allowlist is set
 */
export function assertNoAllowlistForUncheckedSend({ source, environment }, allowlistEnv, operationName) {
  if (source !== "tool" || parseRecipientAllowlist(environment?.[allowlistEnv]).length === 0) return;
  throw new PluginError(`\`${operationName}\` cannot check its recipients against ${allowlistEnv}, so agent tools cannot use it while the allowlist is set; use a workflow node`, { kind: "permission_denied" });
}

/**
 * Replaces one operation of a definition with a wrapped version.
 *
 * @param definition - Plugin definition (object)
 * @param operationName - Operation to wrap (string)
 * @param wrap - `(operation) => operation` (function)
 * @returns New definition (object)
 * @throws Error - When the operation does not exist (a typo in the plugin)
 */
export function replaceOperation(definition, operationName, wrap) {
  if (!definition.operations.some((operation) => operation.name === operationName)) throw new Error(`${definition.name}: no operation \`${operationName}\` to wrap`);
  return { ...definition, operations: definition.operations.map((operation) => (operation.name === operationName ? wrap(operation) : operation)) };
}
