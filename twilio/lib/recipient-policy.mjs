/**
 * Recipient checks for messaging sends (SMS, WhatsApp, LINE): phone numbers validated as E.164 for every caller,
 * and a required recipient allowlist for agent tools.
 *
 * A tool send must pass two gates: the operation's opt-in env (`<PLUGIN>_TOOL_ALLOW_SEND=1`, checked by the
 * declarative layer) and the allowlist env, which must be set and match every recipient. An empty or unset
 * allowlist refuses every tool send, so turning on the opt-in alone never lets an agent text arbitrary numbers.
 * Workflow nodes are never limited by the allowlist.
 *
 * Allowlist formats (comma-separated):
 * - phone: full E.164 numbers, matched exactly ("+6281234567890"), or explicit prefixes with a trailing "*"
 *   ("+62812*"). A prefix needs at least 4 digits after "+": "+1*" or "+62*" would let an agent text a whole
 *   country, the classic SMS toll-fraud (pumping) pattern, so such entries are refused.
 * - id: exact ids, e.g. LINE user/group ids "U4af4980629..., C1234..."
 *
 * This file is identical in every messaging plugin of batch B9 (twilio, vonage, fonnte, wablas, line-messaging).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const PHONE_FORMATTING_PATTERN = /[\s\-().]/g;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
const PHONE_PREFIX_PATTERN = /^\+(\d*)\*$/;
const MIN_PREFIX_DIGITS = 4;
const MAX_PREFIX_DIGITS = 14;
const ID_ENTRY_PATTERN = /^[A-Za-z0-9_\-@.:]{1,100}$/;

/**
 * Normalises a phone number to E.164 ("+" and 7-15 digits). The "+" is required: a national number such as
 * "0812..." or bare digits could be read with the wrong country code and reach a stranger.
 *
 * @param rawNumber - Number such as "+62 812-3456-7890" (string)
 * @param argumentName - Parameter name for the message (string)
 * @returns E.164 number, e.g. "+6281234567890" (string)
 * @throws PluginError kind `invalid_input` - No leading "+", or not 7-15 digits
 *
 * @example
 * normalizeE164("+62 812-3456-7890", "to"); // "+6281234567890"
 */
export function normalizeE164(rawNumber, argumentName) {
  const compactNumber = String(rawNumber ?? "").replace(PHONE_FORMATTING_PATTERN, "");
  if (!E164_PATTERN.test(compactNumber)) {
    throw new PluginError(
      `\`${argumentName}\` must be an E.164 number starting with + and the country code (7-15 digits, e.g. "+6281234567890" rather than "081234567890"), got ${JSON.stringify(String(rawNumber ?? "").slice(0, 40))}`,
      { kind: "invalid_input" },
    );
  }
  return compactNumber;
}

/**
 * Parses an allowlist env value.
 *
 * @param allowlistText - Env value (string, optional)
 * @param allowlistEnv - Env name, for the error message (string)
 * @param entryKind - "phone" (exact E.164 numbers or "+digits*" prefixes) or "id" (exact ids) (string)
 * @returns Entries; empty when unset (string[])
 * @throws PluginError kind `invalid_input` - An entry has the wrong format or is a too-broad prefix (a typo must
 *   not widen the list)
 *
 * @example
 * parseAllowlist("+62 812 3456 7890, +1555*", "X", "phone"); // ["+6281234567890", "+1555*"]
 */
export function parseAllowlist(allowlistText, allowlistEnv, entryKind) {
  const entries = String(allowlistText ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.map((entry) => (entryKind === "phone" ? parsePhoneEntry(entry, allowlistEnv) : parseIdEntry(entry, allowlistEnv)));
}

function parsePhoneEntry(entry, allowlistEnv) {
  const normalizedEntry = entry.replace(PHONE_FORMATTING_PATTERN, "");
  if (E164_PATTERN.test(normalizedEntry)) return normalizedEntry;
  const prefixMatch = PHONE_PREFIX_PATTERN.exec(normalizedEntry);
  if (prefixMatch && prefixMatch[1].length < MIN_PREFIX_DIGITS) {
    throw new PluginError(`${allowlistEnv}: prefix ${JSON.stringify(entry.slice(0, 40))} is too broad; a prefix needs at least 4 digits after "+" (e.g. "+62812*"), because a country-wide entry invites SMS toll fraud. List exact numbers where you can`, { kind: "invalid_input" });
  }
  if (prefixMatch && prefixMatch[1].length <= MAX_PREFIX_DIGITS) return normalizedEntry;
  throw new PluginError(`${allowlistEnv} must hold comma-separated E.164 numbers ("+6281234567890", matched exactly) or prefixes with a trailing * ("+62812*"); bad entry ${JSON.stringify(entry.slice(0, 40))}`, { kind: "invalid_input" });
}

function parseIdEntry(entry, allowlistEnv) {
  if (ID_ENTRY_PATTERN.test(entry)) return entry;
  throw new PluginError(`${allowlistEnv} must hold comma-separated plain ids (matched exactly); bad entry ${JSON.stringify(entry.slice(0, 40))}`, { kind: "invalid_input" });
}

/**
 * Whether a recipient matches an allowlist entry: entries ending in "*" by prefix, all others exactly.
 *
 * @param recipient - E.164 number or id (string)
 * @param allowlistEntries - From parseAllowlist (string[])
 * @param entryKind - "phone" or "id" (string)
 * @returns True when allowed (boolean)
 */
export function isRecipientAllowed(recipient, allowlistEntries, entryKind) {
  return allowlistEntries.some((entry) => (entryKind === "phone" && entry.endsWith("*") ? recipient.startsWith(entry.slice(0, -1)) : recipient === entry));
}

/**
 * Refuses a tool send whose recipients are not all in the allowlist. Nodes pass; tool calls without the opt-in
 * pass too, because the operation's own toolPolicy refuses them with the opt-in message.
 *
 * @param context - Operation context `{source, environment}` (object)
 * @param recipients - Every recipient of the send (string[])
 * @param policy - `{optInEnv, allowlistEnv, entryKind}` (object)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - Allowlist unset, or a recipient outside it
 */
export function assertToolRecipientsAllowed({ source, environment }, recipients, policy) {
  if (source !== "tool" || environment?.[policy.optInEnv] !== "1") return;
  const allowlistEntries = parseAllowlist(environment?.[policy.allowlistEnv], policy.allowlistEnv, policy.entryKind);
  if (allowlistEntries.length === 0) {
    throw new PluginError(`Agent tools may only send to recipients listed in ${policy.allowlistEnv}, which is not set; set it or use a workflow node`, { kind: "permission_denied" });
  }
  const refused = recipients.filter((recipient) => !isRecipientAllowed(recipient, allowlistEntries, policy.entryKind));
  if (refused.length === 0) return;
  throw new PluginError(`Agent tools may only send to recipients in ${policy.allowlistEnv}; not allowed: ${refused.join(", ")}`, { kind: "permission_denied" });
}

/**
 * Wraps an operation: arguments are prepared (recipients normalised) and the recipients checked before it runs.
 *
 * @param operation - Operation to wrap (object)
 * @param prepareSend - `(args) => {args, recipients}`; may throw invalid_input (function)
 * @param policy - `{optInEnv, allowlistEnv, entryKind}` (object)
 * @returns Operation with a guarded run (object)
 */
export function guardRecipients(operation, prepareSend, policy) {
  return {
    ...operation,
    run: async (context) => {
      const { args, recipients } = prepareSend(context.args);
      assertToolRecipientsAllowed(context, recipients, policy);
      return operation.run({ ...context, args });
    },
  };
}

/**
 * Replaces operations of a definition with wrapped versions.
 *
 * @param definition - Plugin definition (object)
 * @param wrappers - `{operationName: (operation) => operation}` (object)
 * @returns New definition (object)
 * @throws Error - An operation to wrap does not exist (a typo in the plugin)
 */
export function wrapOperations(definition, wrappers) {
  const knownNames = new Set(definition.operations.map((operation) => operation.name));
  for (const operationName of Object.keys(wrappers)) {
    if (!knownNames.has(operationName)) throw new Error(`${definition.name}: no operation \`${operationName}\` to wrap`);
  }
  return { ...definition, operations: definition.operations.map((operation) => (wrappers[operation.name] ? wrappers[operation.name](operation) : operation)) };
}
