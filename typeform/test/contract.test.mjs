import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { pluginDefinition, restDefinition } from "../definition.mjs";

const API = "https://api.typeform.com";
const FORM = "u6nXL7";
const FORM_DEFINITION = { title: "Feedback", fields: [{ title: "Your name?", type: "short_text" }], settings: { is_public: false } };

describeRestPluginContract(restDefinition, {
  operations: {
    get_me: { args: {}, request: { method: "GET", url: `${API}/me`, query: "absent" }, response: { body: { alias: "ada", email: "ada@example.com" } } },
    list_forms: {
      args: { search: "feedback", workspace_id: "ws1", sort_by: "last_updated_at", order_by: "desc", limit: 20 },
      request: { method: "GET", url: `${API}/forms`, query: { search: "feedback", workspace_id: "ws1", sort_by: "last_updated_at", order_by: "desc", page_size: "20" } },
      response: { body: { total_items: 1, page_count: 1, items: [{ id: FORM, title: "Feedback" }] } },
      expect: { data: [{ id: FORM, title: "Feedback" }] },
    },
    get_form: { args: { form_id: FORM }, request: { method: "GET", url: `${API}/forms/${FORM}`, query: "absent" }, response: { body: { id: FORM, fields: [] } } },
    create_form: { args: { form: FORM_DEFINITION }, request: { method: "POST", url: `${API}/forms`, query: "absent", json: FORM_DEFINITION }, response: { status: 201, body: { id: "new1" } } },
    delete_form: { args: { form_id: FORM }, request: { method: "DELETE", url: `${API}/forms/${FORM}`, query: "absent", body: "absent" }, response: { status: 204 } },
    list_responses: {
      args: { form_id: FORM, since: "2026-11-01T00:00:00", response_type: ["partial", "completed"], search: "great", fields: ["f1", "f2"], limit: 25 },
      request: { method: "GET", url: `${API}/forms/${FORM}/responses`, query: { since: "2026-11-01T00:00:00", response_type: "partial,completed", query: "great", fields: "f1,f2", page_size: "25" } },
      response: { body: { total_items: 2, page_count: 1, items: [{ token: "t1", response_id: "t1" }, { token: "t2", response_id: "t2" }] } },
      expect: { data: [{ token: "t1", response_id: "t1" }, { token: "t2", response_id: "t2" }] },
    },
    delete_responses: {
      args: { form_id: FORM, included_response_ids: ["r1", "r2"] },
      request: { method: "DELETE", url: `${API}/forms/${FORM}/responses`, query: { included_response_ids: "r1,r2" }, body: "absent" },
    },
    get_insights_summary: { args: { form_id: FORM }, request: { method: "GET", url: `${API}/insights/${FORM}/summary`, query: "absent" } },
    list_workspaces: {
      args: { search: "Marketing" },
      request: { method: "GET", url: `${API}/workspaces`, query: { search: "Marketing", page_size: "50" } },
      response: { body: { total_items: 1, page_count: 1, items: [{ id: "ws1", name: "Marketing" }] } },
      expect: { data: [{ id: "ws1", name: "Marketing" }] },
    },
    get_workspace: { args: { workspace_id: "ws1" }, request: { method: "GET", url: `${API}/workspaces/ws1`, query: "absent" } },
  },
});

async function runTypeform(operationName, args, { source = "tool", environment = {}, responses = [{ body: { items: [] } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { TYPEFORM_TOKEN: "tfp_test_token_1", ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: deletes are node only; env is the token, base URL and create opt-in", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["delete_form", "delete_responses"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  assert.deepEqual([...manifest.permissions.env].sort(), ["TYPEFORM_BASE_URL", "TYPEFORM_TOKEN", "TYPEFORM_TOOL_ALLOW_CREATE"]);
});

test("list_responses pages to older responses with before=<last token>", async () => {
  const { output, error } = await runTypeform("list_responses", { form_id: FORM, limit: 2 }, { responses: [{ body: { items: [{ token: "t1" }, { token: "t2" }] } }] });
  if (error) throw error;
  assert.equal(output.next_cursor, "t2");
  const next = await runTypeform("list_responses", { form_id: FORM, limit: 2, cursor: "t2" }, { responses: [{ body: { items: [] } }] });
  if (next.error) throw next.error;
  assert.equal(new URL(next.calls[0].url).searchParams.get("before"), "t2");
  assert.equal(next.output.next_cursor, null);
});

test("TYPEFORM_BASE_URL switches to the EU data center; other hosts are refused before any request", async () => {
  const eu = await runTypeform("get_form", { form_id: FORM }, { environment: { TYPEFORM_BASE_URL: "https://api.eu.typeform.com" }, responses: [{ body: { id: FORM } }] });
  if (eu.error) throw eu.error;
  assert.equal(new URL(eu.calls[0].url).origin, "https://api.eu.typeform.com");
  assert.equal(eu.calls[0].headers.authorization, "Bearer tfp_test_token_1");
  const refused = await runTypeform("get_form", { form_id: FORM }, { environment: { TYPEFORM_BASE_URL: "https://evil.example" } });
  assert.equal(refused.error?.kind, "invalid_input");
  assert.equal(refused.calls.length, 0);
});

test("create_form as a tool needs TYPEFORM_TOOL_ALLOW_CREATE=1", async () => {
  const refused = await runTypeform("create_form", { form: FORM_DEFINITION });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const allowed = await runTypeform("create_form", { form: FORM_DEFINITION }, { environment: { TYPEFORM_TOOL_ALLOW_CREATE: "1" }, responses: [{ status: 201, body: { id: "new1" } }] });
  if (allowed.error) throw allowed.error;
  assert.equal(allowed.calls.length, 1);
});

test("api_request as a tool is limited to read paths: webhooks (signing secrets) are refused, nodes are not", async () => {
  const refused = await runTypeform("api_request", { path: `/forms/${FORM}/webhooks` });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const allowed = await runTypeform("api_request", { path: `/forms/${FORM}/messages` }, { responses: [{ body: { "label.buttonHint.default": "Press Enter" } }] });
  if (allowed.error) throw allowed.error;
  assert.equal(allowed.calls.length, 1);
  const node = await runTypeform("api_request", { path: `/forms/${FORM}/webhooks` }, { source: "node", responses: [{ body: { items: [] } }] });
  if (node.error) throw node.error;
  assert.equal(node.calls.length, 1);
});

test("Typeform error codes map to kinds (403 AUTHENTICATION_ERROR is an auth_error)", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [403, "auth_error", { code: "AUTHENTICATION_ERROR", description: "Authentication failed" }],
    [401, "auth_error", { code: "UNAUTHORIZED", description: "Authentication credentials not found on the Request Headers" }],
    [404, "not_found", { code: "NOT_EXISTING_ID", description: "Non existing form with uid u6nXL7" }],
    [402, "permission_denied", { code: "PAYMENT_REQUIRED", description: "This feature requires a PRO account" }],
    [400, "invalid_input", { code: "VALIDATION_ERROR", description: "Bad Request", details: [{ code: "WRONG_TYPE", field: "/fields/0/type" }] }],
  ];
  for (const [status, kind, body] of cases) {
    const parsed = parseDeclared(status, body);
    assert.equal(parsed.kind, kind, body.code);
    assert.match(parsed.message, new RegExp(body.description));
  }
});
