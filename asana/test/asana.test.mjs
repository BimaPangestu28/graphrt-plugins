import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { isAsanaReadPath } from "../lib/api-request-policy.mjs";
import { pluginDefinition } from "../definition.mjs";

const environment = { ASANA_ACCESS_TOKEN: "asana-token-0001" };

async function runOperation(operationName, args, responses, source = "tool") {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("tool calls may assign tasks to me or a user gid, but not to an email address", async () => {
  for (const operationName of ["create_task", "update_task", "create_subtask"]) {
    const args = { create_task: { name: "x", workspace_gid: "1" }, update_task: { task_gid: "9" }, create_subtask: { task_gid: "9", name: "x" } }[operationName];
    const refused = await runOperation(operationName, { ...args, assignee: "someone@outside.example" }, [{ body: { data: {} } }]);
    assert.equal(refused.error?.kind, "permission_denied", operationName);
    assert.equal(refused.calls.length, 0, operationName);
    for (const assignee of ["me", "1203456789012345"]) {
      const allowed = await runOperation(operationName, { ...args, assignee }, [{ body: { data: { gid: "t1" } } }]);
      assert.equal(allowed.error, undefined, `${operationName} ${assignee}`);
    }
  }
});

test("nodes may assign by email", async () => {
  const { error, calls } = await runOperation("create_task", { name: "x", workspace_gid: "1", assignee: "ada@example.com" }, [{ body: { data: { gid: "t1" } } }], "node");
  assert.equal(error, undefined);
  assert.equal(calls[0].json.data.assignee, "ada@example.com");
});

test("isAsanaReadPath allows task and project reads and refuses webhooks, attachments, exports and audit logs", () => {
  for (const allowedPath of ["/tasks/1", "/projects/2/tasks?opt_fields=name", "/users/me", "/workspaces/1/tags", "/sections/3/tasks", "/teams/4/projects", "/tasks/1/stories.json"]) {
    assert.equal(isAsanaReadPath(allowedPath), true, allowedPath);
  }
  for (const refusedPath of ["/webhooks", "/attachments/5", "/tasks/1/attachments", "/workspaces/1/audit_log_events", "/organization_exports/7", "/tasks/../webhooks", "/WEBHOOKS", "/tasks/1/%2E%2E/webhooks", "/unknown"]) {
    assert.equal(isAsanaReadPath(refusedPath), false, refusedPath);
  }
});

test("api_request refuses webhooks for tools before any request, but not for nodes", async () => {
  const refused = await runOperation("api_request", { path: "/webhooks", query: { workspace: "1" } }, []);
  assert.equal(refused.error.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const node = await runOperation("api_request", { path: "/webhooks", query: { workspace: "1" } }, [{ body: { data: [] } }], "node");
  assert.equal(node.error, undefined);
});

test("delete_task is node only", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.tools.some((tool) => tool.name === "delete_task"), false);
  assert.equal(pluginDefinition.operations.find((operation) => operation.name === "delete_task").nodeOnly, true);
});

test("Asana's errors array becomes the message; 402 (premium only) is permission_denied", async () => {
  const { error } = await runOperation("search_tasks", { workspace_gid: "1", text: "x" }, [{ status: 402, body: { errors: [{ message: "Search is only available to premium users." }] } }]);
  assert.equal(error.kind, "permission_denied");
  assert.match(error.message, /premium/);
});
