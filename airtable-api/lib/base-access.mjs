/**
 * Which bases agent tools may touch. When AIRTABLE_BASE_ID is set, a tool call may only address that base and
 * the bases listed in AIRTABLE_TOOL_ALLOWED_BASES (comma-separated; `*` allows any base). Without
 * AIRTABLE_BASE_ID, or for workflow nodes, any base the token can reach is allowed.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const BASE_ID_ENV = "AIRTABLE_BASE_ID";
export const TOOL_ALLOWED_BASES_ENV = "AIRTABLE_TOOL_ALLOWED_BASES";
const BASE_ID_SEGMENT_PATTERN = /^app[A-Za-z0-9]{14}$/i;

/**
 * Refuses a tool call that addresses a base outside the allowed set.
 *
 * @param context - `{environment, source}` of the operation run (object)
 * @param baseId - Base id the call addresses (string)
 * @throws PluginError kind `permission_denied` - Tool call to a base that is not allowed
 *
 * @example
 * assertToolMayUseBase({ source: "tool", environment: { AIRTABLE_BASE_ID: "appA..." } }, "appB..."); // throws
 */
export function assertToolMayUseBase({ environment, source }, baseId) {
  if (source !== "tool" || !environment?.[BASE_ID_ENV]) return;
  const allowedBases = listAllowedBases(environment);
  if (allowedBases.includes("*") || allowedBases.includes(baseId)) return;
  throw new PluginError(
    `Agent tools may only use base ${environment[BASE_ID_ENV]}${allowedBases.length > 1 ? ` and ${allowedBases.slice(1).join(", ")}` : ""}, not ${baseId}; add it to ${TOOL_ALLOWED_BASES_ENV} (comma-separated, or * for any) or use a workflow node`,
    { kind: "permission_denied" },
  );
}

/**
 * Checks every base id in an `api_request` path (e.g. `/appX/Table` or `/meta/bases/appX/tables`) for a tool call.
 * Segments are percent-decoded first, and `.`/`..` segments are refused so a path cannot hop to another base.
 *
 * @param context - `{environment, source}` of the operation run (object)
 * @param requestPath - Path relative to the API base, may include a query string (string)
 * @throws PluginError kind `permission_denied` - The path addresses a base that is not allowed
 * @throws PluginError kind `invalid_input` - Undecodable or dot segments in a restricted tool call
 */
export function assertToolMayUsePath(context, requestPath) {
  if (context.source !== "tool" || !context.environment?.[BASE_ID_ENV]) return;
  const pathOnly = String(requestPath).split(/[?#]/)[0];
  const segments = pathOnly.split("/").map(decodePathSegment);
  segments.filter((segment) => BASE_ID_SEGMENT_PATTERN.test(segment)).forEach((baseId) => assertToolMayUseBase(context, baseId));
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new PluginError("`path` must not contain . or .. segments", { kind: "invalid_input" });
  }
}

function listAllowedBases(environment) {
  const extraBases = String(environment[TOOL_ALLOWED_BASES_ENV] ?? "")
    .split(",")
    .map((baseId) => baseId.trim())
    .filter(Boolean);
  return [environment[BASE_ID_ENV], ...extraBases];
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new PluginError(`\`path\` has an invalid percent-encoding in ${JSON.stringify(segment)}`, { kind: "invalid_input" });
  }
}
