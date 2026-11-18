/**
 * `api_request` for the Calendar API. Tool calls are GET-only (shared policy) and, like every other
 * tool call here, may only reach calendars in GOOGLE_CALENDAR_TOOL_ALLOWED_IDS.
 */
import { createApiRequestOperation } from "../lib/shared/api-request-operation.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { assertCalendarAllowedForTool } from "../lib/tool-policy.mjs";

// Paths that name a calendar: /calendars/{id}/... and /users/me/calendarList/{id}.
const CALENDAR_PATH_PATTERNS = [/^\/calendars\/([^/?#]+)/, /^\/users\/me\/calendarList\/([^/?#]+)/];
// Encoded dots, slashes and backslashes could be normalized by the URL parser into another calendar's path.
const ENCODED_SEPARATOR_PATTERN = /%(2e|2f|5c)/i;

const sharedApiRequestOperation = createApiRequestOperation({ apiName: "Google Calendar API", examplePath: "/colors" });

/**
 * Throws unless a tool call's path stays within the allowed calendars. Node calls always pass.
 *
 * @param context - `{source, environment}` (object)
 * @param path - API path from the arguments (string)
 * @throws PluginError kind `permission_denied` or `invalid_input`
 */
export function assertToolPathAllowed(context, path) {
  if (context.source !== "tool") return;
  if (ENCODED_SEPARATOR_PATTERN.test(path)) {
    throw new PluginError("Agent tools may not use encoded '.', '/' or '\\' in api_request paths", { kind: "invalid_input" });
  }
  for (const calendarPathPattern of CALENDAR_PATH_PATTERNS) {
    const match = calendarPathPattern.exec(path);
    if (match) assertCalendarAllowedForTool(context, decodeCalendarId(match[1]));
  }
}

function decodeCalendarId(encodedCalendarId) {
  try {
    return decodeURIComponent(encodedCalendarId);
  } catch {
    throw new PluginError(`Malformed calendar id in path: ${JSON.stringify(encodedCalendarId)}`, { kind: "invalid_input" });
  }
}

export const apiRequestOperation = {
  ...sharedApiRequestOperation,
  run: async (operationContext) => {
    assertToolPathAllowed(operationContext, operationContext.args.path);
    return sharedApiRequestOperation.run(operationContext);
  },
};
