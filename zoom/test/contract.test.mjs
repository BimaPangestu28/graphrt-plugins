import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { FAKE_CREDENTIAL } from "../lib/shared/rest-contract-context.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearZoomTokenCache, primeZoomToken, ZOOM_TOKEN_URL } from "../lib/zoom-token.mjs";
import { decorateZoomDefinition, pluginDefinition, restDefinition } from "../definition.mjs";

const ZOOM = "https://api.zoom.us/v2";
const APP_ENVIRONMENT = { ZOOM_ACCOUNT_ID: "contract-account", ZOOM_CLIENT_ID: "contract-client" };
const CONTRACT_ENVIRONMENT = { ...APP_ENVIRONMENT, ZOOM_CLIENT_SECRET: FAKE_CREDENTIAL };
const PRIMED_TOKEN = "zoom-contract-access-token";
const page = (listField, items) => ({ body: { [listField]: items, next_page_token: "npt-2", page_size: 30 } });

// The contract harness answers only API requests, so the S2S token is put into the cache before every test.
beforeEach(() => {
  clearZoomTokenCache();
  primeZoomToken(CONTRACT_ENVIRONMENT, PRIMED_TOKEN);
});

// The tool allowlist of api_request is tested below; the generated api_request checks call arbitrary paths.
describeRestPluginContract(decorateZoomDefinition(restDefinition, { restrictApiRequest: false }), {
  environment: APP_ENVIRONMENT,
  checkAuth: (call) => assert.equal(call.headers.authorization, `Bearer ${PRIMED_TOKEN}`),
  operations: {
    get_me: { args: {}, request: { method: "GET", url: `${ZOOM}/users/me`, query: "absent" }, response: { body: { id: "u1", email: "ada@example.com" } }, expect: { data: { id: "u1", email: "ada@example.com" } } },
    list_users: {
      args: { status: "active", limit: 100 },
      request: { method: "GET", url: `${ZOOM}/users`, query: { status: "active", page_size: "100" } },
      response: page("users", [{ id: "u1" }]),
      expect: { data: [{ id: "u1" }] },
    },
    get_user: { args: { user_id: "ada@example.com" }, request: { method: "GET", url: `${ZOOM}/users/ada%40example.com`, query: "absent" } },
    list_meetings: {
      args: { user_id: "me", meeting_type: "upcoming", from: "2026-11-01", to: "2026-11-30" },
      request: { method: "GET", url: `${ZOOM}/users/me/meetings`, query: { type: "upcoming", from: "2026-11-01", to: "2026-11-30", page_size: "30" } },
      response: page("meetings", [{ id: 85746065432, topic: "Sync" }]),
      expect: { data: [{ id: 85746065432, topic: "Sync" }] },
    },
    get_meeting: { args: { meeting_id: "85746065432", show_previous_occurrences: true }, request: { method: "GET", url: `${ZOOM}/meetings/85746065432`, query: { show_previous_occurrences: "true" } } },
    create_meeting: {
      args: { user_id: "me", topic: "Weekly sync", meeting_type: 2, start_time: "2026-12-01T09:00:00", timezone: "Asia/Jakarta", duration: 30, waiting_room: true, auto_recording: "cloud" },
      request: {
        method: "POST",
        url: `${ZOOM}/users/me/meetings`,
        query: "absent",
        json: { topic: "Weekly sync", type: 2, start_time: "2026-12-01T09:00:00", duration: 30, timezone: "Asia/Jakarta", settings: { waiting_room: true, auto_recording: "cloud" } },
      },
      response: { status: 201, body: { id: 1, join_url: "https://zoom.us/j/1" } },
    },
    update_meeting: {
      args: { meeting_id: "85746065432", occurrence_id: "1648194360000", topic: "Moved", duration: 45, mute_upon_entry: true },
      request: { method: "PATCH", url: `${ZOOM}/meetings/85746065432`, query: { occurrence_id: "1648194360000" }, json: { topic: "Moved", duration: 45, settings: { mute_upon_entry: true } } },
      response: { status: 204, body: "" },
    },
    delete_meeting: {
      args: { meeting_id: "85746065432", cancel_meeting_reminder: false },
      request: { method: "DELETE", url: `${ZOOM}/meetings/85746065432`, query: { cancel_meeting_reminder: "false" }, body: "absent" },
      response: { status: 204, body: "" },
    },
    get_past_meeting: { args: { meeting_id: "4444AAAiAAAAAiAiAiiAii==" }, request: { method: "GET", url: `${ZOOM}/past_meetings/4444AAAiAAAAAiAiAiiAii%3D%3D`, query: "absent" } },
    list_past_meeting_instances: {
      args: { meeting_id: "85746065432" },
      request: { method: "GET", url: `${ZOOM}/past_meetings/85746065432/instances`, query: "absent" },
      response: { body: { meetings: [{ uuid: "u==", start_time: "2026-11-01T02:00:00Z" }] } },
      expect: { data: [{ uuid: "u==", start_time: "2026-11-01T02:00:00Z" }] },
    },
    list_past_meeting_participants: {
      args: { meeting_id: "/ajXp112QmuoKj4854875==", limit: 300 },
      request: { method: "GET", url: `${ZOOM}/past_meetings/%252FajXp112QmuoKj4854875%253D%253D/participants`, query: { page_size: "300" } },
      response: page("participants", [{ name: "Ada", join_time: "2026-11-01T02:00:00Z" }]),
      expect: { data: [{ name: "Ada", join_time: "2026-11-01T02:00:00Z" }] },
    },
    list_recordings: {
      args: { user_id: "me", from: "2026-11-01", to: "2026-11-19" },
      request: { method: "GET", url: `${ZOOM}/users/me/recordings`, query: { from: "2026-11-01", to: "2026-11-19", page_size: "30" } },
      response: page("meetings", [{ uuid: "r1", recording_files: [{ id: "f1", file_type: "MP4" }] }]),
    },
    get_meeting_recordings: { args: { meeting_id: "85746065432" }, request: { method: "GET", url: `${ZOOM}/meetings/85746065432/recordings`, query: "absent" } },
  },
});

async function runOperation(operationName, args, responses, { source = "tool", environment = CONTRACT_ENVIRONMENT } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("tool results never contain start links, recording links or passcodes; nodes get them", async () => {
  const meeting = { id: 1, join_url: "https://zoom.us/j/1?pwd=x", start_url: "https://zoom.us/s/1?zak=z", password: "123", recording_files: [{ id: "f1", download_url: "https://zoom.us/rec/download/a", play_url: "https://zoom.us/rec/play/a" }] };
  const asTool = await runOperation("get_meeting_recordings", { meeting_id: "1" }, [{ body: meeting }]);
  assert.deepEqual(asTool.output.data, { id: 1, join_url: "https://zoom.us/j/1?pwd=x", recording_files: [{ id: "f1" }] });
  const asNode = await runOperation("get_meeting_recordings", { meeting_id: "1" }, [{ body: meeting }], { source: "node" });
  assert.deepEqual(asNode.output.data, meeting);
});

test("api_request strips bearer fields for tools and refuses paths outside the read allowlist", async () => {
  const allowed = await runOperation("api_request", { path: "/users/me/upcoming_meetings" }, [{ body: { meetings: [{ topic: "t", start_url: "https://zoom.us/s/1" }] } }]);
  assert.deepEqual(allowed.output.data, { meetings: [{ topic: "t" }] });
  const refused = await runOperation("api_request", { path: "/users/me/token", query: { type: "zak" } }, [{ body: { token: "zak" } }]);
  assert.equal(refused.error.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const asNode = await runOperation("api_request", { path: "/users/me/token" }, [{ body: { token: "zak" } }], { source: "node" });
  assert.deepEqual(asNode.output.data, { token: "zak" });
});

test("delete_meeting is not offered to tools", async () => {
  const { error } = await runOperation("delete_meeting", { meeting_id: "1" }, [{ body: {} }]);
  assert.equal(error.kind, "invalid_input");
  assert.equal(pluginDefinition.operations.find((operation) => operation.name === "delete_meeting").nodeOnly, true);
});

test("without a cached token the run fetches one from the Zoom token URL with the run's fetch, then calls the API", async () => {
  clearZoomTokenCache();
  const recordingFetch = createRecordingFetch([{ body: { access_token: "fresh-token", expires_in: 3599 } }, { body: { id: "u1" } }]);
  const run = createOperationRunner(pluginDefinition, CONTRACT_ENVIRONMENT, { fetchImpl: recordingFetch });
  const output = await run("get_me", {}, { source: "node" });
  assert.equal(recordingFetch.calls[0].url, ZOOM_TOKEN_URL);
  assert.equal(recordingFetch.calls[1].url, `${ZOOM}/users/me`);
  assert.equal(recordingFetch.calls[1].headers.authorization, "Bearer fresh-token");
  assert.deepEqual(output.data, { id: "u1" });
});

test("a 401 from the API drops the cached token, so the next call fetches a new one", async () => {
  const unauthorized = await runOperation("get_me", {}, [{ status: 401, body: { code: 124, message: "Invalid access token." } }]);
  assert.equal(unauthorized.error.kind, "auth_error");
  assert.match(unauthorized.error.message, /Invalid access token/);
  const refreshed = await runOperation("get_me", {}, [{ body: { access_token: "new-token", expires_in: 3599 } }, { body: { id: "u1" } }]);
  assert.equal(refreshed.calls[0].url, ZOOM_TOKEN_URL);
  assert.equal(refreshed.calls[1].headers.authorization, "Bearer new-token");
});

test("a node access_token is sent as is, without a token request", async () => {
  clearZoomTokenCache();
  const { output, calls } = await runOperation("get_me", { access_token: "node-oauth-token" }, [{ body: { id: "u1" } }], { source: "node" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer node-oauth-token");
  assert.deepEqual(output.data, { id: "u1" });
});

test("create_meeting exposes no invitee, alternative-host or registrant fields", () => {
  const properties = Object.keys(pluginDefinition.operations.find((operation) => operation.name === "create_meeting").parameters.properties);
  for (const emailingField of ["meeting_invitees", "alternative_hosts", "settings", "registrants_email_notification"]) assert.equal(properties.includes(emailingField), false, emailingField);
});
