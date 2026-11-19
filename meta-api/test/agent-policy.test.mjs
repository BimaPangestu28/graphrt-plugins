/**
 * Agent policy: Page posts, Instagram publishing and comment replies need META_TOOL_ALLOW_POST=1 as tools; hiding and
 * liking comments need META_TOOL_ALLOW_ENGAGE=1; Messenger / Instagram Direct messages need META_TOOL_ALLOW_DM=1
 * and the recipient in META_TOOL_RECIPIENT_ALLOWLIST. Deletes are node only; workflow nodes are never limited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE_ENVIRONMENT = { META_ACCESS_TOKEN: "fake-token", META_PAGE_ID: "111", META_IG_USER_ID: "222", GRAPHRT_POLL_INTERVAL_MS: "0" };
const SINGLE_RESPONSE = [{ body: { id: "1", success: true } }];
const INSTAGRAM_PUBLISH_FLOW = [{ body: { id: "cont1" } }, { body: { status_code: "FINISHED" } }, { body: { id: "media1" } }];
const DM_ALLOWED = { META_TOOL_ALLOW_DM: "1", META_TOOL_RECIPIENT_ALLOWLIST: "psid1, igsid2" };

const GATED_CASES = [
  ["create_page_post", { message: "hi" }, "META_TOOL_ALLOW_POST", SINGLE_RESPONSE],
  ["create_page_photo_post", { image_url: "https://img.test/a.jpg" }, "META_TOOL_ALLOW_POST", SINGLE_RESPONSE],
  ["update_page_post", { post_id: "111_5", message: "edited" }, "META_TOOL_ALLOW_POST", SINGLE_RESPONSE],
  ["reply_to_comment", { object_id: "c9", message: "thanks!" }, "META_TOOL_ALLOW_POST", SINGLE_RESPONSE],
  ["publish_instagram_media", { media_type: "IMAGE", image_url: "https://img.test/a.jpg" }, "META_TOOL_ALLOW_POST", INSTAGRAM_PUBLISH_FLOW],
  ["reply_to_instagram_comment", { comment_id: "ic1", message: "hey" }, "META_TOOL_ALLOW_POST", SINGLE_RESPONSE],
  ["set_comment_hidden", { comment_id: "c9", hidden: true }, "META_TOOL_ALLOW_ENGAGE", SINGLE_RESPONSE],
  ["like_comment", { comment_id: "c9" }, "META_TOOL_ALLOW_ENGAGE", SINGLE_RESPONSE],
  ["unlike_comment", { comment_id: "c9" }, "META_TOOL_ALLOW_ENGAGE", SINGLE_RESPONSE],
  ["set_instagram_comment_hidden", { comment_id: "ic1", hidden: false }, "META_TOOL_ALLOW_ENGAGE", SINGLE_RESPONSE],
  ["send_message", { recipient_id: "psid1", text: "halo" }, "META_TOOL_ALLOW_DM", SINGLE_RESPONSE],
];

function createRunner(extraEnvironment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, { ...BASE_ENVIRONMENT, ...extraEnvironment }, { fetchImpl: recordingFetch });
  return { runOperation, calls: recordingFetch.calls };
}

const isPermissionDenied = (pattern) => (error) => error.kind === "permission_denied" && pattern.test(error.message);

for (const [operationName, args, optInEnv, responses] of GATED_CASES) {
  const allowedEnvironment = optInEnv === "META_TOOL_ALLOW_DM" ? DM_ALLOWED : { [optInEnv]: "1" };

  test(`${operationName} as a tool is refused without ${optInEnv}=1, before any request`, async () => {
    const { runOperation, calls } = createRunner({ META_TOOL_RECIPIENT_ALLOWLIST: "psid1" }, responses);
    await assert.rejects(runOperation(operationName, args, { source: "tool" }), isPermissionDenied(new RegExp(`${optInEnv}=1`)));
    assert.equal(calls.length, 0);
  });

  test(`${operationName} as a tool runs with ${optInEnv}=1`, async () => {
    const { runOperation, calls } = createRunner(allowedEnvironment, responses);
    await runOperation(operationName, args, { source: "tool" });
    assert.equal(calls.length, responses.length);
  });

  test(`${operationName} as a workflow node needs no opt-in`, async () => {
    const { runOperation, calls } = createRunner({}, responses);
    await runOperation(operationName, args, { source: "node" });
    assert.equal(calls.length, responses.length);
  });
}

test("send_message with the opt-in but no allowlist is refused", async () => {
  const { runOperation, calls } = createRunner({ META_TOOL_ALLOW_DM: "1" }, SINGLE_RESPONSE);
  await assert.rejects(runOperation("send_message", { recipient_id: "psid1", text: "halo" }, { source: "tool" }), isPermissionDenied(/META_TOOL_RECIPIENT_ALLOWLIST, which is not set/));
  assert.equal(calls.length, 0);
});

test("send_message recipients must match the allowlist exactly", async () => {
  const { runOperation, calls } = createRunner(DM_ALLOWED, SINGLE_RESPONSE);
  for (const otherId of ["psid", "psid11", "PSID1", "igsid"]) {
    await assert.rejects(runOperation("send_message", { recipient_id: otherId, text: "halo" }, { source: "tool" }), isPermissionDenied(new RegExp(`not allowed: ${otherId}$`)));
  }
  await runOperation("send_message", { recipient_id: "igsid2", text: "halo" }, { source: "tool" });
  assert.equal(calls.length, 1);
});

test("one opt-in does not unlock another group", async () => {
  const { runOperation } = createRunner({ META_TOOL_ALLOW_ENGAGE: "1", ...DM_ALLOWED }, SINGLE_RESPONSE);
  await assert.rejects(runOperation("create_page_post", { message: "x" }, { source: "tool" }), isPermissionDenied(/META_TOOL_ALLOW_POST=1/));
});

test("deletes are workflow nodes only", () => {
  const toolNames = new Set(buildManifest(pluginDefinition).tools.map((tool) => tool.name));
  for (const operationName of ["delete_page_post", "delete_comment", "delete_instagram_comment"]) assert.equal(toolNames.has(operationName), false, operationName);
});

test("reads stay free tools", async () => {
  const { runOperation, calls } = createRunner({}, [{ body: { data: [] } }, { body: { data: [] } }]);
  await runOperation("list_page_posts", {}, { source: "tool" });
  await runOperation("list_conversations", {}, { source: "tool" });
  assert.equal(calls.length, 2);
});

test("the manifest passes the policy envs through and tool descriptions name the opt-in", () => {
  const manifest = buildManifest(pluginDefinition);
  for (const envName of ["META_TOOL_ALLOW_POST", "META_TOOL_ALLOW_ENGAGE", "META_TOOL_ALLOW_DM", "META_TOOL_RECIPIENT_ALLOWLIST"]) {
    assert.ok(manifest.permissions.env.includes(envName), envName);
  }
  const descriptionOf = (toolName) => manifest.tools.find((tool) => tool.name === toolName).description;
  assert.match(descriptionOf("create_page_post"), /META_TOOL_ALLOW_POST=1/);
  assert.match(descriptionOf("send_message"), /META_TOOL_ALLOW_DM=1 and the recipient is in META_TOOL_RECIPIENT_ALLOWLIST/);
  assert.match(descriptionOf("like_comment"), /META_TOOL_ALLOW_ENGAGE=1/);
});
