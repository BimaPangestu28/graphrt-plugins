/**
 * calendly plugin definition: the Calendly API v2 (https://developer.calendly.com/api-docs) for the current user,
 * event types and their available times, scheduled events and invitees, availability schedules and busy times,
 * single-use scheduling links, booking and cancelling. Built with the declarative REST layer
 * (docs/declarative-plugins.md). Every user, organization, event type, event and invitee reference may be a uuid
 * or its API URI (lib/calendly-resources.mjs).
 *
 * Agent policy: cancelling an event (Calendly emails the invitees) is node only; scheduling links and bookings
 * (calendar invitations to the invitee and guests) need CALENDLY_TOOL_ALLOW_SCHEDULING_LINK=1 / CALENDLY_TOOL_ALLOW_BOOKING=1
 * as tools; tool results never contain invitee cancel/reschedule links; api_request as a tool only reads an
 * allowlist of scheduling paths.
 */
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./lib/shared/rest-response.mjs";
import { restrictApiRequestForTools, stripBearerLinks, toResourceUri, toResourceUuid } from "./lib/calendly-resources.mjs";

const calendlyPage = { dataPath: "collection", cursorPath: "pagination.next_page_token", cursorParam: "page_token", limitParam: "count", maxLimit: 100, defaultLimit: 20 };
const reference = (location, label, required = false) => ({ in: location, type: "string", ...(required ? { required: true } : {}), description: `${label}: uuid or https://api.calendly.com/... URI` });
const TIME = (label) => ({ in: "query", type: "string", required: true, description: `${label}, ISO 8601 UTC, e.g. 2026-12-01T00:00:00Z` });
const RESOURCE = { dataPath: "resource" };

const userOperations = [
  { name: "get_me", title: "Current user", description: "The token's user; data.uri and data.current_organization feed the user/organization filters", path: "/users/me", response: RESOURCE },
  { name: "get_user", title: "Get user", description: "One user", path: "/users/{user_uuid}", params: { user_uuid: reference("path", "User", true) }, response: RESOURCE },
  {
    name: "list_organization_memberships",
    title: "Organization members",
    description: "Members of an organization (or the memberships of one user)",
    path: "/organization_memberships",
    params: { organization: reference("query", "Organization"), user: reference("query", "User"), email: { in: "query", type: "string" }, role: { in: "query", type: "string", enum: ["owner", "admin", "user"] } },
    response: calendlyPage,
  },
];

const eventTypeOperations = [
  {
    name: "list_event_types",
    title: "List event types",
    description: "Event types of a user or organization (set one of them)",
    path: "/event_types",
    params: { user: reference("query", "User"), organization: reference("query", "Organization"), active: { in: "query", type: "boolean" }, sort: { in: "query", type: "string", description: "e.g. name:asc (default), position:asc, created_at:desc" } },
    response: calendlyPage,
  },
  { name: "get_event_type", title: "Get event type", description: "One event type with its scheduling_url, duration and questions", path: "/event_types/{event_type_uuid}", params: { event_type_uuid: reference("path", "Event type", true) }, response: RESOURCE },
  {
    name: "list_available_times",
    title: "Available times",
    description: "Open start times of an event type in a range of at most 7 days",
    path: "/event_type_available_times",
    params: { event_type: reference("query", "Event type", true), start_time: TIME("Range start (in the future)"), end_time: TIME("Range end (at most 7 days after start)") },
    response: { dataPath: "collection" },
  },
];

const scheduledEventOperations = [
  {
    name: "list_scheduled_events",
    title: "List scheduled events",
    description: "Booked events of a user or organization (set one of them), filtered by time, status or invitee email",
    path: "/scheduled_events",
    params: {
      user: reference("query", "User"),
      organization: reference("query", "Organization"),
      group: reference("query", "Group"),
      invitee_email: { in: "query", type: "string" },
      status: { in: "query", type: "string", enum: ["active", "canceled"] },
      min_start_time: { in: "query", type: "string", description: "Start at or after, ISO 8601 UTC" },
      max_start_time: { in: "query", type: "string", description: "Start before, ISO 8601 UTC" },
      sort: { in: "query", type: "string", description: "start_time:asc or start_time:desc" },
    },
    response: calendlyPage,
  },
  { name: "get_scheduled_event", title: "Get scheduled event", description: "One booked event with its location and invitee counts", path: "/scheduled_events/{event_uuid}", params: { event_uuid: reference("path", "Scheduled event", true) }, response: RESOURCE },
  {
    name: "list_invitees",
    title: "List invitees",
    description: "Invitees of a scheduled event with their answers",
    path: "/scheduled_events/{event_uuid}/invitees",
    params: { event_uuid: reference("path", "Scheduled event", true), status: { in: "query", type: "string", enum: ["active", "canceled"] }, email: { in: "query", type: "string" }, sort: { in: "query", type: "string", description: "created_at:asc (default) or created_at:desc" } },
    response: calendlyPage,
  },
  {
    name: "get_invitee",
    title: "Get invitee",
    description: "One invitee of a scheduled event",
    path: "/scheduled_events/{event_uuid}/invitees/{invitee_uuid}",
    params: { event_uuid: reference("path", "Scheduled event", true), invitee_uuid: reference("path", "Invitee", true) },
    response: RESOURCE,
  },
];

const availabilityOperations = [
  { name: "list_availability_schedules", title: "Availability schedules", description: "A user's availability schedules (working hours rules)", path: "/user_availability_schedules", params: { user: reference("query", "User", true) }, response: { dataPath: "collection" } },
  {
    name: "list_busy_times",
    title: "Busy times",
    description: "A user's busy intervals (Calendly events and connected calendars) in a range of at most 7 days",
    path: "/user_busy_times",
    params: { user: reference("query", "User", true), start_time: TIME("Range start"), end_time: TIME("Range end (at most 7 days after start)") },
    response: { dataPath: "collection" },
  },
];

const writeOperations = [
  {
    name: "create_scheduling_link",
    title: "Create single-use link",
    description: "Create a booking link for one event of an event type (data.booking_url)",
    method: "POST",
    path: "/scheduling_links",
    write: "unsafe",
    toolPolicy: "optIn:CALENDLY_TOOL_ALLOW_SCHEDULING_LINK",
    checkHint: "nothing lists single-use links; an extra unused link is harmless",
    params: { event_type: { ...reference("body", "Event type", true), wireName: "owner" } },
    constants: { body: { max_event_count: 1, owner_type: "EventType" } },
    response: RESOURCE,
  },
  {
    name: "book_meeting",
    title: "Book meeting",
    description: "Book an invitee into an open time of an event type (Calendly sends the usual confirmations and calendar invitations; paid plans)",
    method: "POST",
    path: "/invitees",
    write: "unsafe",
    toolPolicy: "optIn:CALENDLY_TOOL_ALLOW_BOOKING",
    checkHint: "list_scheduled_events with invitee_email and min_start_time",
    params: {
      event_type: reference("body", "Event type", true),
      start_time: { in: "body", type: "string", required: true, description: "One of list_available_times' start_time values, ISO 8601 UTC" },
      invitee_email: { in: "body", type: "string", required: true, wireName: "invitee.email" },
      invitee_timezone: { in: "body", type: "string", required: true, wireName: "invitee.timezone", description: "IANA time zone, e.g. Asia/Jakarta" },
      invitee_name: { in: "body", type: "string", wireName: "invitee.name" },
      location: { in: "body", type: "object", description: 'Location choice of the event type, e.g. {"kind":"zoom_conference"}' },
      questions_and_answers: { in: "body", type: "array", items: { type: "object" }, description: 'e.g. [{"question":"Topic","answer":"Pricing","position":0}]' },
      event_guests: { in: "body", type: "array", items: { type: "string" }, maxItems: 10, description: "Guest emails (they are invited too)" },
    },
    response: RESOURCE,
  },
  {
    name: "cancel_event",
    title: "Cancel event",
    description: "Cancel a scheduled event (Calendly emails the invitees)",
    method: "POST",
    path: "/scheduled_events/{event_uuid}/cancellation",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_scheduled_event and look at status",
    params: { event_uuid: reference("path", "Scheduled event", true), reason: { in: "body", type: "string" } },
    response: RESOURCE,
  },
];

export const restDefinition = defineRestPlugin({
  name: "calendly",
  version: "0.1.0",
  description: "Calendly: current user, event types and open times, scheduled events and invitees, availability and busy times, single-use links and bookings (agent opt-in), cancel (node only)",
  apiName: "Calendly API",
  baseUrl: "https://api.calendly.com",
  auth: { type: "bearer", env: "CALENDLY_ACCESS_TOKEN" },
  // Tool output is stripped and then truncated by the wrappers below.
  toolOutput: false,
  // Errors are {"title": "Resource Not Found", "message": "...", "details": [...]}.
  errors: {
    messagePath: "message",
    codePath: "title",
    kindByCode: { "Resource Not Found": "not_found", "Permission Denied": "permission_denied", "Invalid Argument": "invalid_input", Unauthenticated: "auth_error" },
  },
  apiRequest: { examplePath: "/users/me" },
  operations: [...userOperations, ...eventTypeOperations, ...scheduledEventOperations, ...availabilityOperations, ...writeOperations],
});

// Which params hold resource references, and whether the API wants the URI or the uuid.
const REFERENCES = {
  get_user: [["user_uuid", "users", "uuid"]],
  list_organization_memberships: [["organization", "organizations", "uri"], ["user", "users", "uri"]],
  list_event_types: [["user", "users", "uri"], ["organization", "organizations", "uri"]],
  get_event_type: [["event_type_uuid", "event_types", "uuid"]],
  list_available_times: [["event_type", "event_types", "uri"]],
  list_scheduled_events: [["user", "users", "uri"], ["organization", "organizations", "uri"], ["group", "groups", "uri"]],
  get_scheduled_event: [["event_uuid", "scheduled_events", "uuid"]],
  list_invitees: [["event_uuid", "scheduled_events", "uuid"]],
  get_invitee: [["event_uuid", "scheduled_events", "uuid"], ["invitee_uuid", "invitees", "uuid"]],
  list_availability_schedules: [["user", "users", "uri"]],
  list_busy_times: [["user", "users", "uri"]],
  create_scheduling_link: [["event_type", "event_types", "uri"]],
  book_meeting: [["event_type", "event_types", "uri"]],
  cancel_event: [["event_uuid", "scheduled_events", "uuid"]],
};
const OWNER_REQUIRED = new Set(["list_event_types", "list_scheduled_events"]);

function normalizeReferences(operationName, args) {
  const normalizedArgs = { ...args };
  for (const [paramName, collection, form] of REFERENCES[operationName] ?? []) {
    if (args[paramName] === undefined) continue;
    normalizedArgs[paramName] = form === "uri" ? toResourceUri(collection, args[paramName], paramName) : toResourceUuid(collection, args[paramName], paramName);
  }
  if (OWNER_REQUIRED.has(operationName) && !normalizedArgs.user && !normalizedArgs.organization && !normalizedArgs.group) {
    throw new PluginError(`\`${operationName}\` needs \`user\` or \`organization\` (get_me returns both as data.uri and data.current_organization)`, { kind: "invalid_input" });
  }
  return normalizedArgs;
}

/**
 * Adds the Calendly wrappers to the declarative definition: uuid/URI references, tool output without invitee
 * cancel/reschedule links (then truncated), and, unless turned off for the generated contract suite (whose
 * api_request checks use arbitrary paths), the api_request read allowlist for tools.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{restrictApiRequest}` (object, default true)
 * @returns Plugin definition (object)
 */
export function decorateCalendlyDefinition(definition, { restrictApiRequest = true } = {}) {
  const wrapOperation = (operation) => {
    const guarded = operation.name === "api_request" && restrictApiRequest ? restrictApiRequestForTools(operation) : operation;
    return {
      ...guarded,
      run: async (context) => {
        const result = await guarded.run({ ...context, args: normalizeReferences(operation.name, context.args) });
        if (context.source !== "tool") return result;
        return { ...result, data: truncateForTool(stripBearerLinks(result?.data), DEFAULT_TOOL_OUTPUT) };
      },
    };
  };
  return { ...definition, operations: definition.operations.map(wrapOperation) };
}

export const pluginDefinition = decorateCalendlyDefinition(restDefinition);
