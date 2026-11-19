import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { clearCachedAccessTokens } from "../lib/google-auth.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://forms.googleapis.com/v1";
const FORM = "1FAIpQLSf-abc_123";

describeRestPluginContract(pluginDefinition, {
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `Bearer ${credential}`),
  operations: {
    get_form: {
      args: { form_id: FORM },
      request: { method: "GET", url: `${API}/forms/${FORM}`, query: "absent" },
      response: { body: { formId: FORM, info: { title: "Signup" }, revisionId: "r1" } },
      expect: { data: { formId: FORM, info: { title: "Signup" }, revisionId: "r1" } },
    },
    create_form: {
      args: { form_title: "Event signup", document_title: "Signup 2026", unpublished: true },
      request: { method: "POST", url: `${API}/forms`, query: { unpublished: "true" }, json: { info: { title: "Event signup", documentTitle: "Signup 2026" } } },
      response: { body: { formId: "new1" } },
    },
    batch_update: {
      args: { form_id: FORM, requests: [{ deleteItem: { location: { index: 0 } } }], required_revision_id: "r1", include_form_in_response: true },
      request: {
        method: "POST",
        url: `${API}/forms/${FORM}:batchUpdate`,
        query: "absent",
        json: { requests: [{ deleteItem: { location: { index: 0 } } }], includeFormInResponse: true, writeControl: { requiredRevisionId: "r1" } },
      },
    },
    set_publish_settings: {
      args: { form_id: FORM, is_published: true, is_accepting_responses: false },
      request: {
        method: "POST",
        url: `${API}/forms/${FORM}:setPublishSettings`,
        query: "absent",
        json: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: false } }, updateMask: "publishState" },
      },
    },
    list_responses: {
      args: { form_id: FORM, filter: "timestamp > 2026-11-01T00:00:00Z", limit: 50 },
      request: { method: "GET", url: `${API}/forms/${FORM}/responses`, query: { filter: "timestamp > 2026-11-01T00:00:00Z", pageSize: "50" } },
      response: { body: { responses: [{ responseId: "a1" }], nextPageToken: "p2" } },
      expect: { data: [{ responseId: "a1" }] },
    },
    get_response: { args: { form_id: FORM, response_id: "a1" }, request: { method: "GET", url: `${API}/forms/${FORM}/responses/a1`, query: "absent" } },
    list_watches: {
      args: { form_id: FORM },
      request: { method: "GET", url: `${API}/forms/${FORM}/watches`, query: "absent" },
      response: { body: { watches: [{ id: "w1", eventType: "RESPONSES" }] } },
      expect: { data: [{ id: "w1", eventType: "RESPONSES" }] },
    },
    create_watch: {
      args: { form_id: FORM, topic_name: "projects/p1/topics/forms", event_type: "RESPONSES", watch_id: "new-responses" },
      request: {
        method: "POST",
        url: `${API}/forms/${FORM}/watches`,
        query: "absent",
        json: { watch: { target: { topic: { topicName: "projects/p1/topics/forms" } }, eventType: "RESPONSES" }, watchId: "new-responses" },
      },
    },
    renew_watch: { args: { form_id: FORM, watch_id: "w1" }, request: { method: "POST", url: `${API}/forms/${FORM}/watches/w1:renew`, query: "absent", body: "absent" } },
    delete_watch: { args: { form_id: FORM, watch_id: "w1" }, request: { method: "DELETE", url: `${API}/forms/${FORM}/watches/w1`, query: "absent", body: "absent" } },
  },
});

afterEach(() => clearCachedAccessTokens());

async function runForms(operationName, args, { source = "tool", environment = {} } = {}) {
  const recordingFetch = createRecordingFetch([{ body: { formId: FORM } }]);
  const run = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: "ya29.forms-token-1", ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: Google credentials and both opt-ins are allowed env; watch changes are node only", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env.sort(), [
    "GOOGLE_ACCESS_TOKEN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_FORMS_TOOL_ALLOW_EDIT",
    "GOOGLE_FORMS_TOOL_ALLOW_PUBLISH",
    "GOOGLE_REFRESH_TOKEN",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
  ]);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["create_watch", "renew_watch", "delete_watch"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  for (const toolName of ["get_form", "list_responses", "create_form", "batch_update", "set_publish_settings"]) assert.equal(toolNames.includes(toolName), true, toolName);
});

test("batch_update and set_publish_settings as tools need their opt-ins", async () => {
  const editArgs = { form_id: FORM, requests: [{ deleteItem: { location: { index: 0 } } }] };
  const publishArgs = { form_id: FORM, is_published: true, is_accepting_responses: true };
  for (const [operationName, args, optInEnv] of [["batch_update", editArgs, "GOOGLE_FORMS_TOOL_ALLOW_EDIT"], ["set_publish_settings", publishArgs, "GOOGLE_FORMS_TOOL_ALLOW_PUBLISH"]]) {
    const refused = await runForms(operationName, args);
    assert.equal(refused.error?.kind, "permission_denied", operationName);
    assert.equal(refused.calls.length, 0);
    const allowed = await runForms(operationName, args, { environment: { [optInEnv]: "1" } });
    if (allowed.error) throw allowed.error;
    assert.equal(allowed.calls.length, 1);
  }
});

test("create_form as a tool always creates the form unpublished; nodes choose", async () => {
  for (const unpublished of [undefined, false, "false"]) {
    const { error, calls } = await runForms("create_form", { form_title: "Signup", ...(unpublished === undefined ? {} : { unpublished }) });
    if (error) throw error;
    assert.equal(new URL(calls[0].url).searchParams.get("unpublished"), "true", String(unpublished));
  }
  const fromNode = await runForms("create_form", { form_title: "Signup" }, { source: "node" });
  if (fromNode.error) throw fromNode.error;
  assert.equal(new URL(fromNode.calls[0].url).searchParams.has("unpublished"), false);
});

test("a node's access_token wins; no credential at all is an auth_error before any request", async () => {
  const { calls } = await runForms("get_form", { form_id: FORM, access_token: "ya29.node-token-1" }, { source: "node" });
  assert.equal(calls[0].headers.authorization, "Bearer ya29.node-token-1");
  const recordingFetch = createRecordingFetch([]);
  const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
  await assert.rejects(run("get_form", { form_id: FORM }, { source: "tool" }), (error) => error.kind === "auth_error" && /GOOGLE_REFRESH_TOKEN/.test(error.message));
  assert.equal(recordingFetch.calls.length, 0);
});

test("Forms errors map by error.status", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [403, "permission_denied", { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }],
    [404, "not_found", { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }],
    [400, "invalid_input", { error: { code: 400, message: "Invalid requests[0].deleteItem", status: "INVALID_ARGUMENT" } }],
    [403, "rate_limited", { error: { code: 403, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }],
    [401, "auth_error", { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }],
  ];
  for (const [status, kind, body] of cases) {
    assert.equal(parseDeclared(status, body).kind, kind, body.error.status);
  }
});
