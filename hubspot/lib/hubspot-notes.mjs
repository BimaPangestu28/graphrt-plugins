/**
 * Simple fields for HubSpot's `create_note`. A note is a CRM object (`notes`) whose text and time are the
 * properties `hs_note_body` and `hs_timestamp`, and which only shows on a record's timeline when it is associated
 * with it. The wrapper takes plain record id lists and builds the `associations` array with HubSpot's default
 * (HUBSPOT_DEFINED) note association type ids, and sets `hs_timestamp` to now when no timestamp is given.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

// https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide.md (note to object)
export const NOTE_ASSOCIATION_TYPE_IDS = Object.freeze({ contact_ids: 202, company_ids: 190, deal_ids: 214, ticket_ids: 228 });

const idList = (description) => ({ type: "array", items: { type: "string" }, maxItems: 100, description });

export const NOTE_FIELDS = {
  body: { type: "string", minLength: 1, description: "Note text (HTML allowed, up to 65,536 characters)" },
  timestamp: { type: "string", description: "When the note happened, ISO 8601 (default: now); sets its place on the timeline" },
  owner_id: { type: "string", description: "HubSpot owner id (from list_owners) to attribute the note to" },
  contact_ids: idList("Contact record ids to attach the note to"),
  company_ids: idList("Company record ids to attach the note to"),
  deal_ids: idList("Deal record ids to attach the note to"),
  ticket_ids: idList("Ticket record ids to attach the note to"),
};

/**
 * Builds the declarative create_note arguments from the simple fields.
 *
 * @param noteFields - `{body, timestamp?, owner_id?, contact_ids?, company_ids?, deal_ids?, ticket_ids?}` (object)
 * @param now - Time used when `timestamp` is missing (Date)
 * @returns `{note_body, note_timestamp, owner_id?, associations?}` (object)
 * @throws PluginError kind `invalid_input` - An id is empty or the timestamp cannot be parsed
 *
 * @example
 * buildNoteArguments({ body: "Called", contact_ids: ["101"] }, new Date());
 * // { note_body: "Called", note_timestamp: "...", associations: [{ to: { id: "101" }, types: [...202] }] }
 */
export function buildNoteArguments(noteFields, now) {
  const associations = Object.entries(NOTE_ASSOCIATION_TYPE_IDS).flatMap(([fieldName, associationTypeId]) =>
    readIdList(noteFields[fieldName], fieldName).map((recordId) => ({ to: { id: recordId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }] })),
  );
  return {
    note_body: noteFields.body,
    note_timestamp: readTimestamp(noteFields.timestamp, now),
    ...(noteFields.owner_id ? { owner_id: noteFields.owner_id } : {}),
    ...(associations.length > 0 ? { associations } : {}),
  };
}

function readIdList(recordIds, fieldName) {
  return (recordIds ?? []).map((recordId) => {
    const trimmed = String(recordId).trim();
    if (trimmed === "") throw new PluginError(`\`${fieldName}\` must hold non-empty record ids`, { kind: "invalid_input" });
    return trimmed;
  });
}

function readTimestamp(timestamp, now) {
  if (timestamp === undefined || timestamp === "") return now.toISOString();
  if (Number.isNaN(Date.parse(timestamp))) throw new PluginError(`\`timestamp\` must be an ISO 8601 date-time, e.g. 2026-11-19T08:00:00Z; got ${JSON.stringify(String(timestamp).slice(0, 50))}`, { kind: "invalid_input" });
  return timestamp;
}

/**
 * Wraps the declarative `create_note` (body `{properties: {hs_note_body, hs_timestamp, hubspot_owner_id}, associations}`).
 *
 * @param operation - Generated create_note operation (object)
 * @returns Operation taking the simple NOTE_FIELDS (object)
 */
export function wrapCreateNote(operation) {
  return {
    ...operation,
    parameters: { type: "object", properties: NOTE_FIELDS, required: ["body"] },
    run: (context) => operation.run({ ...context, args: buildNoteArguments(context.args, new Date()) }),
  };
}

