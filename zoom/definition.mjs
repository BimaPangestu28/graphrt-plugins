/**
 * zoom plugin definition: the Zoom REST API v2 (https://developers.zoom.us/docs/api/) for users, meetings, past
 * meetings and participants, and cloud recordings. Built with the declarative REST layer
 * (docs/declarative-plugins.md).
 *
 * Auth is a Server-to-Server OAuth app (account_credentials grant). The layer's oauth2 auth cannot send that grant,
 * so it is custom auth (lib/zoom-token.mjs); createClient registers the run's fetch for the token request.
 *
 * Agent policy: deleting a meeting is node only; tool results never contain start links, recording download/play/
 * share links or passcodes (lib/zoom-tool-safety.mjs); api_request as a tool may only GET an allowlist of read
 * paths. create_meeting does not expose invitee or alternative-host fields, so it sends no emails.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./lib/shared/rest-response.mjs";
import { ACCOUNT_ID_ENV, authorizeZoomRequest, CLIENT_ID_ENV, CLIENT_SECRET_ENV, invalidateZoomToken, registerRunSignal, registerTokenFetch } from "./lib/zoom-token.mjs";
import { prepareMeetingUuid, restrictApiRequestForTools, stripBearerFields } from "./lib/zoom-tool-safety.mjs";

const USER_ID = { in: "path", type: "string", required: true, description: 'User id, email, or "me" for the app\'s user context' };
const MEETING_ID = { in: "path", type: "string", required: true, description: "Meeting id (numeric)" };
const MEETING_ID_OR_UUID = { in: "path", type: "string", required: true, description: "Meeting id, or a meeting instance UUID (from list_past_meeting_instances) for one occurrence" };
const DATE = (label) => ({ in: "query", type: "string", description: `${label} date, yyyy-mm-dd (UTC)` });
const zoomPage = (dataPath) => ({ dataPath, cursorPath: "next_page_token", cursorParam: "next_page_token", limitParam: "page_size", maxLimit: 300, defaultLimit: 30 });

// Fields shared by create and update. No meeting_invitees, alternative_hosts or registrant fields: those email people.
const meetingFields = {
  topic: { in: "body", type: "string", description: "Meeting topic" },
  meeting_type: { in: "body", type: "integer", enum: [1, 2, 3, 8], wireName: "type", description: "1 instant, 2 scheduled (default), 3 recurring without fixed time, 8 recurring with fixed time" },
  start_time: { in: "body", type: "string", description: "Start, yyyy-MM-ddTHH:mm:ssZ (UTC) or yyyy-MM-ddTHH:mm:ss with timezone" },
  duration: { in: "body", type: "integer", min: 1, description: "Minutes" },
  timezone: { in: "body", type: "string", description: "IANA time zone, e.g. Asia/Jakarta" },
  agenda: { in: "body", type: "string", description: "Description (max 2000 characters)" },
  passcode: { in: "body", type: "string", wireName: "password", description: "Passcode (max 10 characters: letters, numbers, @ - _ *)" },
  recurrence: { in: "body", type: "object", description: 'For types 3 and 8, e.g. {"type":2,"repeat_interval":1,"weekly_days":"2","end_times":4}' },
  host_video: { in: "body", type: "boolean", wireName: "settings.host_video" },
  participant_video: { in: "body", type: "boolean", wireName: "settings.participant_video" },
  join_before_host: { in: "body", type: "boolean", wireName: "settings.join_before_host" },
  mute_upon_entry: { in: "body", type: "boolean", wireName: "settings.mute_upon_entry" },
  waiting_room: { in: "body", type: "boolean", wireName: "settings.waiting_room" },
  auto_recording: { in: "body", type: "string", enum: ["local", "cloud", "none"], wireName: "settings.auto_recording" },
};

const userOperations = [
  { name: "get_me", title: "App user", description: "The user the app acts as (users/me)", path: "/users/me" },
  {
    name: "list_users",
    title: "List users",
    description: "Users of the account",
    path: "/users",
    params: { status: { in: "query", type: "string", enum: ["active", "inactive", "pending"], description: "Default active" }, role_id: { in: "query", type: "string" } },
    response: zoomPage("users"),
  },
  { name: "get_user", title: "Get user", description: "One user by id or email", path: "/users/{user_id}", params: { user_id: USER_ID } },
];

const meetingOperations = [
  {
    name: "list_meetings",
    title: "List meetings",
    description: "A user's meetings: scheduled (default), live, upcoming, upcoming_meetings or previous_meetings",
    path: "/users/{user_id}/meetings",
    params: {
      user_id: USER_ID,
      meeting_type: { in: "query", type: "string", enum: ["scheduled", "live", "upcoming", "upcoming_meetings", "previous_meetings"], wireName: "type" },
      from: DATE("From"),
      to: DATE("To"),
      timezone: { in: "query", type: "string", description: "Time zone of from/to" },
    },
    response: zoomPage("meetings"),
  },
  {
    name: "get_meeting",
    title: "Get meeting",
    description: "One meeting with its settings and occurrences",
    path: "/meetings/{meeting_id}",
    params: { meeting_id: MEETING_ID, occurrence_id: { in: "query", type: "string" }, show_previous_occurrences: { in: "query", type: "boolean" } },
  },
  {
    name: "create_meeting",
    title: "Create meeting",
    description: "Schedule a meeting for a user (no invitations are sent; share join_url yourself)",
    method: "POST",
    path: "/users/{user_id}/meetings",
    write: "unsafe",
    checkHint: "list_meetings for the user with meeting_type upcoming and look for the topic",
    params: { user_id: USER_ID, ...meetingFields, topic: { ...meetingFields.topic, required: true, minLength: 1 } },
  },
  {
    name: "update_meeting",
    title: "Update meeting",
    description: "Change a meeting's topic, time, duration, agenda, passcode or settings (Zoom answers 204 with no body; 100 updates a day per meeting)",
    method: "PATCH",
    path: "/meetings/{meeting_id}",
    write: "idempotent",
    params: { meeting_id: MEETING_ID, occurrence_id: { in: "query", type: "string", description: "Change only this occurrence" }, ...meetingFields },
  },
  {
    name: "delete_meeting",
    title: "Delete meeting",
    description: "Delete a meeting or one occurrence",
    method: "DELETE",
    path: "/meetings/{meeting_id}",
    write: "idempotent",
    nodeOnly: true,
    params: {
      meeting_id: MEETING_ID,
      occurrence_id: { in: "query", type: "string" },
      cancel_meeting_reminder: { in: "query", type: "boolean", description: "Email the registrants and alternative hosts about the cancellation" },
      schedule_for_reminder: { in: "query", type: "boolean", description: "Email the host about the cancellation" },
    },
  },
];

const pastMeetingOperations = [
  { name: "get_past_meeting", title: "Past meeting", description: "Details of an ended meeting (duration, participant count)", path: "/past_meetings/{meeting_id}", params: { meeting_id: MEETING_ID_OR_UUID } },
  { name: "list_past_meeting_instances", title: "Past meeting instances", description: "Instances (UUIDs and start times) of an ended or recurring meeting", path: "/past_meetings/{meeting_id}/instances", params: { meeting_id: MEETING_ID }, response: { dataPath: "meetings" } },
  {
    name: "list_past_meeting_participants",
    title: "Past meeting participants",
    description: "Who joined an ended meeting, with join and leave times (paid plans)",
    path: "/past_meetings/{meeting_id}/participants",
    params: { meeting_id: MEETING_ID_OR_UUID },
    response: zoomPage("participants"),
  },
];

const recordingOperations = [
  {
    name: "list_recordings",
    title: "List recordings",
    description: "A user's cloud recordings between two dates (at most one month apart; default the last day)",
    path: "/users/{user_id}/recordings",
    params: { user_id: USER_ID, from: DATE("From"), to: DATE("To"), meeting_id: { in: "query", type: "integer", description: "Only this meeting" } },
    response: zoomPage("meetings"),
  },
  {
    name: "get_meeting_recordings",
    title: "Meeting recordings",
    description: "Cloud recording files of a meeting (latest instance for an id; one instance for a UUID)",
    path: "/meetings/{meeting_id}/recordings",
    params: { meeting_id: MEETING_ID_OR_UUID },
  },
];

export const restDefinition = defineRestPlugin({
  name: "zoom",
  version: "0.1.0",
  description: "Zoom: users, meetings (list, get, create, update; delete is node only), past meetings and participants, cloud recordings (Server-to-Server OAuth; start and download links hidden from agents)",
  apiName: "Zoom API",
  baseUrl: "https://api.zoom.us/v2",
  toolUserToken: { credentialEnv: [ACCOUNT_ID_ENV, CLIENT_ID_ENV] },
  auth: { type: "custom", env: CLIENT_SECRET_ENV, authorize: authorizeZoomRequest },
  extraEnv: [ACCOUNT_ID_ENV, CLIENT_ID_ENV],
  // Tool output is stripped and then truncated by the wrappers below.
  toolOutput: false,
  // Errors are {"code": 124, "message": "Invalid access token."}; 429 carries Retry-After.
  errors: { messagePath: "message", codePath: "code", kindByCode: { 3001: "not_found", 1001: "not_found", 3301: "not_found", 300: "invalid_input", 124: "auth_error" } },
  apiRequest: { examplePath: "/users/me/upcoming_meetings" },
  operations: [...userOperations, ...meetingOperations, ...pastMeetingOperations, ...recordingOperations],
});

const UUID_OPERATIONS = new Set(["get_past_meeting", "list_past_meeting_participants", "get_meeting_recordings"]);

// Tools get stripped, then truncated, data; an auth_error drops the cached token so the next call fetches a new one.
function wrapOperation(operation, restrictApiRequest) {
  const guarded = operation.name === "api_request" && restrictApiRequest ? restrictApiRequestForTools(operation) : operation;
  return {
    ...guarded,
    run: async (context) => {
      if (context.client?.environment) registerRunSignal(context.client.environment, context.signal);
      const args = UUID_OPERATIONS.has(operation.name) ? { ...context.args, meeting_id: prepareMeetingUuid(context.args.meeting_id) } : context.args;
      const result = await guarded.run({ ...context, args }).catch((operationError) => {
        if (operationError?.kind === "auth_error") invalidateZoomToken(context.environment);
        throw operationError;
      });
      if (context.source !== "tool") return result;
      return { ...result, data: truncateForTool(stripBearerFields(result?.data), DEFAULT_TOOL_OUTPUT) };
    },
  };
}

/**
 * Adds the Zoom wrappers to the declarative definition: the token request's fetch, UUID double-encoding, tool
 * output stripping and token invalidation, and (unless turned off for the generated contract suite, whose
 * api_request checks use arbitrary paths) the api_request read allowlist for tools.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{restrictApiRequest}` (object, default true)
 * @returns Plugin definition (object)
 */
export function decorateZoomDefinition(definition, { restrictApiRequest = true } = {}) {
  return {
    ...definition,
    createClient: (clientOptions) => definition.createClient({ ...clientOptions, environment: registerTokenFetch({ ...clientOptions.environment }, clientOptions.fetchImpl) }),
    operations: definition.operations.map((operation) => wrapOperation(operation, restrictApiRequest)),
  };
}

export const pluginDefinition = decorateZoomDefinition(restDefinition);
