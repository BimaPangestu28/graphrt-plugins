import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { isAllowedReadPath, normalizeApiPath, stripUserSecrets } from "../lib/todoist-policy.mjs";
import { pluginDefinition } from "../definition.mjs";

const TOKEN = "todoist-test-token-0001";

async function runOperation(operationName, args, { responses = [{ body: {} }], source = "tool" } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { TODOIST_API_TOKEN: TOKEN }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

const userBody = { id: "u1", full_name: "Ada", token: "0123456789abcdef", websocket_url: "wss://ws.todoist.com/ws?token=0123456789abcdef", inbox_project_id: "p0" };

test("get_user drops the account token and the token-bearing websocket URL, for tools and nodes", async () => {
  for (const source of ["tool", "node"]) {
    const { output } = await runOperation("get_user", {}, { source, responses: [{ body: userBody }] });
    assert.deepEqual(output.data, { id: "u1", full_name: "Ada", inbox_project_id: "p0" });
  }
});

test("stripUserSecrets leaves non-objects alone", () => {
  assert.equal(stripUserSecrets(null), null);
  assert.deepEqual(stripUserSecrets([1]), [1]);
});

test("Todoist error bodies map by error_tag and keep the message", async () => {
  const { error } = await runOperation("get_task", { task_id: "t1" }, { responses: [{ status: 401, body: { error_tag: "UNAUTHORIZED", error_code: 477, error: "Unauthorized", http_code: 401 } }] });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /Unauthorized \(UNAUTHORIZED\)/);
});

test("list cursors follow next_cursor and stop when it is null", async () => {
  const first = await runOperation("list_projects", {}, { responses: [{ body: { results: [{ id: "p1" }], next_cursor: "cur2" } }] });
  assert.equal(first.output.next_cursor, "cur2");
  const last = await runOperation("list_projects", { cursor: "cur2" }, { responses: [{ body: { results: [], next_cursor: null } }] });
  assert.equal(new URL(last.calls[0].url).searchParams.get("cursor"), "cur2");
  assert.equal(last.output.next_cursor, null);
});

test("close_task is never retried after a 5xx (a recurring task would skip an occurrence)", async () => {
  const { error, calls } = await runOperation("close_task", { task_id: "t1" }, { responses: [{ status: 502, body: {} }, { status: 204 }] });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /get_task/);
});

test("delete_task is not offered to agent tools", async () => {
  const { error, calls } = await runOperation("delete_task", { task_id: "t1" });
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("api_request as a tool reads project, task, label and comment paths only", async () => {
  const allowed = await runOperation("api_request", { path: "/projects/p1/collaborators" }, { responses: [{ body: { results: [] } }] });
  assert.equal(allowed.error, undefined);
  for (const refusedPath of ["/user", "/User/", "/backups", "/uploads", "/emails", "/workspaces/invitations/all", "/id_mappings/tasks/1", "/tasks/../user", "/tasks/%2e%2e/user"]) {
    const refused = await runOperation("api_request", { path: refusedPath });
    assert.equal(refused.error?.kind, "permission_denied", refusedPath);
    assert.equal(refused.calls.length, 0);
  }
});

test("api_request from a workflow node is not limited by the allowlist", async () => {
  const { error } = await runOperation("api_request", { path: "/backups" }, { source: "node", responses: [{ body: [] }] });
  assert.equal(error, undefined);
});

test("normalizeApiPath handles case, queries, trailing slashes and .json", () => {
  assert.equal(normalizeApiPath("/Tasks/abc.json?x=1"), "/tasks/abc");
  assert.equal(normalizeApiPath("/tasks//abc"), null);
  assert.equal(isAllowedReadPath("/labels/shared"), true);
  assert.equal(isAllowedReadPath("/labelsx"), false);
});
