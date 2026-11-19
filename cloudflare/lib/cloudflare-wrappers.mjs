/**
 * Cloudflare-specific wrappers:
 * - restrictToolDnsNames: DNS writes redirect traffic, so agent tools may only create or update records whose names
 *   are in CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES (on top of CLOUDFLARE_TOOL_ALLOW_WRITE). Updates read the existing record
 *   first, so a tool cannot repoint `www` by naming an allowed record id it does not own.
 * - raiseMinimumLimit: Cloudflare refuses per_page below 5 on some lists; agent tools often ask for 1-3 items. Only
 *   tool calls are raised: a workflow node sends the limit it was configured with (and gets Cloudflare's 400).
 * Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";

/**
 * Checks a DNS name against an allowlist of exact names and `*.suffix` wildcards (one or more labels).
 *
 * @param recordName - Record name, an FQDN such as "api.example.com" (string)
 * @param allowlistText - Comma-separated entries, e.g. "api.example.com, *.preview.example.com" (string, optional)
 * @returns Whether the name is allowed (boolean)
 *
 * @example
 * matchesDnsAllowlist("pr-1.preview.example.com", "*.preview.example.com"); // true
 */
export function matchesDnsAllowlist(recordName, allowlistText) {
  const name = normalizeDnsName(recordName);
  if (!name.includes(".")) return false;
  return String(allowlistText ?? "")
    .split(",")
    .map(normalizeDnsName)
    .filter(Boolean)
    .some((entry) => (entry.startsWith("*.") ? name.endsWith(entry.slice(1)) && name.length > entry.length - 1 : name === entry));
}

function normalizeDnsName(nameText) {
  return String(nameText ?? "").trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Returns the definition with tool calls of create/update DNS operations limited to allowlisted names.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param policy - Policy (object)
 * @param policy.createOperation - Name of the create operation (args.name is checked) (string)
 * @param policy.updateOperation - Name of the update operation (existing record and args.name are checked) (string)
 * @param policy.allowlistEnv - Env with the allowed names (string)
 * @param policy.optInEnv - The write opt-in env; while it is not "1" the layer's own refusal applies (string)
 * @returns A new definition (object)
 */
export function restrictToolDnsNames(pluginDefinition, { createOperation, updateOperation, allowlistEnv, optInEnv }) {
  const wrapOperation = (operation) => {
    if (operation.name !== createOperation && operation.name !== updateOperation) return operation;
    const run = async (context) => {
      const checked = context.source === "tool" && context.environment?.[optInEnv] === "1";
      if (checked) {
        const allowlistText = context.environment?.[allowlistEnv];
        if (operation.name === updateOperation) assertNameAllowed(await readRecordName(context), { allowlistText, allowlistEnv, operationName: operation.name });
        if (context.args.name !== undefined || operation.name === createOperation) assertNameAllowed(context.args.name, { allowlistText, allowlistEnv, operationName: operation.name });
      }
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

async function readRecordName({ client, args, signal }) {
  const path = `/zones/${pathSegment(args.zone_id)}/dns_records/${pathSegment(args.record_id)}`;
  const body = await client.request({ method: "GET", path, signal, redactResponse: true });
  return body?.result?.name;
}

function assertNameAllowed(recordName, { allowlistText, allowlistEnv, operationName }) {
  if (!String(allowlistText ?? "").trim()) {
    throw new PluginError(`\`${operationName}\` as an agent tool needs ${allowlistEnv} (names agents may change); use a workflow node`, { kind: "permission_denied" });
  }
  if (typeof recordName === "string" && matchesDnsAllowlist(recordName, allowlistText)) return;
  throw new PluginError(`\`${operationName}\` as an agent tool may only change DNS names in ${allowlistEnv}; ${recordName ?? "this record"} is not listed`, { kind: "permission_denied" });
}

/**
 * Returns the definition with a tool call's `limit` raised to `minimumLimit` on the given operations.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param policy - `{operationNames: string[], minimumLimit: number}` (object)
 * @returns A new definition (object)
 */
export function raiseMinimumLimit(pluginDefinition, { operationNames, minimumLimit }) {
  const restricted = new Set(operationNames);
  const wrapOperation = (operation) => {
    if (!restricted.has(operation.name)) return operation;
    const run = (context) => {
      const limit = context.args?.limit;
      const raise = context.source === "tool" && typeof limit === "number" && limit < minimumLimit;
      const args = raise ? { ...context.args, limit: minimumLimit } : context.args;
      return operation.run({ ...context, args });
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
