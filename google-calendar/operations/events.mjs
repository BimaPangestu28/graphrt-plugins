/**
 * Event operations: list, get, create (idempotent, optional Meet and slot re-check), update
 * (PATCH), delete and quick add. Tool calls are limited by lib/tool-policy.mjs.
 */
import { randomUUID } from "node:crypto";
import { appendRepeatedQuery, calendarPath, eventPath, rejectInput, withWriteOutcomeHint } from "../lib/client.mjs";
import { assertValidNewEventId, deriveEventId, generateRandomEventId } from "../lib/event-ids.mjs";
import { buildEventFields, buildPrivateProperties, normalizePrivateProperties, summarizeEvent } from "../lib/event-resource.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import {
  assertCalendarAllowedForTool,
  assertToolMayChangeEvent,
  describeSendUpdates,
  isCreatedByPlugin,
  PLUGIN_CREATED_PROPERTY,
  PLUGIN_CREATED_VALUE,
  resolveSendUpdates,
} from "../lib/tool-policy.mjs";
import { assertValidTimeZone, parseInstant } from "../lib/time-zones.mjs";
import { CALENDAR_ID_PROPERTY, normalizeTimeBound, queryFreeBusy, TIME_ZONE_PROPERTY } from "./calendars.mjs";

const MAX_LIST_RESULTS = 2500;
const OUTCOME_UNKNOWN_KINDS = new Set(["network_error", "api_error", "cancelled"]);

const EVENT_ID_PROPERTY = { type: "string", description: "Event id (from list_events or create_event)" };
const SEND_UPDATES_PROPERTY = {
  type: "string",
  enum: ["all", "externalOnly", "none"],
  default: "none",
  description: "Who gets an email about the change. Agent tools always use none unless GOOGLE_CALENDAR_TOOL_SEND_UPDATES=1",
};
const EVENT_FIELD_PROPERTIES = {
  summary: { type: "string", description: "Title" },
  description: { type: "string", description: "Description (plain text or simple HTML)" },
  location: { type: "string", description: "Location text" },
  start: {
    type: "string",
    description: 'Start: date-time "2026-11-20T09:00:00+07:00" (or without offset plus `time_zone`), or a date "2026-11-20" for an all-day event',
  },
  end: { type: "string", description: "End, same form as start (exclusive); for all-day events defaults to the next day" },
  time_zone: TIME_ZONE_PROPERTY,
  attendees: {
    type: "array",
    description: 'Guests: emails or {"email", "optional", "display_name"} objects. On update this replaces the whole list',
  },
  reminders: {
    type: "array",
    description: 'Up to 5 reminders like {"method": "popup" | "email", "minutes": 30} (minutes before start, max 40320)',
  },
  use_default_reminders: { type: "boolean", description: "Use the calendar's default reminders" },
  recurrence: { type: "array", items: { type: "string" }, description: 'RFC 5545 lines, e.g. ["RRULE:FREQ=WEEKLY;COUNT=4"]; needs time_zone for timed events' },
  transparency: { type: "string", enum: ["opaque", "transparent"], description: "opaque = busy (default), transparent = free" },
  visibility: { type: "string", enum: ["default", "public", "private", "confidential"] },
  color_id: { type: "string", description: "Event color id (1-11)" },
  private_properties: { type: "object", description: "Private extended properties {name: value} stored on this calendar's copy, e.g. a booking id" },
  add_google_meet: { type: "boolean", description: "Create a Google Meet link for the event" },
  send_updates: SEND_UPDATES_PROPERTY,
};

function toContext({ source, environment }) {
  return { source, environment };
}

// --- create_event ---

function chooseEventId(args) {
  if (args.event_id !== undefined && args.idempotency_key !== undefined) rejectInput("Pass either `event_id` or `idempotency_key`, not both");
  if (args.event_id !== undefined) return { eventId: assertValidNewEventId(args.event_id), isDeterministic: true };
  if (args.idempotency_key !== undefined) return { eventId: deriveEventId(args.idempotency_key), isDeterministic: true };
  return { eventId: generateRandomEventId(), isDeterministic: false };
}

function buildCreateBody(args, eventId) {
  const body = { id: eventId, ...buildEventFields(args, { isPartialUpdate: false }) };
  body.extendedProperties = buildPrivateProperties(args.private_properties, undefined, true);
  // requestId comes from the event id, so a retried insert asks for the same conference.
  if (args.add_google_meet) body.conferenceData = { createRequest: { requestId: eventId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  return body;
}

async function readEventIfPresent({ client, calendarId, eventId, signal }) {
  try {
    return await client.request({ path: eventPath(calendarId, eventId), signal });
  } catch (readError) {
    if (readError instanceof PluginError && (readError.kind === "not_found" || readError.kind === "already_deleted")) return null;
    throw readError;
  }
}

// A 409 duplicate means an earlier attempt with the same id already created the event.
async function readDuplicateEvent({ client, calendarId, eventId, signal }) {
  const existingEvent = await readEventIfPresent({ client, calendarId, eventId, signal });
  if (!existingEvent || existingEvent.status === "cancelled") {
    throw new PluginError(`An event with id ${eventId} was created earlier and then deleted; use a new idempotency_key or event_id`, {
      kind: "already_exists",
    });
  }
  return existingEvent;
}

function readRequestedSlot(body) {
  if (!body.start.dateTime) rejectInput("`book_slot` needs a start and end with a time, not an all-day event");
  return {
    slotStartMs: parseInstant(body.start.dateTime, { name: "start", timeZone: body.start.timeZone }),
    slotEndMs: parseInstant(body.end.dateTime, { name: "end", timeZone: body.end.timeZone }),
  };
}

// book_slot promises the requested time, so an earlier booking under the same id at another time is a conflict, not success.
function assertEarlierBookingMatchesSlot(earlierEvent, { args, body }) {
  const { slotStartMs, slotEndMs } = readRequestedSlot(body);
  const [earlierStart, earlierEnd] = [earlierEvent.start?.dateTime, earlierEvent.end?.dateTime];
  if (Date.parse(earlierStart) === slotStartMs && Date.parse(earlierEnd) === slotEndMs) return earlierEvent;
  const earlierTimes = `${earlierStart ?? earlierEvent.start?.date ?? "?"} - ${earlierEnd ?? earlierEvent.end?.date ?? "?"}`;
  throw new PluginError(
    `This idempotency_key/event_id already booked event ${earlierEvent.id} at ${earlierTimes}, not the requested ${args.start} - ${args.end}; ` +
      "nothing was created. Use a new idempotency_key, or update_event to move the earlier event",
    { kind: "conflict" },
  );
}

async function assertSlotStillFree({ client, args, body, eventId, isDeterministic, signal }) {
  const { slotStartMs, slotEndMs } = readRequestedSlot(body);
  const freeBusy = await queryFreeBusy({ client, calendarIds: [args.calendar_id], timeMin: new Date(slotStartMs).toISOString(), timeMax: new Date(slotEndMs).toISOString(), signal });
  const calendarResult = freeBusy.calendars?.[args.calendar_id] ?? Object.values(freeBusy.calendars ?? {})[0];
  if (!calendarResult || calendarResult.errors?.length) {
    const reasons = (calendarResult?.errors ?? []).map((calendarError) => calendarError.reason).join(", ") || "no result";
    throw new PluginError(`Could not re-check the slot before booking (${reasons}); nothing was created`, { kind: "api_error", retryable: true });
  }
  const isTaken = (calendarResult.busy ?? []).some((busy) => Date.parse(busy.start) < slotEndMs && Date.parse(busy.end) > slotStartMs);
  if (!isTaken) return null;
  const ownEarlierEvent = isDeterministic ? await readEventIfPresent({ client, calendarId: args.calendar_id, eventId, signal }) : null;
  if (ownEarlierEvent && ownEarlierEvent.status !== "cancelled") return assertEarlierBookingMatchesSlot(ownEarlierEvent, { args, body });
  throw new PluginError(`The slot ${args.start} - ${args.end} is no longer free on ${args.calendar_id}; nothing was created`, { kind: "conflict" });
}

async function insertEvent({ client, args, body, query, eventIdChoice, signal }) {
  const { eventId, isDeterministic } = eventIdChoice;
  const pendingInsert = client.request({ method: "POST", path: `${calendarPath(args.calendar_id)}/events`, query, json: body, signal, idempotent: true });
  try {
    return { event: await pendingInsert, alreadyExisted: false };
  } catch (insertError) {
    if (insertError instanceof PluginError && insertError.kind === "already_exists") {
      const duplicateEvent = await readDuplicateEvent({ client, calendarId: args.calendar_id, eventId, signal });
      return { event: args.book_slot ? assertEarlierBookingMatchesSlot(duplicateEvent, { args, body }) : duplicateEvent, alreadyExisted: true };
    }
    if (isDeterministic || !(insertError instanceof PluginError) || !OUTCOME_UNKNOWN_KINDS.has(insertError.kind)) throw insertError;
    const hint = `the event may exist: call get_event with event_id ${eventId}. Pass idempotency_key to make retries safe`;
    throw new PluginError(`${insertError.message} (outcome unknown; ${hint})`, { kind: insertError.kind, retryable: false });
  }
}

async function createEvent({ client, args, signal, source, environment }) {
  const context = toContext({ source, environment });
  assertCalendarAllowedForTool(context, args.calendar_id);
  const eventIdChoice = chooseEventId(args);
  const body = buildCreateBody(args, eventIdChoice.eventId);
  const sendUpdatesChoice = resolveSendUpdates(context, args.send_updates);
  const bookedEarlier = args.book_slot ? await assertSlotStillFree({ client, args, body, ...eventIdChoice, signal }) : null;
  if (bookedEarlier) return { data: { ...summarizeEvent(bookedEarlier), already_existed: true, ...describeSendUpdates(sendUpdatesChoice) } };
  const query = { sendUpdates: sendUpdatesChoice.sendUpdates, conferenceDataVersion: args.add_google_meet ? 1 : undefined };
  const { event, alreadyExisted } = await insertEvent({ client, args, body, query, eventIdChoice, signal });
  return { data: { ...summarizeEvent(event), already_existed: alreadyExisted, ...describeSendUpdates(sendUpdatesChoice) } };
}

// --- update_event ---

// Tool calls change an event only while it is still the version they checked (HTTP 412 otherwise).
function buildPreconditionHeaders(source, currentEvent) {
  return source === "tool" && currentEvent?.etag ? { "if-match": currentEvent.etag } : undefined;
}

function describeConcurrentChange(writeError, eventId) {
  if (!(writeError instanceof PluginError) || writeError.kind !== "conflict") return writeError;
  const message = `Event ${eventId} changed since it was checked (${writeError.message}); nothing was changed. Call get_event and retry`;
  return new PluginError(message, { kind: "conflict", retryable: false });
}

function buildUpdateBody(args, currentEvent) {
  const body = buildEventFields(args, { isPartialUpdate: true });
  // An event carrying the plugin's tag keeps it, so private_properties cannot strip it.
  const keepsTag = args.private_properties !== undefined && isCreatedByPlugin(currentEvent);
  const extendedProperties = buildPrivateProperties(args.private_properties, currentEvent?.extendedProperties?.private, keepsTag);
  if (extendedProperties) body.extendedProperties = extendedProperties;
  if (args.add_google_meet) body.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  if (Object.keys(body).length === 0) rejectInput("Nothing to update: pass at least one field such as summary, start, end or attendees");
  return body;
}

async function updateEvent({ client, args, signal, source, environment }) {
  const context = toContext({ source, environment });
  assertCalendarAllowedForTool(context, args.calendar_id);
  const needsCurrentEvent = source === "tool" || args.private_properties !== undefined;
  const currentEvent = needsCurrentEvent ? await client.request({ path: eventPath(args.calendar_id, args.event_id), signal }) : undefined;
  if (currentEvent) assertToolMayChangeEvent(context, currentEvent, "update");
  const body = buildUpdateBody(args, currentEvent);
  const sendUpdatesChoice = resolveSendUpdates(context, args.send_updates);
  const query = { sendUpdates: sendUpdatesChoice.sendUpdates, conferenceDataVersion: args.add_google_meet ? 1 : undefined };
  const headers = buildPreconditionHeaders(source, currentEvent);
  const pendingPatch = client.request({ method: "PATCH", path: eventPath(args.calendar_id, args.event_id), query, json: body, headers, signal });
  const event = await withWriteOutcomeHint(pendingPatch, `call get_event with event_id ${args.event_id} and compare before retrying`).catch((patchError) => {
    throw describeConcurrentChange(patchError, args.event_id);
  });
  return { data: { ...summarizeEvent(event), ...describeSendUpdates(sendUpdatesChoice) } };
}

// --- delete_event ---

// The event a tool may delete, or null when it is already cancelled (checked first: a cancelled event may have lost its tag).
async function readEventToolMayDelete({ client, args, context, signal }) {
  const currentEvent = await client.request({ path: eventPath(args.calendar_id, args.event_id), signal });
  if (currentEvent.status === "cancelled") return null;
  assertToolMayChangeEvent(context, currentEvent, "delete");
  return currentEvent;
}

// A retried DELETE with If-Match may get 412 after its first attempt succeeded; a cancelled event means it did.
async function isGoneAfterConflict({ client, args, signal }) {
  const latestEvent = await readEventIfPresent({ client, calendarId: args.calendar_id, eventId: args.event_id, signal });
  return !latestEvent || latestEvent.status === "cancelled";
}

async function deleteEvent({ client, args, signal, source, environment }) {
  const context = toContext({ source, environment });
  assertCalendarAllowedForTool(context, args.calendar_id);
  const sendUpdatesChoice = resolveSendUpdates(context, args.send_updates);
  const deletedResult = (alreadyDeleted) => ({ data: { event_id: args.event_id, deleted: true, already_deleted: alreadyDeleted, ...describeSendUpdates(sendUpdatesChoice) } });
  const currentEvent = source === "tool" ? await readEventToolMayDelete({ client, args, context, signal }) : undefined;
  if (currentEvent === null) return deletedResult(true);
  const query = { sendUpdates: sendUpdatesChoice.sendUpdates };
  try {
    await client.request({ method: "DELETE", path: eventPath(args.calendar_id, args.event_id), query, headers: buildPreconditionHeaders(source, currentEvent), signal });
    return deletedResult(false);
  } catch (deleteError) {
    if (deleteError instanceof PluginError && deleteError.kind === "already_deleted") return deletedResult(true);
    if (deleteError instanceof PluginError && deleteError.kind === "conflict" && (await isGoneAfterConflict({ client, args, signal }))) return deletedResult(true);
    throw describeConcurrentChange(deleteError, args.event_id);
  }
}

// --- quick_add ---

async function tagQuickAddedEvent({ client, calendarId, event, signal }) {
  try {
    const json = { extendedProperties: { private: { ...event.extendedProperties?.private, [PLUGIN_CREATED_PROPERTY]: PLUGIN_CREATED_VALUE } } };
    return { event: await client.request({ method: "PATCH", path: eventPath(calendarId, event.id), query: { sendUpdates: "none" }, json, signal }), tagWarning: null };
  } catch (tagError) {
    const warning = `The event was created but could not be tagged as created by this plugin (${tagError.message}); agent tools cannot update or delete it`;
    return { event, tagWarning: warning };
  }
}

async function quickAddEvent({ client, args, signal, source, environment }) {
  const context = toContext({ source, environment });
  assertCalendarAllowedForTool(context, args.calendar_id);
  const sendUpdatesChoice = resolveSendUpdates(context, args.send_updates);
  const query = { text: args.text, sendUpdates: sendUpdatesChoice.sendUpdates };
  const pendingQuickAdd = client.request({ method: "POST", path: `${calendarPath(args.calendar_id)}/events/quickAdd`, query, signal });
  const createdEvent = await withWriteOutcomeHint(pendingQuickAdd, "call list_events with `q` set to words from the text before retrying");
  const { event, tagWarning } = await tagQuickAddedEvent({ client, calendarId: args.calendar_id, event: createdEvent, signal });
  return { data: { ...summarizeEvent(event), ...describeSendUpdates(sendUpdatesChoice), ...(tagWarning ? { warning: tagWarning } : {}) } };
}

// --- list_events / get_event ---

function buildPropertyFilters(args) {
  const filters = Object.entries(normalizePrivateProperties(args.private_properties ?? {})).map(([propertyName, propertyValue]) => `${propertyName}=${propertyValue}`);
  if (args.created_by_plugin) filters.push(`${PLUGIN_CREATED_PROPERTY}=${PLUGIN_CREATED_VALUE}`);
  return filters;
}

async function listEvents({ client, args, signal, source, environment }) {
  assertCalendarAllowedForTool(toContext({ source, environment }), args.calendar_id);
  if (args.time_zone !== undefined) assertValidTimeZone(args.time_zone);
  const orderBy = args.order_by ?? (args.single_events ? "startTime" : undefined);
  if (orderBy === "startTime" && !args.single_events) rejectInput("`order_by: startTime` needs `single_events: true`");
  const query = {
    timeMin: normalizeTimeBound(args.time_min, "time_min", args.time_zone),
    timeMax: normalizeTimeBound(args.time_max, "time_max", args.time_zone),
    q: args.q,
    singleEvents: args.single_events,
    orderBy,
    maxResults: args.limit,
    pageToken: args.cursor,
    timeZone: args.time_zone,
    showDeleted: args.show_deleted,
  };
  const path = appendRepeatedQuery(`${calendarPath(args.calendar_id)}/events`, "privateExtendedProperty", buildPropertyFilters(args));
  const eventList = await client.request({ path, query, signal });
  return { data: { events: (eventList?.items ?? []).map(summarizeEvent), time_zone: eventList?.timeZone ?? null }, next_cursor: eventList?.nextPageToken ?? null };
}

async function getEvent({ client, args, signal, source, environment }) {
  assertCalendarAllowedForTool(toContext({ source, environment }), args.calendar_id);
  const event = await client.request({ path: eventPath(args.calendar_id, args.event_id), query: { timeZone: args.time_zone }, signal });
  return { data: summarizeEvent(event) };
}

export const eventOperations = [
  {
    name: "list_events",
    title: "List Google Calendar events",
    description: "List events in a time range, optionally matching text `q`. Recurring events are expanded and sorted by start by default.",
    parameters: {
      type: "object",
      properties: {
        calendar_id: CALENDAR_ID_PROPERTY,
        time_min: { type: "string", description: "Only events ending after this (RFC 3339, or a local date/date-time with time_zone)" },
        time_max: { type: "string", description: "Only events starting before this" },
        q: { type: "string", description: "Free-text search in title, description, location, attendees" },
        single_events: { type: "boolean", default: true, description: "Expand recurring events into single occurrences" },
        order_by: { type: "string", enum: ["startTime", "updated"], description: "Default startTime when single_events is true" },
        time_zone: TIME_ZONE_PROPERTY,
        show_deleted: { type: "boolean", description: "Include cancelled events" },
        private_properties: { type: "object", description: "Only events whose private properties have these values {name: value}" },
        created_by_plugin: { type: "boolean", description: "Only events created by this plugin" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_RESULTS, default: 50 },
        cursor: { type: "string", description: "next_cursor from the previous page" },
      },
    },
    run: listEvents,
  },
  {
    name: "get_event",
    title: "Get Google Calendar event",
    description: "Get one event with its times, attendees and their responses, Meet link and private properties.",
    parameters: {
      type: "object",
      properties: { calendar_id: CALENDAR_ID_PROPERTY, event_id: EVENT_ID_PROPERTY, time_zone: TIME_ZONE_PROPERTY },
      required: ["event_id"],
    },
    run: getEvent,
  },
  {
    name: "create_event",
    title: "Create Google Calendar event",
    description:
      "Create an event (timed or all-day) with optional guests, reminders and a Google Meet link. Pass idempotency_key to make retries safe; book_slot re-checks free/busy first and fails `conflict` if the time was taken or the key already booked another time.",
    parameters: {
      type: "object",
      properties: {
        calendar_id: CALENDAR_ID_PROPERTY,
        ...EVENT_FIELD_PROPERTIES,
        idempotency_key: { type: "string", minLength: 1, description: "Same key = same event: a repeat returns the existing event instead of a duplicate" },
        event_id: { type: "string", description: "Explicit new event id: 5-1024 characters of a-v and 0-9" },
        book_slot: { type: "boolean", default: false, description: "Re-check that the calendar is free for start-end right before creating" },
      },
      required: ["start"],
    },
    run: createEvent,
  },
  {
    name: "update_event",
    title: "Update Google Calendar event",
    description:
      "Change some fields of an event (PATCH): only the given fields change; `attendees` replaces the whole guest list. Agent tools may only update events this plugin created.",
    parameters: {
      type: "object",
      properties: { calendar_id: CALENDAR_ID_PROPERTY, event_id: EVENT_ID_PROPERTY, ...EVENT_FIELD_PROPERTIES },
      required: ["event_id"],
    },
    run: updateEvent,
  },
  {
    name: "delete_event",
    title: "Delete Google Calendar event",
    description: "Delete an event. Deleting one that is already deleted succeeds. Agent tools may only delete events this plugin created.",
    parameters: {
      type: "object",
      properties: { calendar_id: CALENDAR_ID_PROPERTY, event_id: EVENT_ID_PROPERTY, send_updates: SEND_UPDATES_PROPERTY },
      required: ["event_id"],
    },
    run: deleteEvent,
  },
  {
    name: "quick_add",
    title: "Quick add Google Calendar event",
    description: 'Create an event from text, e.g. "Lunch with Sari tomorrow 12:30-13:30 at Kopi Kenangan". Not retried after an unknown outcome.',
    parameters: {
      type: "object",
      properties: {
        calendar_id: CALENDAR_ID_PROPERTY,
        text: { type: "string", minLength: 1, description: "Event description in natural language (English works best)" },
        send_updates: SEND_UPDATES_PROPERTY,
      },
      required: ["text"],
    },
    run: quickAddEvent,
  },
];
