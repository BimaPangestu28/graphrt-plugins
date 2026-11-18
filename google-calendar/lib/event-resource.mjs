/**
 * Builds Calendar Event request bodies from operation arguments and condenses Event resources
 * for output.
 */
import { rejectInput } from "./client.mjs";
import { isCreatedByPlugin, PLUGIN_CREATED_PROPERTY, PLUGIN_CREATED_VALUE } from "./tool-policy.mjs";
import { addDays, assertValidTimeZone, formatCalendarDate, normalizeDateTimeText, parseCalendarDate, parseInstant } from "./time-zones.mjs";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RECURRENCE_PATTERN = /^(RRULE|EXRULE|RDATE|EXDATE):/;
const MAX_REMINDERS = 5;
const MAX_REMINDER_MINUTES = 40320;
const MAX_ATTENDEES = 200;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

/**
 * Builds `start`/`end` from date or date-time strings. A date ("2026-11-20") makes an all-day
 * event; for those `end` is exclusive and defaults to the next day. Date-times are sent as
 * "YYYY-MM-DDTHH:MM:SS" plus the given offset (see normalizeDateTimeText).
 *
 * On a partial update each edge also clears the other kind of time (`date: null` next to a
 * `dateTime`, `dateTime: null, timeZone: null` next to a `date`), because PATCH merges the edge
 * into the stored one and Google rejects an edge holding both, e.g. when an all-day event becomes timed.
 *
 * @param args - `{start, end, time_zone}` (object)
 * @param options - `{isPartialUpdate}`; true on update, where either edge may be left out (object)
 * @returns `{start?, end?}` EventDateTime objects (object)
 * @throws PluginError kind `invalid_input`
 */
export function buildEventTimes({ start, end, time_zone: timeZone }, { isPartialUpdate = false } = {}) {
  if (timeZone !== undefined) assertValidTimeZone(timeZone);
  const isAllDay = [start, end].filter((value) => value !== undefined).some((value) => DATE_ONLY_PATTERN.test(value.trim()));
  const times = isAllDay ? buildAllDayTimes(start, end, isPartialUpdate) : buildTimedTimes({ start, end, timeZone }, isPartialUpdate);
  return isPartialUpdate ? clearOtherTimeKind(times) : times;
}

function buildTimedTimes({ start, end, timeZone }, isPartialUpdate) {
  if (!isPartialUpdate && end === undefined) rejectInput("`end` is required for an event with a time (only all-day events default their end)");
  const times = {};
  if (start !== undefined) times.start = buildTimedEdge(start, "start", timeZone);
  if (end !== undefined) times.end = buildTimedEdge(end, "end", timeZone);
  const readEdgeInstant = (edge, name) => parseInstant(edge.dateTime, { name, timeZone });
  if (times.start && times.end && readEdgeInstant(times.end, "end") <= readEdgeInstant(times.start, "start")) {
    rejectInput("`end` must be after `start`");
  }
  return times;
}

function buildAllDayTimes(start, end, isPartialUpdate) {
  const values = [start, end].filter((value) => value !== undefined);
  if (!values.every((value) => DATE_ONLY_PATTERN.test(value.trim()))) rejectInput("Use dates for both `start` and `end` (all-day) or date-times for both");
  const times = {};
  if (start !== undefined) times.start = { date: formatCalendarDate(parseCalendarDate(start, "start")) };
  if (end !== undefined) times.end = { date: formatCalendarDate(parseCalendarDate(end, "end")) };
  if (!isPartialUpdate && times.end === undefined) times.end = { date: formatCalendarDate(addDays(parseCalendarDate(start, "start"), 1)) };
  if (times.start && times.end && times.end.date <= times.start.date) {
    rejectInput("For all-day events `end` is exclusive and must be after `start` (e.g. start 2026-11-20, end 2026-11-21 for one day)");
  }
  return times;
}

function buildTimedEdge(value, name, timeZone) {
  const dateTime = normalizeDateTimeText(value, name);
  parseInstant(dateTime, { name, timeZone });
  return { dateTime, timeZone };
}

function clearOtherTimeKind(times) {
  const clearEdge = (edge) => (edge.date === undefined ? { ...edge, date: null } : { ...edge, dateTime: null, timeZone: null });
  return Object.fromEntries(Object.entries(times).map(([edgeName, edge]) => [edgeName, clearEdge(edge)]));
}

/**
 * Turns attendee arguments into Event attendees.
 *
 * @param attendees - Emails, or `{email, optional, display_name}` objects (Array)
 * @returns `[{email, optional?, displayName?}]` (Array)
 * @throws PluginError kind `invalid_input`
 */
export function buildAttendees(attendees) {
  if (attendees.length > MAX_ATTENDEES) rejectInput(`At most ${MAX_ATTENDEES} attendees`);
  return attendees.map((attendee, index) => {
    const attendeeObject = typeof attendee === "string" ? { email: attendee } : attendee;
    const email = typeof attendeeObject?.email === "string" ? attendeeObject.email.trim() : "";
    if (!EMAIL_PATTERN.test(email)) rejectInput(`\`attendees[${index}]\` needs an email address`);
    const optional = attendeeObject.optional === undefined ? undefined : Boolean(attendeeObject.optional);
    return { email, optional, displayName: attendeeObject.display_name };
  });
}

/**
 * Builds the `reminders` field.
 *
 * @param args - `{reminders, use_default_reminders}` (object)
 * @returns Event reminders, or undefined to leave them alone (object | undefined)
 * @throws PluginError kind `invalid_input`
 */
export function buildReminders({ reminders, use_default_reminders: useDefaultReminders }) {
  if (reminders === undefined) return useDefaultReminders === undefined ? undefined : { useDefault: useDefaultReminders };
  if (useDefaultReminders === true) rejectInput("Pass either `reminders` or `use_default_reminders: true`, not both");
  if (reminders.length > MAX_REMINDERS) rejectInput(`At most ${MAX_REMINDERS} reminders`);
  const overrides = reminders.map((reminder, index) => {
    const method = reminder?.method ?? "popup";
    const minutes = Number(reminder?.minutes);
    if (!["popup", "email"].includes(method)) rejectInput(`\`reminders[${index}].method\` must be popup or email`);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_REMINDER_MINUTES) {
      rejectInput(`\`reminders[${index}].minutes\` must be a whole number from 0 to ${MAX_REMINDER_MINUTES}`);
    }
    return { method, minutes };
  });
  return { useDefault: false, overrides };
}

/**
 * Checks recurrence lines (RFC 5545 RRULE/EXRULE/RDATE/EXDATE).
 *
 * @param recurrence - Lines like "RRULE:FREQ=WEEKLY;COUNT=4" (string[])
 * @param times - Result of buildEventTimes (object)
 * @returns The lines (string[])
 * @throws PluginError kind `invalid_input`
 */
export function validateRecurrence(recurrence, times) {
  recurrence.forEach((line, index) => {
    if (!RECURRENCE_PATTERN.test(line)) rejectInput(`\`recurrence[${index}]\` must start with RRULE:, EXRULE:, RDATE: or EXDATE:`);
  });
  if (times.start?.dateTime && !times.start.timeZone) rejectInput("Recurring events with a time need `time_zone` (Google requires it)");
  return recurrence;
}

/**
 * Validates private extended properties (string values; numbers and booleans are stringified).
 *
 * @param privateProperties - `{name: value}` (object)
 * @returns `{name: string}` (object)
 * @throws PluginError kind `invalid_input`
 */
export function normalizePrivateProperties(privateProperties) {
  return Object.fromEntries(
    Object.entries(privateProperties).map(([propertyName, propertyValue]) => {
      if (!["string", "number", "boolean"].includes(typeof propertyValue)) rejectInput(`\`private_properties.${propertyName}\` must be a string, number or boolean`);
      return [propertyName, String(propertyValue)];
    }),
  );
}

/**
 * Builds the shared Event fields used by create and update (only those given).
 *
 * @param args - Operation arguments (object)
 * @param options - `{isPartialUpdate}` (object)
 * @returns Partial Event resource (object)
 */
export function buildEventFields(args, { isPartialUpdate }) {
  const hasTimes = args.start !== undefined || args.end !== undefined;
  const times = hasTimes ? buildEventTimes(args, { isPartialUpdate }) : {};
  if (!hasTimes && args.time_zone !== undefined) rejectInput("`time_zone` applies to `start`/`end`; pass them too");
  return dropUndefined({
    summary: args.summary,
    description: args.description,
    location: args.location,
    ...times,
    attendees: args.attendees === undefined ? undefined : buildAttendees(args.attendees),
    reminders: buildReminders(args),
    recurrence: args.recurrence === undefined ? undefined : validateRecurrence(args.recurrence, times),
    transparency: args.transparency,
    visibility: args.visibility,
    colorId: args.color_id,
  });
}

/**
 * The private properties to write: the given ones plus the plugin's "created" tag.
 *
 * @param givenProperties - From arguments (object | undefined)
 * @param currentProperties - Already on the event, kept on update (object | undefined)
 * @param isTagged - Whether to set graphrt_created=1 (boolean)
 * @returns `{private: {...}}` or undefined when nothing is written (object | undefined)
 */
export function buildPrivateProperties(givenProperties, currentProperties, isTagged) {
  if (givenProperties === undefined && !isTagged) return undefined;
  const tag = isTagged ? { [PLUGIN_CREATED_PROPERTY]: PLUGIN_CREATED_VALUE } : {};
  return { private: { ...currentProperties, ...normalizePrivateProperties(givenProperties ?? {}), ...tag } };
}

/**
 * Condenses an Event resource.
 *
 * @param event - Event resource (object)
 * @returns Flat event summary (object)
 */
export function summarizeEvent(event) {
  const meetEntry = event?.conferenceData?.entryPoints?.find((entryPoint) => entryPoint.entryPointType === "video");
  return {
    event_id: event?.id ?? null,
    status: event?.status ?? null,
    summary: event?.summary ?? null,
    description: event?.description ?? null,
    location: event?.location ?? null,
    start: event?.start?.dateTime ?? event?.start?.date ?? null,
    end: event?.end?.dateTime ?? event?.end?.date ?? null,
    all_day: Boolean(event?.start?.date),
    time_zone: event?.start?.timeZone ?? null,
    html_link: event?.htmlLink ?? null,
    meet_link: meetEntry?.uri ?? event?.hangoutLink ?? null,
    conference_status: event?.conferenceData?.createRequest?.status?.statusCode ?? null,
    attendees: (event?.attendees ?? []).map(summarizeAttendee),
    organizer_email: event?.organizer?.email ?? null,
    recurrence: event?.recurrence ?? [],
    recurring_event_id: event?.recurringEventId ?? null,
    transparency: event?.transparency ?? "opaque",
    visibility: event?.visibility ?? "default",
    created_by_plugin: isCreatedByPlugin(event),
    private_properties: event?.extendedProperties?.private ?? {},
    updated: event?.updated ?? null,
  };
}

function summarizeAttendee(attendee) {
  return {
    email: attendee.email ?? null,
    display_name: attendee.displayName ?? null,
    response_status: attendee.responseStatus ?? null,
    optional: attendee.optional ?? false,
    organizer: attendee.organizer ?? false,
    self: attendee.self ?? false,
  };
}

function dropUndefined(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, fieldValue]) => fieldValue !== undefined));
}
