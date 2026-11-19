import { test } from "node:test";
import assert from "node:assert/strict";
import { isCalendlyToolReadPath, stripBearerLinks, toResourceUri, toResourceUuid } from "../lib/calendly-resources.mjs";

const USER_URI = "https://api.calendly.com/users/AAAAAAAAAAAAAAAA";

test("toResourceUri accepts a uuid or the resource's own URI", () => {
  assert.equal(toResourceUri("users", "AAAAAAAAAAAAAAAA", "user"), USER_URI);
  assert.equal(toResourceUri("users", USER_URI, "user"), USER_URI);
  assert.equal(toResourceUri("event_types", " 1b2c-3d ", "event_type"), "https://api.calendly.com/event_types/1b2c-3d");
  assert.equal(toResourceUri("users", undefined, "user"), undefined);
});

test("toResourceUri refuses other hosts, other collections and odd values", () => {
  for (const bad of ["https://evil.example/users/A", "https://api.calendly.com/organizations/A", "http://api.calendly.com/users/A", "a/b", "../x", "", "https://api.calendly.com/users/A/extra"]) {
    assert.throws(() => toResourceUri("users", bad, "user"), (error) => error.kind === "invalid_input", bad);
  }
});

test("toResourceUuid takes the uuid out of a URI and keeps a plain uuid", () => {
  assert.equal(toResourceUuid("scheduled_events", "https://api.calendly.com/scheduled_events/EV1", "event_uuid"), "EV1");
  assert.equal(toResourceUuid("scheduled_events", "EV1", "event_uuid"), "EV1");
  assert.equal(toResourceUuid("invitees", "https://api.calendly.com/scheduled_events/EV1/invitees/IN1", "invitee_uuid"), "IN1");
  assert.throws(() => toResourceUuid("users", "https://api.calendly.com/event_types/X", "user_uuid"), (error) => error.kind === "invalid_input");
});

test("stripBearerLinks removes invitee cancel and reschedule links at any depth", () => {
  const invitees = { collection: [{ email: "ada@example.com", cancel_url: "https://calendly.com/cancellations/x", reschedule_url: "https://calendly.com/reschedulings/x", status: "active" }] };
  assert.deepEqual(stripBearerLinks(invitees), { collection: [{ email: "ada@example.com", status: "active" }] });
  assert.equal(stripBearerLinks(null), null);
});

test("isCalendlyToolReadPath decodes before matching and refuses encoded slashes, backslashes and bad encodings", () => {
  for (const refused of ["/users/me%2Fwebhook_subscriptions", "/organizations/O1%2finvitations", "/users/me%5Cx", "/users/%2E%2E/webhook_subscriptions", "/users/me%E0%A4%A", "/%77ebhook_subscriptions"]) {
    assert.equal(isCalendlyToolReadPath(refused), false, refused);
  }
  assert.equal(isCalendlyToolReadPath("/%75sers/me"), true);
});

test("stripBearerLinks removes the meeting location password", () => {
  const event = { resource: { name: "Sync", location: { type: "zoom", join_url: "https://zoom.us/j/1", data: { id: 1, password: "secret-pass" } } } };
  assert.deepEqual(stripBearerLinks(event), { resource: { name: "Sync", location: { type: "zoom", join_url: "https://zoom.us/j/1", data: { id: 1 } } } });
});

test("isCalendlyToolReadPath allows scheduling reads and refuses webhooks, logs and unknown paths", () => {
  for (const allowed of ["/users/me", "/event_types?user=x", "/scheduled_events/E1/invitees", "/user_busy_times", "/organizations/O1", "/Event_Types/"]) assert.equal(isCalendlyToolReadPath(allowed), true, allowed);
  for (const refused of ["/webhook_subscriptions", "/activity_log_entries", "/organizations/O1/invitations", "/data_compliance/deletion/events", "/shares", "//users", "/users/../webhook_subscriptions"]) assert.equal(isCalendlyToolReadPath(refused), false, refused);
});
