/**
 * Calendar and availability operations: list calendars, raw free/busy, and free-slot search
 * (free/busy from Google, slots computed in lib/free-slots.mjs).
 */
import { rejectInput } from "../lib/client.mjs";
import { computeFreeSlots, DEFAULT_WORKING_HOURS } from "../lib/free-slots.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { assertCalendarAllowedForTool, readToolCalendarAccess } from "../lib/tool-policy.mjs";
import { assertValidTimeZone, parseInstant } from "../lib/time-zones.mjs";

const MAX_FREE_BUSY_CALENDARS = 50;
const MAX_CALENDAR_LIST_RESULTS = 250;
const MAX_SLOTS = 200;
const MS_PER_MINUTE = 60000;

export const CALENDAR_ID_PROPERTY = {
  type: "string",
  default: "primary",
  description: 'Calendar id: "primary" (the account\'s main calendar) or an id from list_calendars',
};
export const TIME_ZONE_PROPERTY = { type: "string", description: "IANA time zone, e.g. Asia/Jakarta" };
const CALENDAR_IDS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  maxItems: MAX_FREE_BUSY_CALENDARS,
  default: ["primary"],
  description: "Calendars (or people's calendar emails) to check",
};
const TIME_RANGE_PROPERTIES = {
  time_min: { type: "string", description: "Range start: RFC 3339 (2026-11-20T00:00:00+07:00) or a local date/date-time read in time_zone" },
  time_max: { type: "string", description: "Range end (exclusive), same forms" },
};

/**
 * Turns a range bound into the UTC RFC 3339 form Calendar expects.
 *
 * @param value - Date-time or date text, or undefined (string)
 * @param name - Argument name for errors (string)
 * @param timeZone - Zone for local values (string, optional)
 * @returns ISO string, or undefined when value is undefined (string | undefined)
 * @throws PluginError kind `invalid_input`
 */
export function normalizeTimeBound(value, name, timeZone) {
  return value === undefined ? undefined : new Date(parseInstant(value, { name, timeZone })).toISOString();
}

/**
 * Calls freeBusy.query (a read sent as POST, so it is marked idempotent and retried like a GET).
 *
 * @param options - `{client, calendarIds, timeMin, timeMax, timeZone, signal}`; times are RFC 3339 (object)
 * @returns FreeBusy response (Promise<object>)
 */
export function queryFreeBusy({ client, calendarIds, timeMin, timeMax, timeZone, signal }) {
  const json = { timeMin, timeMax, timeZone, items: calendarIds.map((calendarId) => ({ id: calendarId })) };
  return client.request({ method: "POST", path: "/freeBusy", json, signal, idempotent: true });
}

function readCalendarIds(args, context) {
  if (args.calendar_ids.length === 0) rejectInput("`calendar_ids` must contain at least one calendar");
  args.calendar_ids.forEach((calendarId) => assertCalendarAllowedForTool(context, calendarId));
  return args.calendar_ids;
}

function summarizeFreeBusyCalendars(freeBusy) {
  return Object.entries(freeBusy?.calendars ?? {}).map(([calendarId, calendarResult]) => ({
    calendar_id: calendarId,
    busy: (calendarResult.busy ?? []).map((busy) => ({ start: busy.start, end: busy.end })),
    errors: (calendarResult.errors ?? []).map((calendarError) => ({ domain: calendarError.domain ?? null, reason: calendarError.reason ?? null })),
  }));
}

function summarizeCalendar(calendarEntry, toolCalendarAccess) {
  return {
    calendar_id: calendarEntry.id ?? null,
    summary: calendarEntry.summaryOverride ?? calendarEntry.summary ?? null,
    description: calendarEntry.description ?? null,
    time_zone: calendarEntry.timeZone ?? null,
    access_role: calendarEntry.accessRole ?? null,
    primary: calendarEntry.primary ?? false,
    hidden: calendarEntry.hidden ?? false,
    agent_tool_allowed: toolCalendarAccess.isAllowed(calendarEntry.id) || (Boolean(calendarEntry.primary) && toolCalendarAccess.isAllowed("primary")),
  };
}

async function listCalendars({ client, args, signal, environment }) {
  const query = { maxResults: args.limit, pageToken: args.cursor, minAccessRole: args.min_access_role, showHidden: args.show_hidden };
  const calendarList = await client.request({ path: "/users/me/calendarList", query, signal });
  const toolCalendarAccess = readToolCalendarAccess(environment);
  const calendars = (calendarList?.items ?? []).map((calendarEntry) => summarizeCalendar(calendarEntry, toolCalendarAccess));
  return { data: { calendars }, next_cursor: calendarList?.nextPageToken ?? null };
}

async function queryFreeBusyOperation({ client, args, signal, source, environment }) {
  const calendarIds = readCalendarIds(args, { source, environment });
  if (args.time_zone !== undefined) assertValidTimeZone(args.time_zone);
  const timeMin = normalizeTimeBound(args.time_min, "time_min", args.time_zone);
  const timeMax = normalizeTimeBound(args.time_max, "time_max", args.time_zone);
  if (Date.parse(timeMax) <= Date.parse(timeMin)) rejectInput("`time_max` must be after `time_min`");
  const freeBusy = await queryFreeBusy({ client, calendarIds, timeMin, timeMax, timeZone: args.time_zone, signal });
  return { data: { time_min: freeBusy?.timeMin ?? timeMin, time_max: freeBusy?.timeMax ?? timeMax, calendars: summarizeFreeBusyCalendars(freeBusy) } };
}

async function resolveSearchTimeZone({ client, args, signal }) {
  if (args.time_zone !== undefined) return assertValidTimeZone(args.time_zone);
  const timeZoneSetting = await client.request({ path: "/users/me/settings/timezone", signal });
  return assertValidTimeZone(timeZoneSetting?.value);
}

function buildSlotRequest(args, timeZone) {
  return {
    timeMin: args.time_min,
    timeMax: args.time_max,
    timeZone,
    durationMinutes: args.duration_minutes,
    workingHours: args.working_hours,
    bufferMinutes: args.buffer_minutes,
    slotStepMinutes: args.slot_step_minutes,
    maxSlots: args.max_slots,
  };
}

// Calendars Google could not read (not shared, unknown) would make every slot look free.
function collectBusyIntervals(freeBusy, calendarIds) {
  const calendarResults = summarizeFreeBusyCalendars(freeBusy);
  const failedCalendars = calendarResults.filter((calendarResult) => calendarResult.errors.length > 0);
  if (failedCalendars.length > 0) {
    const details = failedCalendars.map((calendarResult) => `${calendarResult.calendar_id}: ${calendarResult.errors.map((calendarError) => calendarError.reason).join(", ")}`);
    const isNotFound = failedCalendars.every((calendarResult) => calendarResult.errors.every((calendarError) => calendarError.reason === "notFound"));
    throw new PluginError(`Free/busy is unavailable for ${details.join("; ")}; no slots were computed`, { kind: isNotFound ? "not_found" : "api_error" });
  }
  if (calendarResults.length === 0 && calendarIds.length > 0) throw new PluginError("Google returned no free/busy data; no slots were computed", { kind: "api_error" });
  return calendarResults.flatMap((calendarResult) => calendarResult.busy);
}

async function findFreeSlots({ client, args, signal, source, environment }) {
  const calendarIds = readCalendarIds(args, { source, environment });
  const timeZone = await resolveSearchTimeZone({ client, args, signal });
  const slotRequest = buildSlotRequest(args, timeZone);
  computeFreeSlots({ ...slotRequest, busy: args.extra_busy }); // Validates every input before calling Google.
  const bufferMs = (args.buffer_minutes ?? 0) * MS_PER_MINUTE;
  const timeMin = new Date(parseInstant(args.time_min, { name: "time_min", timeZone }) - bufferMs).toISOString();
  const timeMax = new Date(parseInstant(args.time_max, { name: "time_max", timeZone }) + bufferMs).toISOString();
  const freeBusy = await queryFreeBusy({ client, calendarIds, timeMin, timeMax, signal });
  const busy = [...collectBusyIntervals(freeBusy, calendarIds), ...(args.extra_busy ?? [])];
  const { slots, truncated } = computeFreeSlots({ ...slotRequest, busy });
  return { data: { time_zone: timeZone, duration_minutes: args.duration_minutes, slots, truncated, calendar_ids: calendarIds, busy_interval_count: busy.length } };
}

export const calendarOperations = [
  {
    name: "list_calendars",
    title: "List Google calendars",
    description: "List the calendars on the account's calendar list with id, name, time zone and access role, and whether agent tools may use each one.",
    parameters: {
      type: "object",
      properties: {
        min_access_role: { type: "string", enum: ["freeBusyReader", "reader", "writer", "owner"], description: "Only calendars with at least this role" },
        show_hidden: { type: "boolean", description: "Include calendars hidden from the list" },
        limit: { type: "integer", minimum: 1, maximum: MAX_CALENDAR_LIST_RESULTS, default: 100 },
        cursor: { type: "string", description: "next_cursor from the previous page" },
      },
    },
    run: listCalendars,
  },
  {
    name: "query_free_busy",
    title: "Query Google Calendar free/busy",
    description: "Get busy intervals for up to 50 calendars in a time range. Per-calendar errors (e.g. notFound when not shared) are returned, not thrown.",
    parameters: {
      type: "object",
      properties: { calendar_ids: CALENDAR_IDS_PROPERTY, ...TIME_RANGE_PROPERTIES, time_zone: TIME_ZONE_PROPERTY },
      required: ["time_min", "time_max"],
    },
    run: queryFreeBusyOperation,
  },
  {
    name: "find_free_slots",
    title: "Find free Google Calendar slots",
    description:
      "Find meeting slots of `duration_minutes` when every listed calendar is free, inside working hours (default Mon-Fri 09:00-17:00 in time_zone), with optional buffers around busy time. Range up to 62 days.",
    parameters: {
      type: "object",
      properties: {
        calendar_ids: CALENDAR_IDS_PROPERTY,
        ...TIME_RANGE_PROPERTIES,
        duration_minutes: { type: "integer", minimum: 1, maximum: 1440, description: "Slot length in minutes" },
        time_zone: { ...TIME_ZONE_PROPERTY, description: "IANA zone for working hours and results; default the account's Calendar setting" },
        working_hours: {
          type: "object",
          default: DEFAULT_WORKING_HOURS,
          description: 'Windows per weekday, e.g. {"mon": ["09:00-12:00", "13:00-17:00"], "sat": ["10:00-14:00"]}; days left out have no slots',
        },
        buffer_minutes: { type: "integer", minimum: 0, maximum: 1440, default: 0, description: "Free time to keep before and after busy time" },
        slot_step_minutes: { type: "integer", minimum: 1, maximum: 1440, default: 30, description: "Spacing of candidate start times from each window's start" },
        max_slots: { type: "integer", minimum: 1, maximum: MAX_SLOTS, default: 20 },
        extra_busy: { type: "array", description: 'More busy time [{"start", "end"}] as date-times, or dates for whole days' },
      },
      required: ["time_min", "time_max", "duration_minutes"],
    },
    run: findFreeSlots,
  },
];
