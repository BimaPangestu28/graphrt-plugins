import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { decorateCalendlyDefinition, pluginDefinition, restDefinition } from "../definition.mjs";

const API = "https://api.calendly.com";
const USER_URI = `${API}/users/USER1`;
const ORG_URI = `${API}/organizations/ORG1`;
const EVENT_TYPE_URI = `${API}/event_types/ET1`;
const page = (items) => ({ body: { collection: items, pagination: { count: 1, next_page: `${API}/x?page_token=tok2`, next_page_token: "tok2" } } });

// The tool allowlist of api_request is tested below; the generated api_request checks call arbitrary paths.
describeRestPluginContract(decorateCalendlyDefinition(restDefinition, { restrictApiRequest: false }), {
  operations: {
    get_me: {
      args: {},
      request: { method: "GET", url: `${API}/users/me`, query: "absent" },
      response: { body: { resource: { uri: USER_URI, current_organization: ORG_URI } } },
      expect: { data: { uri: USER_URI, current_organization: ORG_URI } },
    },
    get_user: { args: { user_uuid: USER_URI }, request: { method: "GET", url: `${API}/users/USER1`, query: "absent" } },
    list_organization_memberships: {
      args: { organization: "ORG1", role: "admin" },
      request: { method: "GET", url: `${API}/organization_memberships`, query: { organization: ORG_URI, role: "admin", count: "20" } },
      response: page([{ user: { email: "ada@example.com" } }]),
      expect: { data: [{ user: { email: "ada@example.com" } }] },
    },
    list_event_types: {
      args: { user: "USER1", active: true, limit: 50 },
      request: { method: "GET", url: `${API}/event_types`, query: { user: USER_URI, active: "true", count: "50" } },
      response: page([{ uri: EVENT_TYPE_URI, name: "30 min" }]),
    },
    get_event_type: { args: { event_type_uuid: "ET1" }, request: { method: "GET", url: `${API}/event_types/ET1`, query: "absent" } },
    list_available_times: {
      args: { event_type: EVENT_TYPE_URI, start_time: "2026-12-01T00:00:00Z", end_time: "2026-12-07T00:00:00Z" },
      request: { method: "GET", url: `${API}/event_type_available_times`, query: { event_type: EVENT_TYPE_URI, start_time: "2026-12-01T00:00:00Z", end_time: "2026-12-07T00:00:00Z" } },
      response: { body: { collection: [{ status: "available", start_time: "2026-12-01T02:00:00Z" }] } },
      expect: { data: [{ status: "available", start_time: "2026-12-01T02:00:00Z" }] },
    },
    list_scheduled_events: {
      args: { organization: ORG_URI, status: "active", min_start_time: "2026-11-19T00:00:00Z", sort: "start_time:asc" },
      request: { method: "GET", url: `${API}/scheduled_events`, query: { organization: ORG_URI, status: "active", min_start_time: "2026-11-19T00:00:00Z", sort: "start_time:asc", count: "20" } },
      response: page([{ uri: `${API}/scheduled_events/EV1` }]),
    },
    get_scheduled_event: { args: { event_uuid: `${API}/scheduled_events/EV1` }, request: { method: "GET", url: `${API}/scheduled_events/EV1`, query: "absent" } },
    list_invitees: {
      args: { event_uuid: "EV1", status: "active" },
      request: { method: "GET", url: `${API}/scheduled_events/EV1/invitees`, query: { status: "active", count: "20" } },
      response: page([{ email: "ada@example.com" }]),
    },
    get_invitee: {
      args: { event_uuid: "EV1", invitee_uuid: `${API}/scheduled_events/EV1/invitees/IN1` },
      request: { method: "GET", url: `${API}/scheduled_events/EV1/invitees/IN1`, query: "absent" },
    },
    list_availability_schedules: { args: { user: "USER1" }, request: { method: "GET", url: `${API}/user_availability_schedules`, query: { user: USER_URI } } },
    list_busy_times: {
      args: { user: USER_URI, start_time: "2026-12-01T00:00:00Z", end_time: "2026-12-07T00:00:00Z" },
      request: { method: "GET", url: `${API}/user_busy_times`, query: { user: USER_URI, start_time: "2026-12-01T00:00:00Z", end_time: "2026-12-07T00:00:00Z" } },
    },
    create_scheduling_link: {
      args: { event_type: "ET1" },
      request: { method: "POST", url: `${API}/scheduling_links`, query: "absent", json: { owner: EVENT_TYPE_URI, max_event_count: 1, owner_type: "EventType" } },
      response: { status: 201, body: { resource: { booking_url: "https://calendly.com/d/abc-123" } } },
      expect: { data: { booking_url: "https://calendly.com/d/abc-123" } },
    },
    book_meeting: {
      args: { event_type: "ET1", start_time: "2026-12-01T02:00:00Z", invitee_email: "ada@example.com", invitee_timezone: "Asia/Jakarta", invitee_name: "Ada", location: { kind: "zoom_conference" } },
      request: {
        method: "POST",
        url: `${API}/invitees`,
        query: "absent",
        json: { event_type: EVENT_TYPE_URI, start_time: "2026-12-01T02:00:00Z", invitee: { email: "ada@example.com", timezone: "Asia/Jakarta", name: "Ada" }, location: { kind: "zoom_conference" } },
      },
      response: { status: 201, body: { resource: { uri: `${API}/scheduled_events/EV2/invitees/IN2` } } },
    },
    cancel_event: {
      args: { event_uuid: "EV1", reason: "Host unavailable" },
      request: { method: "POST", url: `${API}/scheduled_events/EV1/cancellation`, query: "absent", json: { reason: "Host unavailable" } },
      response: { status: 201, body: { resource: { canceler_type: "host" } } },
    },
  },
});

async function runOperation(operationName, args, responses, { source = "tool", environment = {} } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { CALENDLY_ACCESS_TOKEN: "pat-1", ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("tool results have no invitee cancel or reschedule links; nodes keep them", async () => {
  const invitee = { email: "ada@example.com", cancel_url: "https://calendly.com/cancellations/x", reschedule_url: "https://calendly.com/reschedulings/x" };
  const asTool = await runOperation("list_invitees", { event_uuid: "EV1" }, [page([invitee])]);
  assert.deepEqual(asTool.output.data, [{ email: "ada@example.com" }]);
  assert.equal(asTool.output.next_cursor, "tok2");
  const asNode = await runOperation("list_invitees", { event_uuid: "EV1" }, [page([invitee])], { source: "node" });
  assert.deepEqual(asNode.output.data, [invitee]);
});

test("list_event_types and list_scheduled_events need a user or organization before any request", async () => {
  for (const operationName of ["list_event_types", "list_scheduled_events"]) {
    const { error, calls } = await runOperation(operationName, {}, [page([])]);
    assert.equal(error.kind, "invalid_input");
    assert.match(error.message, /user.*organization/);
    assert.equal(calls.length, 0);
  }
});

test("references to other hosts or collections are refused before any request", async () => {
  for (const args of [{ user: "https://evil.example/users/X" }, { user: `${API}/organizations/ORG1` }, { organization: "ORG/../1" }]) {
    const { error, calls } = await runOperation("list_event_types", args, [page([])]);
    assert.equal(error.kind, "invalid_input", JSON.stringify(args));
    assert.equal(calls.length, 0);
  }
  const { error } = await runOperation("get_scheduled_event", { event_uuid: `${API}/event_types/ET1` }, [{ body: {} }]);
  assert.equal(error.kind, "invalid_input");
});

test("scheduling links and bookings need their opt-in as tools; cancel_event is node only", async () => {
  const link = await runOperation("create_scheduling_link", { event_type: "ET1" }, [{ body: { resource: {} } }]);
  assert.equal(link.error.kind, "permission_denied");
  assert.match(link.error.message, /CALENDLY_TOOL_ALLOW_SCHEDULING_LINK/);
  const allowed = await runOperation("create_scheduling_link", { event_type: "ET1" }, [{ body: { resource: { booking_url: "https://calendly.com/d/x" } } }], { environment: { CALENDLY_TOOL_ALLOW_SCHEDULING_LINK: "1" } });
  assert.deepEqual(allowed.output.data, { booking_url: "https://calendly.com/d/x" });
  const booking = await runOperation("book_meeting", { event_type: "ET1", start_time: "2026-12-01T02:00:00Z", invitee_email: "a@example.com", invitee_timezone: "UTC" }, [{ body: {} }]);
  assert.equal(booking.error.kind, "permission_denied");
  assert.match(booking.error.message, /CALENDLY_TOOL_ALLOW_BOOKING/);
  const cancel = await runOperation("cancel_event", { event_uuid: "EV1" }, [{ body: {} }]);
  assert.equal(cancel.error.kind, "invalid_input");
  assert.equal(cancel.calls.length, 0);
});

test("api_request as a tool reads scheduling paths and refuses webhook subscriptions", async () => {
  const allowed = await runOperation("api_request", { path: "/scheduled_events/EV1/invitees" }, [{ body: { collection: [{ email: "a@example.com", cancel_url: "https://calendly.com/c" }] } }]);
  assert.deepEqual(allowed.output.data, { collection: [{ email: "a@example.com" }] });
  const refused = await runOperation("api_request", { path: "/webhook_subscriptions", query: { scope: "user" } }, [{ body: {} }]);
  assert.equal(refused.error.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
});

test("Calendly's {title, message} errors keep the message and map the title", async () => {
  const { error } = await runOperation("get_me", {}, [{ status: 401, body: { title: "Unauthenticated", message: "The access token is invalid" } }]);
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /The access token is invalid \(Unauthenticated\)/);
});
