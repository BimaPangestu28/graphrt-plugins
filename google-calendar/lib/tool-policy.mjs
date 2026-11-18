/**
 * Limits on what an agent (a tool call, `source: "tool"`) may do. Workflow nodes have none of them.
 *
 * - Calendars: only ids listed in GOOGLE_CALENDAR_TOOL_ALLOWED_IDS (comma-separated, default
 *   "primary"; "*" allows every calendar the credentials can reach). Compared case-insensitively.
 * - Guest emails: `sendUpdates` is forced to "none" unless GOOGLE_CALENDAR_TOOL_SEND_UPDATES=1.
 * - Changing or deleting: only events this plugin created, which carry the private extended
 *   property graphrt_created=1.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const TOOL_ALLOWED_IDS_ENV = "GOOGLE_CALENDAR_TOOL_ALLOWED_IDS";
export const TOOL_SEND_UPDATES_ENV = "GOOGLE_CALENDAR_TOOL_SEND_UPDATES";
export const PLUGIN_CREATED_PROPERTY = "graphrt_created";
export const PLUGIN_CREATED_VALUE = "1";
const DEFAULT_ALLOWED_IDS = "primary";
const ENABLED_VALUES = new Set(["1", "true", "yes"]);

/**
 * Throws unless a tool call may use this calendar. Node calls always pass.
 *
 * @param context - `{source, environment}` from the operation (object)
 * @param calendarId - Calendar the call acts on (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertCalendarAllowedForTool({ source, environment }, calendarId) {
  if (source !== "tool") return;
  const toolCalendarAccess = readToolCalendarAccess(environment);
  if (toolCalendarAccess.isAllowed(calendarId)) return;
  throw new PluginError(
    `Agent tools may not use calendar ${JSON.stringify(calendarId)}: allowed are ${[...toolCalendarAccess.allowedIds].join(", ")}. ` +
      `Add it to ${TOOL_ALLOWED_IDS_ENV} (comma-separated) or use a workflow node`,
    { kind: "permission_denied" },
  );
}

/**
 * Reads the calendars agent tools may use.
 *
 * @param environment - Plugin environment (object)
 * @returns `{allowedIds: Set<string>, isAllowed: (calendarId) => boolean}` (object)
 */
export function readToolCalendarAccess(environment) {
  const allowedIds = readAllowedCalendarIds(environment);
  const isAllowed = (calendarId) => allowedIds.has("*") || allowedIds.has(String(calendarId ?? "").trim().toLowerCase());
  return { allowedIds, isAllowed };
}

function readAllowedCalendarIds(environment) {
  const configuredIds = environment?.[TOOL_ALLOWED_IDS_ENV]?.trim() || DEFAULT_ALLOWED_IDS;
  return new Set(
    configuredIds
      .split(",")
      .map((calendarId) => calendarId.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Picks the `sendUpdates` value to send: tool calls get "none" unless guest emails are enabled.
 *
 * @param context - `{source, environment}` (object)
 * @param requestedSendUpdates - "all", "externalOnly" or "none" (string)
 * @returns `{sendUpdates, wasSuppressed}` (object)
 */
export function resolveSendUpdates({ source, environment }, requestedSendUpdates) {
  const mayNotifyGuests = source !== "tool" || ENABLED_VALUES.has(String(environment?.[TOOL_SEND_UPDATES_ENV] ?? "").trim().toLowerCase());
  if (mayNotifyGuests || requestedSendUpdates === "none") return { sendUpdates: requestedSendUpdates, wasSuppressed: false };
  return { sendUpdates: "none", wasSuppressed: true };
}

/**
 * Whether an event carries this plugin's private "created" tag.
 *
 * @param event - Calendar Event resource (object)
 * @returns true when tagged (boolean)
 */
export function isCreatedByPlugin(event) {
  return event?.extendedProperties?.private?.[PLUGIN_CREATED_PROPERTY] === PLUGIN_CREATED_VALUE;
}

/**
 * Throws unless a tool call may change this event (one the plugin created). Node calls always pass.
 *
 * @param context - `{source}` (object)
 * @param event - The current Event resource (object)
 * @param actionName - "update" or "delete", for the message (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolMayChangeEvent({ source }, event, actionName) {
  if (source !== "tool" || isCreatedByPlugin(event)) return;
  throw new PluginError(
    `Agent tools may only ${actionName} events created by this plugin (tagged ${PLUGIN_CREATED_PROPERTY}=1); ` + "use a workflow node for other events",
    { kind: "permission_denied" },
  );
}

/**
 * Describes the notification choice for an operation's output.
 *
 * @param sendUpdatesChoice - Result of resolveSendUpdates (object)
 * @returns `{send_updates, notifications_suppressed?}` (object)
 */
export function describeSendUpdates({ sendUpdates, wasSuppressed }) {
  if (!wasSuppressed) return { send_updates: sendUpdates };
  return { send_updates: sendUpdates, notifications_suppressed: `guest emails are off for agent tools; set ${TOOL_SEND_UPDATES_ENV}=1 to allow them` };
}
