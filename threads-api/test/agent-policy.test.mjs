/**
 * Agent policy: publishing and reposting need THREADS_TOOL_ALLOW_POST=1 as tools, hiding and approving replies need
 * THREADS_TOOL_ALLOW_ENGAGE=1, delete_thread is node only, reads stay free and workflow nodes are never limited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE_ENVIRONMENT = { THREADS_ACCESS_TOKEN: "fake-token", GRAPHRT_POLL_INTERVAL_MS: "0" };
const PUBLISH_FLOW = [{ body: { id: "c" } }, { body: { status: "FINISHED" } }, { body: { id: "p" } }];

const GATED_CASES = [
  ["publish_thread", { text: "hello" }, "THREADS_TOOL_ALLOW_POST", PUBLISH_FLOW],
  ["publish_thread", { text: "a reply", reply_to_id: "m0" }, "THREADS_TOOL_ALLOW_POST", PUBLISH_FLOW],
  ["repost_thread", { media_id: "m1" }, "THREADS_TOOL_ALLOW_POST", [{ body: { id: "r" } }]],
  ["hide_reply", { reply_id: "r1", hidden: true }, "THREADS_TOOL_ALLOW_ENGAGE", [{ body: { success: true } }]],
  ["approve_pending_reply", { reply_id: "r1", approve: true }, "THREADS_TOOL_ALLOW_ENGAGE", [{ body: { success: true } }]],
];

function createRunner(extraEnvironment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, { ...BASE_ENVIRONMENT, ...extraEnvironment }, { fetchImpl: recordingFetch });
  return { runOperation, calls: recordingFetch.calls };
}

const isPermissionDenied = (pattern) => (error) => error.kind === "permission_denied" && pattern.test(error.message);

for (const [operationName, args, optInEnv, responses] of GATED_CASES) {
  test(`${operationName} ${JSON.stringify(args)} as a tool is refused without ${optInEnv}=1, before any request`, async () => {
    const { runOperation, calls } = createRunner({}, responses);
    await assert.rejects(runOperation(operationName, args, { source: "tool" }), isPermissionDenied(new RegExp(`${optInEnv}=1`)));
    assert.equal(calls.length, 0);
  });

  test(`${operationName} ${JSON.stringify(args)} as a tool runs with ${optInEnv}=1`, async () => {
    const { runOperation, calls } = createRunner({ [optInEnv]: "1" }, responses);
    await runOperation(operationName, args, { source: "tool" });
    assert.equal(calls.length, responses.length);
  });

  test(`${operationName} ${JSON.stringify(args)} as a workflow node needs no opt-in`, async () => {
    const { runOperation, calls } = createRunner({}, responses);
    await runOperation(operationName, args, { source: "node" });
    assert.equal(calls.length, responses.length);
  });
}

test("the engage opt-in does not unlock publishing", async () => {
  const { runOperation } = createRunner({ THREADS_TOOL_ALLOW_ENGAGE: "1" }, PUBLISH_FLOW);
  await assert.rejects(runOperation("publish_thread", { text: "x" }, { source: "tool" }), isPermissionDenied(/THREADS_TOOL_ALLOW_POST=1/));
});

test("delete_thread and refresh_access_token are workflow nodes only", () => {
  const toolNames = new Set(buildManifest(pluginDefinition).tools.map((tool) => tool.name));
  assert.equal(toolNames.has("delete_thread"), false);
  assert.equal(toolNames.has("refresh_access_token"), false);
});

test("reads stay free tools", async () => {
  const { runOperation, calls } = createRunner({}, [{ body: { data: [] } }, { body: { data: [] } }]);
  await runOperation("list_threads", {}, { source: "tool" });
  await runOperation("list_replies", { media_id: "m1" }, { source: "tool" });
  assert.equal(calls.length, 2);
});

test("the manifest passes the policy envs through and tool descriptions name the opt-in", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.ok(manifest.permissions.env.includes("THREADS_TOOL_ALLOW_POST"));
  assert.ok(manifest.permissions.env.includes("THREADS_TOOL_ALLOW_ENGAGE"));
  assert.match(manifest.tools.find((tool) => tool.name === "publish_thread").description, /THREADS_TOOL_ALLOW_POST=1/);
  assert.match(manifest.tools.find((tool) => tool.name === "hide_reply").description, /THREADS_TOOL_ALLOW_ENGAGE=1/);
});
