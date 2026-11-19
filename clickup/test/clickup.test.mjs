import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { isAllowedReadPath, normalizeApiPath } from "../lib/api-request-policy.mjs";
import { pluginDefinition } from "../definition.mjs";

const TOKEN = "pk_test_0001";

async function runOperation(operationName, args, { responses = [{ body: {} }], source = "tool", environment = {} } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { CLICKUP_API_TOKEN: TOKEN, ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("the personal token is sent in Authorization without a Bearer prefix", async () => {
  const { calls } = await runOperation("get_user", {}, { responses: [{ body: { user: { id: 1 } } }] });
  assert.equal(calls[0].headers.authorization, TOKEN);
});

test("ClickUp {err, ECODE} errors map to auth_error and permission_denied", async () => {
  const revoked = await runOperation("list_teams", {}, { responses: [{ status: 401, body: { err: "Token invalid", ECODE: "OAUTH_025" } }] });
  assert.equal(revoked.error.kind, "auth_error");
  assert.match(revoked.error.message, /Token invalid/);
  const teamDenied = await runOperation("list_teams", {}, { responses: [{ status: 401, body: { err: "Team not authorized", ECODE: "OAUTH_027" } }] });
  assert.equal(teamDenied.error.kind, "permission_denied");
});

test("list_tasks pages start at 0 and an empty page ends the listing", async () => {
  const first = await runOperation("list_tasks", { list_id: "l1" }, { responses: [{ body: { tasks: [{ id: "t1" }], last_page: false } }] });
  assert.equal(new URL(first.calls[0].url).searchParams.get("page"), null);
  assert.equal(first.output.next_cursor, "1");
  const second = await runOperation("list_tasks", { list_id: "l1", cursor: "1" }, { responses: [{ body: { tasks: [], last_page: true } }] });
  assert.equal(new URL(second.calls[0].url).searchParams.get("page"), "1");
  assert.equal(second.output.next_cursor, null);
});

test("delete_task is not offered to agent tools", async () => {
  const { error, calls } = await runOperation("delete_task", { task_id: "t1" });
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("api_request as a tool reaches allowed reads only", async () => {
  const allowed = await runOperation("api_request", { path: "/list/l1/member" }, { responses: [{ body: { members: [] } }] });
  assert.equal(allowed.error, undefined);
  for (const refusedPath of ["/team/9001/webhook", "/Team/9001/Webhook.json", "/task/t1/../../team/1/webhook", "/team/9001/customroles", "/team/9001/user/5"]) {
    const refused = await runOperation("api_request", { path: refusedPath });
    assert.equal(refused.error?.kind, "permission_denied", refusedPath);
    assert.equal(refused.calls.length, 0);
  }
});

test("api_request from a workflow node is not limited by the read allowlist", async () => {
  const { error } = await runOperation("api_request", { path: "/team/9001/webhook" }, { source: "node", responses: [{ body: { webhooks: [] } }] });
  assert.equal(error, undefined);
});

test("normalizeApiPath strips queries, case, trailing slashes and .json, and refuses dot segments", () => {
  assert.equal(normalizeApiPath("/Task/9hz/Comment.json?start=1"), "/task/9hz/comment");
  assert.equal(normalizeApiPath("/task/9hz/"), "/task/9hz");
  assert.equal(normalizeApiPath("/task/%2E%2E/x"), null);
  assert.equal(normalizeApiPath("/task/%E0%A4%A"), null);
  assert.equal(isAllowedReadPath("/team"), true);
  assert.equal(isAllowedReadPath("/team/1/time_entries"), true);
  assert.equal(isAllowedReadPath("/team/1/webhook"), false);
});
