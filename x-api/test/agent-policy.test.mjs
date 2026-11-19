/**
 * Agent policy: publishing (posts, replies, quotes, reposts) needs X_TOOL_ALLOW_POST=1, likes and hiding replies
 * need X_TOOL_ALLOW_ENGAGE=1, DMs need X_TOOL_ALLOW_DM=1 and every recipient in X_TOOL_RECIPIENT_ALLOWLIST.
 * delete_post is node only; reads stay free; workflow nodes are never limited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE_ENVIRONMENT = { X_ACCESS_TOKEN: "fake-token", X_USER_ID: "42" };

const GATED_CASES = [
  ["create_post", { text: "hello" }, "X_TOOL_ALLOW_POST"],
  ["create_post", { text: "a reply", reply_to_post_id: "100" }, "X_TOOL_ALLOW_POST"],
  ["repost", { post_id: "100" }, "X_TOOL_ALLOW_POST"],
  ["undo_repost", { post_id: "100" }, "X_TOOL_ALLOW_POST"],
  ["like_post", { post_id: "100" }, "X_TOOL_ALLOW_ENGAGE"],
  ["unlike_post", { post_id: "100" }, "X_TOOL_ALLOW_ENGAGE"],
  ["hide_reply", { post_id: "100" }, "X_TOOL_ALLOW_ENGAGE"],
  ["send_dm", { participant_id: "7", text: "hi" }, "X_TOOL_ALLOW_DM"],
  ["create_group_dm", { participant_ids: ["7", "8"], text: "hi" }, "X_TOOL_ALLOW_DM"],
];
const DM_ALLOWED = { X_TOOL_ALLOW_DM: "1", X_TOOL_RECIPIENT_ALLOWLIST: "7, 8, 7-42" };

function createRunner(extraEnvironment = {}) {
  const recordingFetch = createRecordingFetch(Array.from({ length: 5 }, () => ({ body: { data: { id: "1" } } })));
  const runOperation = createOperationRunner(pluginDefinition, { ...BASE_ENVIRONMENT, ...extraEnvironment }, { fetchImpl: recordingFetch });
  return { runOperation, calls: recordingFetch.calls };
}

const isPermissionDenied = (pattern) => (error) => error.kind === "permission_denied" && pattern.test(error.message);

for (const [operationName, args, optInEnv] of GATED_CASES) {
  const allowedEnvironment = optInEnv === "X_TOOL_ALLOW_DM" ? DM_ALLOWED : { [optInEnv]: "1" };

  test(`${operationName} as a tool is refused without ${optInEnv}=1, before any request`, async () => {
    const { runOperation, calls } = createRunner();
    await assert.rejects(runOperation(operationName, args, { source: "tool" }), isPermissionDenied(new RegExp(`${optInEnv}=1`)));
    assert.equal(calls.length, 0);
  });

  test(`${operationName} as a tool runs with ${optInEnv}=1`, async () => {
    const { runOperation, calls } = createRunner(allowedEnvironment);
    await runOperation(operationName, args, { source: "tool" });
    assert.equal(calls.length, 1);
  });

  test(`${operationName} as a workflow node needs no opt-in`, async () => {
    const { runOperation, calls } = createRunner();
    await runOperation(operationName, args, { source: "node" });
    assert.equal(calls.length, 1);
  });
}

test("another opt-in does not unlock an operation: X_TOOL_ALLOW_ENGAGE does not allow create_post", async () => {
  const { runOperation } = createRunner({ X_TOOL_ALLOW_ENGAGE: "1", X_TOOL_ALLOW_DM: "1" });
  await assert.rejects(runOperation("create_post", { text: "hello" }, { source: "tool" }), isPermissionDenied(/X_TOOL_ALLOW_POST=1/));
});

test("DMs with the opt-in but no allowlist are refused", async () => {
  const { runOperation, calls } = createRunner({ X_TOOL_ALLOW_DM: "1" });
  await assert.rejects(runOperation("send_dm", { participant_id: "7", text: "hi" }, { source: "tool" }), isPermissionDenied(/X_TOOL_RECIPIENT_ALLOWLIST, which is not set/));
  assert.equal(calls.length, 0);
});

test("DM recipients must match the allowlist exactly (user ids, or conversation ids for send_dm)", async () => {
  const { runOperation, calls } = createRunner(DM_ALLOWED);
  for (const otherId of ["77", "70", "1"]) {
    await assert.rejects(runOperation("send_dm", { participant_id: otherId, text: "hi" }, { source: "tool" }), isPermissionDenied(new RegExp(`not allowed: ${otherId}$`)));
  }
  await assert.rejects(runOperation("send_dm", { conversation_id: "7-43", text: "hi" }, { source: "tool" }), isPermissionDenied(/not allowed: 7-43/));
  await runOperation("send_dm", { conversation_id: "7-42", text: "hi" }, { source: "tool" });
  await assert.rejects(runOperation("create_group_dm", { participant_ids: ["7", "8", "9"], text: "hi" }, { source: "tool" }), isPermissionDenied(/not allowed: 9$/));
  assert.equal(calls.length, 1);
});

test("delete_post and refresh_access_token are workflow nodes only", () => {
  const toolNames = new Set(buildManifest(pluginDefinition).tools.map((tool) => tool.name));
  assert.equal(toolNames.has("delete_post"), false);
  assert.equal(toolNames.has("refresh_access_token"), false);
});

test("reads stay free tools", async () => {
  const { runOperation, calls } = createRunner();
  await runOperation("get_post", { post_id: "100" }, { source: "tool" });
  await runOperation("list_dm_events", {}, { source: "tool" });
  assert.equal(calls.length, 2);
});

test("the manifest passes the policy envs through and tool descriptions name the opt-in", () => {
  const manifest = buildManifest(pluginDefinition);
  for (const envName of ["X_TOOL_ALLOW_POST", "X_TOOL_ALLOW_DM", "X_TOOL_ALLOW_ENGAGE", "X_TOOL_RECIPIENT_ALLOWLIST"]) {
    assert.ok(manifest.permissions.env.includes(envName), envName);
  }
  const descriptionOf = (toolName) => manifest.tools.find((tool) => tool.name === toolName).description;
  assert.match(descriptionOf("create_post"), /X_TOOL_ALLOW_POST=1/);
  assert.match(descriptionOf("send_dm"), /X_TOOL_ALLOW_DM=1 and every recipient is in X_TOOL_RECIPIENT_ALLOWLIST/);
  assert.match(descriptionOf("like_post"), /X_TOOL_ALLOW_ENGAGE=1/);
});
