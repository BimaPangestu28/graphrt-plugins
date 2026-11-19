import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNoteArguments, NOTE_ASSOCIATION_TYPE_IDS } from "../lib/hubspot-notes.mjs";

const FIXED_NOW = new Date("2026-11-19T08:00:00.000Z");

test("default HubSpot note association type ids", () => {
  assert.deepEqual(NOTE_ASSOCIATION_TYPE_IDS, { contact_ids: 202, company_ids: 190, deal_ids: 214, ticket_ids: 228 });
});

test("builds properties and HUBSPOT_DEFINED associations from simple fields", () => {
  const noteArguments = buildNoteArguments({ body: "Called Ada", contact_ids: ["101"], deal_ids: ["7", "8"], owner_id: "55" }, FIXED_NOW);
  assert.deepEqual(noteArguments, {
    note_body: "Called Ada",
    note_timestamp: "2026-11-19T08:00:00.000Z",
    owner_id: "55",
    associations: [
      { to: { id: "101" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] },
      { to: { id: "7" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] },
      { to: { id: "8" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] },
    ],
  });
});

test("keeps a given timestamp and omits empty associations and owner", () => {
  const noteArguments = buildNoteArguments({ body: "x", timestamp: "2026-01-02T03:04:05Z" }, FIXED_NOW);
  assert.deepEqual(noteArguments, { note_body: "x", note_timestamp: "2026-01-02T03:04:05Z" });
});

test("refuses empty ids and unparseable timestamps", () => {
  assert.throws(() => buildNoteArguments({ body: "x", company_ids: [" "] }, FIXED_NOW), (error) => error.kind === "invalid_input" && /company_ids/.test(error.message));
  assert.throws(() => buildNoteArguments({ body: "x", timestamp: "yesterday" }, FIXED_NOW), (error) => error.kind === "invalid_input" && /timestamp/.test(error.message));
});
