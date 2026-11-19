/**
 * Calendly resource references and agent-tool safety.
 *
 * Calendly identifies resources by URI (`https://api.calendly.com/users/<uuid>`). List filters take the URI
 * (`user=`, `organization=`, `event_type=`) and paths take the uuid. The plugin accepts either form for every
 * reference, and refuses URIs of other hosts or collections, so a value never leaves the API's own resources.
 *
 * Tool safety:
 * - Invitee `cancel_url` and `reschedule_url` let anyone who has them cancel or move the booking. They are
 *   removed from tool results; nodes get them.
 * - `api_request` as a tool may only GET scheduling read paths. Webhook subscriptions (callback URLs), activity
 *   logs, data-compliance, shares and organization invitations are refused.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const CALENDLY_API_ORIGIN = "https://api.calendly.com";
const UUID_PATTERN = /^[A-Za-z0-9_-]+$/;
// Invitee cancel/reschedule links act for the invitee; `password` is the conferencing passcode in `location.data`.
const BEARER_LINK_FIELDS = new Set(["cancel_url", "reschedule_url", "password"]);
const TOOL_READ_PATHS = [
  /^\/users\/[^/]+$/,
  /^\/(event_types|scheduled_events|routing_forms|routing_form_submissions|groups|invitee_no_shows)(\/[^/]+)?$/,
  /^\/scheduled_events\/[^/]+\/invitees(\/[^/]+)?$/,
  /^\/(event_type_available_times|event_type_memberships|user_availability_schedules|user_busy_times|user_meeting_limits|organization_memberships|group_relationships|locations)(\/[^/]+)?$/,
  /^\/organizations\/[^/]+$/,
];

/**
 * Turns a uuid or a resource URI into the resource URI.
 *
 * @param collection - Collection in the URI, e.g. "users" (string)
 * @param reference - A uuid or `https://api.calendly.com/<collection>/<uuid>` (string, optional)
 * @param paramName - Param name for the error message (string)
 * @returns The URI, or undefined when no reference is given (string | undefined)
 * @throws PluginError kind `invalid_input` - Not a uuid or a URI of that collection
 *
 * @example
 * toResourceUri("users", "AAAA", "user"); // "https://api.calendly.com/users/AAAA"
 */
export function toResourceUri(collection, reference, paramName) {
  if (reference === undefined) return undefined;
  const uuid = toResourceUuid(collection, reference, paramName);
  if (!UUID_PATTERN.test(uuid)) throw describeBadReference(collection, paramName);
  return `${CALENDLY_API_ORIGIN}/${collection}/${uuid}`;
}

/**
 * Turns a resource URI into its uuid; any other value is returned trimmed, for a path segment (the declarative
 * layer encodes it as one segment and refuses "." and "..").
 *
 * @param collection - Last collection in the URI, e.g. "scheduled_events" or "invitees" (string)
 * @param reference - A uuid or a URI whose path ends in `/<collection>/<uuid>` (string)
 * @param paramName - Param name for the error message (string)
 * @returns The uuid (string)
 * @throws PluginError kind `invalid_input` - Empty, or an API URI of another collection
 */
export function toResourceUuid(collection, reference, paramName) {
  const value = String(reference ?? "").trim();
  const uuid = value.startsWith(`${CALENDLY_API_ORIGIN}/`) ? readUuidFromUri(collection, value) : value;
  if (!uuid) throw describeBadReference(collection, paramName);
  return uuid;
}

function describeBadReference(collection, paramName) {
  return new PluginError(`\`${paramName}\` must be a Calendly uuid or a ${CALENDLY_API_ORIGIN}/${collection}/<uuid> URI`, { kind: "invalid_input" });
}

function readUuidFromUri(collection, uri) {
  const segments = new URL(uri).pathname.split("/").slice(1);
  const isOwnCollection = segments.length >= 2 && segments.at(-2) === collection && (segments.length === 2 || (collection === "invitees" && segments.length === 4 && segments[0] === "scheduled_events"));
  return isOwnCollection ? segments.at(-1) : undefined;
}

/**
 * Removes invitee cancel and reschedule links and location passwords from a response, at any depth.
 *
 * @param value - Response data (any)
 * @returns A copy without those fields (any)
 */
export function stripBearerLinks(value) {
  if (Array.isArray(value)) return value.map(stripBearerLinks);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([fieldName]) => !BEARER_LINK_FIELDS.has(fieldName)).map(([fieldName, fieldValue]) => [fieldName, stripBearerLinks(fieldValue)]));
}

/**
 * Whether an api_request path is one of the read paths agent tools may call.
 *
 * @param path - api_request `path`, e.g. "/event_types?user=..." (string)
 * @returns True when allowed (boolean)
 */
export function isCalendlyToolReadPath(path) {
  const rawPathname = String(path).split(/[?#]/)[0];
  // An encoded slash or backslash could split one allowed segment into several on Calendly's side.
  if (/%2f|%5c|\\/i.test(rawPathname)) return false;
  const pathname = decodeOrNull(rawPathname)?.toLowerCase();
  if (!pathname || pathname.includes("//") || pathname.includes("%") || /(^|\/)\.\.?(\/|$)/.test(pathname)) return false;
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return TOOL_READ_PATHS.some((pattern) => pattern.test(normalizedPath));
}

function decodeOrNull(text) {
  try {
    return decodeURIComponent(text);
  } catch (decodeError) {
    if (decodeError instanceof URIError) return null;
    throw decodeError;
  }
}

/**
 * Wraps the generated api_request so tool calls may only reach the read allowlist.
 *
 * @param apiRequestOperation - Generated api_request operation (object)
 * @returns Operation with a guarded run (object)
 */
export function restrictApiRequestForTools(apiRequestOperation) {
  return {
    ...apiRequestOperation,
    description: `${apiRequestOperation.description} Agent tools may only read users, event types, scheduled events, invitees, availability and memberships (invitee cancel/reschedule links are removed).`,
    run: (context) => {
      if (context.source === "tool" && !isCalendlyToolReadPath(context.args?.path ?? "")) {
        throw new PluginError("api_request as an agent tool may only GET Calendly scheduling read paths (not webhooks, activity logs, shares or invitations); use a workflow node", { kind: "permission_denied" });
      }
      return apiRequestOperation.run(context);
    },
  };
}
