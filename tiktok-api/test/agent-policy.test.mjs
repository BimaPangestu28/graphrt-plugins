/**
 * Agent policy: direct posts, comments and replies need TIKTOK_TOOL_ALLOW_POST=1 as tools (inbox drafts, which the
 * creator finishes in the app, stay free), hiding and liking comments need TIKTOK_TOOL_ALLOW_ENGAGE=1, direct
 * messages need TIKTOK_TOOL_ALLOW_DM=1, delete_comment is node only and workflow nodes are never limited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";
import { businessOk, openOk } from "./helpers.mjs";

const BASE_ENVIRONMENT = { TIKTOK_ACCESS_TOKEN: "fake-token", TIKTOK_BUSINESS_ACCESS_TOKEN: "fake-business-token", TIKTOK_BUSINESS_ID: "biz-1", GRAPHRT_POLL_INTERVAL_MS: "0" };
const CREATOR_INFO = openOk({ creator_username: "me", privacy_level_options: ["SELF_ONLY"] });
const DIRECT_PUBLISH_FLOW = [CREATOR_INFO, openOk({ publish_id: "pub1" }), openOk({ status: "PUBLISH_COMPLETE" })];
const INBOX_PUBLISH_FLOW = [openOk({ publish_id: "pub2" }), openOk({ status: "SEND_TO_USER_INBOX" })];

const GATED_CASES = [
  ["publish_video", { video_url: "https://cdn.example.com/a.mp4", privacy_level: "SELF_ONLY" }, "TIKTOK_TOOL_ALLOW_POST", DIRECT_PUBLISH_FLOW],
  ["publish_photos", { photo_urls: ["https://cdn.example.com/a.jpg"], privacy_level: "SELF_ONLY" }, "TIKTOK_TOOL_ALLOW_POST", DIRECT_PUBLISH_FLOW],
  ["create_comment", { video_id: "v1", text: "nice" }, "TIKTOK_TOOL_ALLOW_POST", [businessOk()]],
  ["reply_to_comment", { video_id: "v1", comment_id: "c1", text: "thanks" }, "TIKTOK_TOOL_ALLOW_POST", [businessOk()]],
  ["set_comment_hidden", { comment_id: "c1", hidden: true }, "TIKTOK_TOOL_ALLOW_ENGAGE", [businessOk()]],
  ["set_comment_liked", { comment_id: "c1", liked: true }, "TIKTOK_TOOL_ALLOW_ENGAGE", [businessOk()]],
  ["send_message", { recipient: "conv-1", text: "hi" }, "TIKTOK_TOOL_ALLOW_DM", [businessOk()]],
];

function createRunner(extraEnvironment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, { ...BASE_ENVIRONMENT, ...extraEnvironment }, { fetchImpl: recordingFetch });
  return { runOperation, calls: recordingFetch.calls };
}

const isPermissionDenied = (pattern) => (error) => error.kind === "permission_denied" && pattern.test(error.message);

for (const [operationName, args, optInEnv, responses] of GATED_CASES) {
  test(`${operationName} as a tool is refused without ${optInEnv}=1, before any request`, async () => {
    const { runOperation, calls } = createRunner({}, responses);
    await assert.rejects(runOperation(operationName, args, { source: "tool" }), isPermissionDenied(new RegExp(`${optInEnv}=1`)));
    assert.equal(calls.length, 0);
  });

  test(`${operationName} as a tool runs with ${optInEnv}=1`, async () => {
    const { runOperation, calls } = createRunner({ [optInEnv]: "1" }, responses);
    await runOperation(operationName, args, { source: "tool" });
    assert.equal(calls.length, responses.length);
  });

  test(`${operationName} as a workflow node needs no opt-in`, async () => {
    const { runOperation, calls } = createRunner({}, responses);
    await runOperation(operationName, args, { source: "node" });
    assert.equal(calls.length, responses.length);
  });
}

test("inbox drafts stay free tools: the creator finishes and posts them in the TikTok app", async () => {
  const video = createRunner({}, INBOX_PUBLISH_FLOW);
  await video.runOperation("publish_video", { video_url: "https://cdn.example.com/a.mp4", mode: "inbox" }, { source: "tool" });
  assert.equal(video.calls.length, 2);
  const photos = createRunner({}, INBOX_PUBLISH_FLOW);
  await photos.runOperation("publish_photos", { photo_urls: ["https://cdn.example.com/a.jpg"], mode: "upload" }, { source: "tool" });
  assert.equal(photos.calls.length, 2);
});

test("publish_video without a mode is a direct post and needs the opt-in", async () => {
  const { runOperation } = createRunner({}, DIRECT_PUBLISH_FLOW);
  await assert.rejects(runOperation("publish_video", { video_url: "https://cdn.example.com/a.mp4" }, { source: "tool" }), isPermissionDenied(/TIKTOK_TOOL_ALLOW_POST=1/));
});

test("one opt-in does not unlock another group", async () => {
  const { runOperation } = createRunner({ TIKTOK_TOOL_ALLOW_ENGAGE: "1", TIKTOK_TOOL_ALLOW_DM: "1" }, [businessOk()]);
  await assert.rejects(runOperation("create_comment", { video_id: "v1", text: "x" }, { source: "tool" }), isPermissionDenied(/TIKTOK_TOOL_ALLOW_POST=1/));
});

test("delete_comment and refresh_access_token are workflow nodes only", () => {
  const toolNames = new Set(buildManifest(pluginDefinition).tools.map((tool) => tool.name));
  assert.equal(toolNames.has("delete_comment"), false);
  assert.equal(toolNames.has("refresh_access_token"), false);
});

test("reads stay free tools", async () => {
  const { runOperation, calls } = createRunner({}, [businessOk({ comments: [] })]);
  await runOperation("list_comments", { video_id: "v1" }, { source: "tool" });
  assert.equal(calls.length, 1);
});

test("the manifest passes the policy envs through and tool descriptions name the opt-in", () => {
  const manifest = buildManifest(pluginDefinition);
  for (const envName of ["TIKTOK_TOOL_ALLOW_POST", "TIKTOK_TOOL_ALLOW_ENGAGE", "TIKTOK_TOOL_ALLOW_DM"]) assert.ok(manifest.permissions.env.includes(envName), envName);
  const descriptionOf = (toolName) => manifest.tools.find((tool) => tool.name === toolName).description;
  assert.match(descriptionOf("publish_video"), /TIKTOK_TOOL_ALLOW_POST=1/);
  assert.match(descriptionOf("send_message"), /TIKTOK_TOOL_ALLOW_DM=1/);
  assert.match(descriptionOf("set_comment_liked"), /TIKTOK_TOOL_ALLOW_ENGAGE=1/);
});
