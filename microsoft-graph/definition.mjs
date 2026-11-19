/**
 * microsoft-graph plugin definition: Outlook mail, calendar and users through Microsoft Graph v1.0
 * (https://learn.microsoft.com/en-us/graph/api/overview), as the signed-in user (delegated refresh token; the token
 * URL depends on MICROSOFT_TENANT_ID, see lib/graph-tenant.mjs). OneDrive is the separate `onedrive` plugin and
 * Teams is `microsoft-teams`. Built with the declarative REST layer (docs/declarative-plugins.md); `send_mail`,
 * `create_draft` and `reply_to_message` are wrapped to take simple fields and check recipients (lib/).
 *
 * Agent policy: sending mail, replying and changing events (which notifies attendees) need
 * MICROSOFT_GRAPH_TOOL_ALLOW_SEND=1 as tools, and MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST further limits tool
 * recipients (and, while it is set, refuses tool replies and event updates, whose recipients are not known in
 * advance). Sending an existing draft and deletes are node only.
 */
import { GRAPH_ERRORS } from "./lib/graph-errors.mjs";
import { defineTenantAwarePlugin, TENANT_ENV } from "./lib/graph-tenant.mjs";
import { RECIPIENT_ALLOWLIST_ENV, SEND_OPT_IN_ENV, wrapCreateDraft, wrapSendMail } from "./lib/mail-message.mjs";
import { assertNoAllowlistForUncheckedSend, replaceOperation } from "./lib/recipient-policy.mjs";

const SEND_POLICY = `optIn:${SEND_OPT_IN_ENV}`;
const MESSAGE_ID = { in: "path", type: "string", required: true, description: "Message id" };
const EVENT_ID = { in: "path", type: "string", required: true, description: "Event id" };
const MESSAGE_SUMMARY_FIELDS = ["id", "subject", "from", "toRecipients", "ccRecipients", "receivedDateTime", "isRead", "hasAttachments", "bodyPreview", "conversationId", "webLink"];
const EVENT_SUMMARY_FIELDS = ["id", "subject", "start", "end", "location", "organizer", "attendees", "isOnlineMeeting", "onlineMeeting", "webLink", "showAs"];
const graphPage = (maxLimit, defaultLimit = 25) => ({ dataPath: "value", nextUrlPath: '["@odata.nextLink"]', limitParam: "$top", maxLimit, defaultLimit });
const selectParam = (defaultFields) => ({ in: "query", type: "array", items: { type: "string" }, wireName: "$select", ...(defaultFields ? { default: defaultFields } : {}), description: "Properties to return" });
const filterParam = { in: "query", type: "string", wireName: "$filter", description: "OData filter, e.g. isRead eq false" };
const orderByParam = (example) => ({ in: "query", type: "string", wireName: "$orderby", description: `OData order, e.g. ${example}` });
// Graph returns HTML bodies unless asked otherwise (https://learn.microsoft.com/en-us/graph/api/message-get).
const bodyFormatParam = { in: "header", type: "string", wireName: "Prefer", enum: ['outlook.body-content-type="text"', 'outlook.body-content-type="html"'], description: "Body format of the returned message" };
const dateTimeZone = (prefix, label) => ({
  [`${prefix}_date_time`]: { in: "body", type: "string", required: true, wireName: `${prefix}.dateTime`, description: `${label}, local time without offset, e.g. 2026-12-01T09:00:00` },
  [`${prefix}_time_zone`]: { in: "body", type: "string", default: "UTC", wireName: `${prefix}.timeZone`, description: "Windows or IANA time zone of the time, e.g. Asia/Jakarta" },
});
const eventFields = {
  subject: { in: "body", type: "string" },
  body: { in: "body", type: "string", wireName: "body.content", description: "Event description" },
  body_type: { in: "body", type: "string", enum: ["text", "html"], wireName: "body.contentType" },
  location: { in: "body", type: "string", wireName: "location.displayName" },
  is_online_meeting: { in: "body", type: "boolean", wireName: "isOnlineMeeting", description: "Add a Teams meeting link" },
  show_as: { in: "body", type: "string", enum: ["free", "tentative", "busy", "oof", "workingElsewhere"], wireName: "showAs" },
};

const userOperations = [
  { name: "get_me", title: "Signed-in user", description: "Profile of the signed-in user", path: "/me" },
  {
    name: "list_users",
    title: "List users",
    description: "Users of the organization (work accounts; needs User.ReadBasic.All)",
    path: "/users",
    params: { filter: { ...filterParam, description: "OData filter, e.g. startswith(displayName,'Ada')" }, select: selectParam() },
    response: graphPage(999),
  },
  { name: "get_user", title: "Get user", description: "One user by id or userPrincipalName", path: "/users/{user_id}", params: { user_id: { in: "path", type: "string", required: true }, select: selectParam() } },
];

const mailReads = [
  { name: "list_mail_folders", title: "Mail folders", description: "Top-level mail folders with item counts", path: "/me/mailFolders", response: graphPage(100) },
  {
    name: "list_messages",
    title: "List messages",
    description: "Messages in all folders, or in one folder (well-known names: inbox, sentitems, drafts, archive)",
    path: "/me/messages",
    params: {
      filter: filterParam,
      search: { in: "query", type: "string", wireName: "$search", description: 'KQL search, quoted, e.g. "\\"from:ada subject:invoice\\"" (no $orderby with $search)' },
      order_by: orderByParam("receivedDateTime desc"),
      select: selectParam(MESSAGE_SUMMARY_FIELDS),
    },
    response: graphPage(100),
  },
  {
    name: "list_folder_messages",
    title: "Folder messages",
    description: "Messages of one mail folder (id or well-known name such as inbox)",
    path: "/me/mailFolders/{folder_id}/messages",
    params: { folder_id: { in: "path", type: "string", required: true, description: "Folder id or inbox, sentitems, drafts, archive, deleteditems, junkemail" }, filter: filterParam, order_by: orderByParam("receivedDateTime desc"), select: selectParam(MESSAGE_SUMMARY_FIELDS) },
    response: graphPage(100),
  },
  { name: "get_message", title: "Get message", description: "One message with its body", path: "/me/messages/{message_id}", params: { message_id: MESSAGE_ID, select: selectParam(), body_format: bodyFormatParam } },
];

const mailWrites = [
  {
    name: "send_mail",
    title: "Send mail",
    description: "Send an email as the signed-in user (Graph answers 202 with no body)",
    method: "POST",
    path: "/me/sendMail",
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "list_folder_messages with folder_id sentitems and look for the subject",
    // The wrapper in lib/mail-message.mjs builds `message` from to/cc/bcc/subject/body.
    params: { message: { in: "body", type: "object" }, save_to_sent_items: { in: "body", type: "boolean", wireName: "saveToSentItems" } },
  },
  {
    name: "create_draft",
    title: "Create draft",
    description: "Save a draft in Drafts without sending it",
    method: "POST",
    path: "/me/messages",
    bodyMode: "raw",
    write: "unsafe",
    checkHint: "list_folder_messages with folder_id drafts",
    params: { message: { in: "body", type: "object" } },
  },
  {
    name: "send_draft",
    title: "Send draft",
    description: "Send an existing draft",
    method: "POST",
    path: "/me/messages/{message_id}/send",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_folder_messages with folder_id sentitems",
    params: { message_id: MESSAGE_ID },
  },
  {
    name: "reply_to_message",
    title: "Reply",
    description: "Reply to the sender (or everyone with reply_all) with a comment",
    method: "POST",
    path: "/me/messages/{message_id}/{reply_kind}",
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "list_folder_messages with folder_id sentitems",
    params: { message_id: MESSAGE_ID, reply_kind: { in: "path", type: "string", required: true, enum: ["reply", "replyAll"], description: "reply (sender only) or replyAll" }, comment: { in: "body", type: "string", required: true, description: "Reply text, added above the quoted message" } },
  },
  {
    name: "update_message",
    title: "Update message",
    description: "Mark read or unread, set categories or the follow-up flag",
    method: "PATCH",
    path: "/me/messages/{message_id}",
    write: "idempotent",
    params: {
      message_id: MESSAGE_ID,
      is_read: { in: "body", type: "boolean", wireName: "isRead" },
      categories: { in: "body", type: "array", items: { type: "string" } },
      flag_status: { in: "body", type: "string", enum: ["notFlagged", "flagged", "complete"], wireName: "flag.flagStatus" },
    },
  },
  {
    name: "move_message",
    title: "Move message",
    description: "Move a message to another folder (the moved message gets a new id)",
    method: "POST",
    path: "/me/messages/{message_id}/move",
    write: "unsafe",
    checkHint: "list_folder_messages of the destination folder",
    params: { message_id: MESSAGE_ID, destination_id: { in: "body", type: "string", required: true, wireName: "destinationId", description: "Folder id or well-known name, e.g. archive" } },
  },
  { name: "delete_message", title: "Delete message", description: "Move a message to Deleted Items", method: "DELETE", path: "/me/messages/{message_id}", write: "idempotent", nodeOnly: true, params: { message_id: MESSAGE_ID } },
];

const calendarOperations = [
  { name: "list_calendars", title: "List calendars", description: "Calendars of the signed-in user", path: "/me/calendars", response: graphPage(100) },
  {
    name: "list_events",
    title: "List events",
    description: "Events of the default calendar as stored (recurring events appear once; use calendar_view for occurrences)",
    path: "/me/events",
    params: { filter: filterParam, order_by: orderByParam("start/dateTime"), select: selectParam(EVENT_SUMMARY_FIELDS) },
    response: graphPage(100),
  },
  {
    name: "calendar_view",
    title: "Calendar view",
    description: "Event occurrences between two times (recurrences expanded), in UTC",
    path: "/me/calendarView",
    params: {
      start_date_time: { in: "query", type: "string", required: true, wireName: "startDateTime", description: "ISO 8601, e.g. 2026-12-01T00:00:00Z" },
      end_date_time: { in: "query", type: "string", required: true, wireName: "endDateTime", description: "ISO 8601, e.g. 2026-12-08T00:00:00Z" },
      order_by: orderByParam("start/dateTime"),
      select: selectParam(EVENT_SUMMARY_FIELDS),
    },
    response: graphPage(100),
  },
  { name: "get_event", title: "Get event", description: "One event", path: "/me/events/{event_id}", params: { event_id: EVENT_ID, select: selectParam() } },
  {
    name: "create_event",
    title: "Create event",
    description: "Create an event in the default calendar, without attendees (so no invitation is sent)",
    method: "POST",
    path: "/me/events",
    write: "unsafe",
    checkHint: "calendar_view for the event's time range and look for the subject",
    params: { subject: { ...eventFields.subject, required: true, minLength: 1 }, ...dateTimeZone("start", "Start"), ...dateTimeZone("end", "End"), ...Object.fromEntries(Object.entries(eventFields).filter(([fieldName]) => fieldName !== "subject")) },
  },
  {
    name: "update_event",
    title: "Update event",
    description: "Change an event's subject, time, location or description (attendees are notified of changes)",
    method: "PATCH",
    path: "/me/events/{event_id}",
    write: "idempotent",
    toolPolicy: SEND_POLICY,
    params: {
      event_id: EVENT_ID,
      ...eventFields,
      start_date_time: { in: "body", type: "string", wireName: "start.dateTime" },
      start_time_zone: { in: "body", type: "string", wireName: "start.timeZone" },
      end_date_time: { in: "body", type: "string", wireName: "end.dateTime" },
      end_time_zone: { in: "body", type: "string", wireName: "end.timeZone" },
    },
  },
  { name: "delete_event", title: "Delete event", description: "Delete an event (attendees get a cancellation)", method: "DELETE", path: "/me/events/{event_id}", write: "idempotent", nodeOnly: true, params: { event_id: EVENT_ID } },
];

const buildSpec = (tokenUrl) => ({
  name: "microsoft-graph",
  version: "0.1.0",
  description: "Microsoft Graph: Outlook mail (list, read, send, drafts, replies), calendar events and users; agent sends need an opt-in and an optional recipient allowlist",
  apiName: "Microsoft Graph",
  baseUrl: "https://graph.microsoft.com/v1.0",
  auth: {
    type: "oauth2",
    grant: "refresh_token",
    tokenUrl,
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
    refreshTokenEnv: "MICROSOFT_REFRESH_TOKEN",
    scope: "https://graph.microsoft.com/.default offline_access",
  },
  extraEnv: [TENANT_ENV, RECIPIENT_ALLOWLIST_ENV],
  errors: GRAPH_ERRORS,
  apiRequest: { examplePath: "/me/mailFolders/inbox" },
  operations: [...userOperations, ...mailReads, ...mailWrites, ...calendarOperations],
});

// Replies and event updates notify recipients that cannot be checked before the call, so tools may not use them
// while a recipient allowlist is set.
const refuseWhileAllowlisted = (operation) => ({
  ...operation,
  run: (context) => {
    assertNoAllowlistForUncheckedSend(context, RECIPIENT_ALLOWLIST_ENV, operation.name);
    return operation.run(context);
  },
});

export const pluginDefinition = [
  ["send_mail", wrapSendMail],
  ["create_draft", wrapCreateDraft],
  ["reply_to_message", refuseWhileAllowlisted],
  ["update_event", refuseWhileAllowlisted],
].reduce((definition, [operationName, wrap]) => replaceOperation(definition, operationName, wrap), defineTenantAwarePlugin(buildSpec));
