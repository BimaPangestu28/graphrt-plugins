/**
 * Agent policy: posts and comments (create and edit) need LINKEDIN_TOOL_ALLOW_POST=1 as tools, reactions need
 * LINKEDIN_TOOL_ALLOW_ENGAGE=1, deletes are node only, reads stay free and workflow nodes are never limited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createTestDefinition } from "./helpers.mjs";

const SHARE_URN = "urn:li:share:123";
const BASE_ENVIRONMENT = { LINKEDIN_ACCESS_TOKEN: "fake-token", LINKEDIN_AUTHOR_URN: "urn:li:organization:42" };
const POST_CREATED = { status: 201, body: "", headers: { "x-restli-id": SHARE_URN } };

const GATED_CASES = [
  ["create_post", { text: "Hello" }, "LINKEDIN_TOOL_ALLOW_POST", POST_CREATED],
  ["update_post", { post_urn: SHARE_URN, text: "edited" }, "LINKEDIN_TOOL_ALLOW_POST", { status: 204 }],
  ["create_comment", { target_urn: SHARE_URN, text: "nice" }, "LINKEDIN_TOOL_ALLOW_POST", { body: {} }],
  ["update_comment", { target_urn: SHARE_URN, comment_id: "2", text: "fixed" }, "LINKEDIN_TOOL_ALLOW_POST", { body: {} }],
  ["add_reaction", { target_urn: SHARE_URN }, "LINKEDIN_TOOL_ALLOW_ENGAGE", { body: {} }],
  ["remove_reaction", { target_urn: SHARE_URN }, "LINKEDIN_TOOL_ALLOW_ENGAGE", { status: 204 }],
];

function createRunner(extraEnvironment, response) {
  const recordingFetch = createRecordingFetch([response, response]);
  const runOperation = createOperationRunner(createTestDefinition(), { ...BASE_ENVIRONMENT, ...extraEnvironment }, { fetchImpl: recordingFetch });
  return { runOperation, calls: recordingFetch.calls };
}

const isPermissionDenied = (pattern) => (error) => error.kind === "permission_denied" && pattern.test(error.message);

for (const [operationName, args, optInEnv, response] of GATED_CASES) {
  test(`${operationName} as a tool is refused without ${optInEnv}=1, before any request`, async () => {
    const { runOperation, calls } = createRunner({}, response);
    await assert.rejects(runOperation(operationName, args, { source: "tool" }), isPermissionDenied(new RegExp(`${optInEnv}=1`)));
    assert.equal(calls.length, 0);
  });

  test(`${operationName} as a tool runs with ${optInEnv}=1`, async () => {
    const { runOperation, calls } = createRunner({ [optInEnv]: "1" }, response);
    await runOperation(operationName, args, { source: "tool" });
    assert.equal(calls.length, 1);
  });

  test(`${operationName} as a workflow node needs no opt-in`, async () => {
    const { runOperation, calls } = createRunner({}, response);
    await runOperation(operationName, args, { source: "node" });
    assert.equal(calls.length, 1);
  });
}

test("the engage opt-in does not unlock posting, nor the post opt-in reactions", async () => {
  const engageOnly = createRunner({ LINKEDIN_TOOL_ALLOW_ENGAGE: "1" }, POST_CREATED);
  await assert.rejects(engageOnly.runOperation("create_post", { text: "x" }, { source: "tool" }), isPermissionDenied(/LINKEDIN_TOOL_ALLOW_POST=1/));
  const postOnly = createRunner({ LINKEDIN_TOOL_ALLOW_POST: "1" }, { body: {} });
  await assert.rejects(postOnly.runOperation("add_reaction", { target_urn: SHARE_URN }, { source: "tool" }), isPermissionDenied(/LINKEDIN_TOOL_ALLOW_ENGAGE=1/));
});

test("deletes are workflow nodes only", async () => {
  const toolNames = new Set(buildManifest(createTestDefinition()).tools.map((tool) => tool.name));
  assert.equal(toolNames.has("delete_post"), false);
  assert.equal(toolNames.has("delete_comment"), false);
  const { runOperation } = createRunner({ LINKEDIN_TOOL_ALLOW_POST: "1" }, { status: 204 });
  await assert.rejects(runOperation("delete_post", { post_urn: SHARE_URN }, { source: "tool" }), (error) => error.kind === "invalid_input");
});

test("reads stay free tools", async () => {
  const { runOperation, calls } = createRunner({}, { body: { elements: [] } });
  await runOperation("list_comments", { target_urn: SHARE_URN }, { source: "tool" });
  assert.equal(calls.length, 1);
});

test("the manifest passes the policy envs through and tool descriptions name the opt-in", () => {
  const manifest = buildManifest(createTestDefinition());
  assert.ok(manifest.permissions.env.includes("LINKEDIN_TOOL_ALLOW_POST"));
  assert.ok(manifest.permissions.env.includes("LINKEDIN_TOOL_ALLOW_ENGAGE"));
  assert.match(manifest.tools.find((tool) => tool.name === "create_post").description, /LINKEDIN_TOOL_ALLOW_POST=1/);
  assert.match(manifest.tools.find((tool) => tool.name === "add_reaction").description, /LINKEDIN_TOOL_ALLOW_ENGAGE=1/);
});
