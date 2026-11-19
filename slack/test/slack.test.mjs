import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";
import { isSlackReadMethodPath } from "../lib/api-request-policy.mjs";
import { checkUploadUrl } from "../lib/upload-file.mjs";

const BOT_TOKEN = "xoxb-test-bot-token-1";
const USER_TOKEN = "xoxp-test-user-token-1";

async function runSlack(operationName, args, { responses = [], environment = {}, source = "node" } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { SLACK_BOT_TOKEN: BOT_TOKEN, ...environment }, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

function withUploadDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "slack-upload-"));
  writeFileSync(join(directory, "report.txt"), "hello slack");
  return callback(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

const uploadResponses = (completeResponse = { body: { ok: true, files: [{ id: "F1", title: "Report" }] } }) => [
  { body: { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" } },
  { body: "OK - 11" },
  completeResponse,
];

test("manifest: bot token is the credential; user token, upload dir and opt-in are allowed env", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env, ["SLACK_BOT_TOKEN", "SLACK_USER_TOKEN", "SLACK_UPLOAD_DIR", "SLACK_TOOL_ALLOW_SEND"]);
  assert.equal(manifest.tools.some((tool) => tool.name === "delete_message"), false);
  assert.equal(manifest.tools.at(-1).name, "api_request");
});

test("ok:false bodies become typed errors", async () => {
  const { error } = await runSlack("auth_test", {}, { responses: [{ body: { ok: false, error: "invalid_auth" } }] });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /invalid_auth/);
  const missingScope = await runSlack("list_users", {}, { responses: [{ body: { ok: false, error: "missing_scope", needed: "users:read" } }] });
  assert.equal(missingScope.error.kind, "permission_denied");
});

test("upload_file runs the three-step external upload and shares in the channel", () =>
  withUploadDirectory(async (directory) => {
    const { output, error, calls } = await runSlack("upload_file", { file: join(directory, "report.txt"), file_title: "Report", channel_id: "C1", initial_comment: "Weekly report" }, { responses: uploadResponses(), environment: { SLACK_UPLOAD_DIR: directory } });
    if (error) throw error;
    assert.equal(calls[0].url, "https://slack.com/api/files.getUploadURLExternal");
    assert.deepEqual(calls[0].form, { filename: "report.txt", length: "11" });
    assert.equal(calls[0].headers.authorization, `Bearer ${BOT_TOKEN}`);
    assert.equal(calls[1].url, "https://files.slack.com/upload/v1/abc");
    assert.equal(calls[1].headers.authorization, undefined, "no token on the upload URL");
    assert.equal(calls[2].url, "https://slack.com/api/files.completeUploadExternal");
    assert.deepEqual(calls[2].json, { files: [{ id: "F1", title: "Report" }], channel_id: "C1", initial_comment: "Weekly report" });
    assert.deepEqual(output.data, { file_id: "F1", files: [{ id: "F1", title: "Report" }] });
  }));

test("upload_file is refused for tools without SLACK_TOOL_ALLOW_SEND=1 and allowed with it", () =>
  withUploadDirectory(async (directory) => {
    const file = join(directory, "report.txt");
    const refused = await runSlack("upload_file", { file, channel_id: "C1" }, { source: "tool", environment: { SLACK_UPLOAD_DIR: directory } });
    assert.equal(refused.error.kind, "permission_denied");
    assert.equal(refused.calls.length, 0);
    const allowed = await runSlack("upload_file", { file, channel_id: "C1" }, { source: "tool", responses: uploadResponses(), environment: { SLACK_UPLOAD_DIR: directory, SLACK_TOOL_ALLOW_SEND: "1" } });
    if (allowed.error) throw allowed.error;
    assert.equal(allowed.calls.length, 3);
  }));

test("upload_file refuses local paths without SLACK_UPLOAD_DIR", async () => {
  const { error, calls } = await runSlack("upload_file", { file: "/etc/hosts" });
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("upload_file never retries the share step after a 5xx and says how to check", () =>
  withUploadDirectory(async (directory) => {
    const failedShare = { status: 503, headers: { "retry-after": "0" }, body: { ok: false, error: "fatal_error" } };
    const { error, calls } = await runSlack("upload_file", { file: join(directory, "report.txt"), channel_id: "C1" }, { responses: [...uploadResponses(failedShare), { body: { ok: true } }], environment: { SLACK_UPLOAD_DIR: directory } });
    assert.equal(calls.length, 3);
    assert.equal(error.retryable, false);
    assert.match(error.message, /outcome unknown.*files\.info for file F1/);
  }));

test("upload URLs outside slack.com https are refused", () => {
  assert.equal(checkUploadUrl("https://files.slack.com/upload/v1/x"), "https://files.slack.com/upload/v1/x");
  assert.throws(() => checkUploadUrl("https://evil.example/upload"), /not a slack.com/);
  assert.throws(() => checkUploadUrl("http://files.slack.com/upload"), /not a slack.com/);
  assert.throws(() => checkUploadUrl("https://slack.com.evil.example/x"), /not a slack.com/);
  assert.throws(() => checkUploadUrl(undefined), /no usable upload_url/);
});

test("search_messages uses SLACK_USER_TOKEN and pages with count/page", async () => {
  const body = { ok: true, messages: { matches: [{ ts: "1.0", text: "deploy" }], paging: { count: 20, page: 1, pages: 3, total: 41 } } };
  const { output, error, calls } = await runSlack("search_messages", { query: "deploy in:#ops", sort: "timestamp" }, { responses: [{ body }], environment: { SLACK_USER_TOKEN: USER_TOKEN }, source: "tool" });
  if (error) throw error;
  assert.equal(`${new URL(calls[0].url).origin}${calls[0].path}`, "https://slack.com/api/search.messages");
  assert.deepEqual(calls[0].query, { query: "deploy in:#ops", count: "20", page: "1", sort: "timestamp" });
  assert.equal(calls[0].headers.authorization, `Bearer ${USER_TOKEN}`);
  assert.deepEqual(output, { data: [{ ts: "1.0", text: "deploy" }], next_cursor: "2" });
  const lastPage = await runSlack("search_messages", { query: "deploy", cursor: "3" }, { responses: [{ body: { ok: true, messages: { matches: [], paging: { pages: 3 } } } }], environment: { SLACK_USER_TOKEN: USER_TOKEN } });
  assert.equal(lastPage.calls[0].query.page, "3");
  assert.equal(lastPage.output.next_cursor, null);
});

test("search_messages without a user token is an auth_error and redacts an echoed token", async () => {
  const missing = await runSlack("search_messages", { query: "x" });
  assert.equal(missing.error.kind, "auth_error");
  assert.match(missing.error.message, /SLACK_USER_TOKEN/);
  const echoed = await runSlack("search_messages", { query: "x" }, { responses: [{ body: { ok: false, error: `invalid_auth ${USER_TOKEN}` } }], environment: { SLACK_USER_TOKEN: USER_TOKEN } });
  assert.equal(echoed.error.message.includes(USER_TOKEN), false);
  const bad = await runSlack("search_messages", { query: "x", cursor: "zero" }, { environment: { SLACK_USER_TOKEN: USER_TOKEN } });
  assert.equal(bad.error.kind, "invalid_input");
});

test("api_request as a tool only reaches Slack read methods (Slack runs writes sent as GET)", async () => {
  const refused = await runSlack("api_request", { path: "/chat.postMessage?channel=C1&text=hi" }, { source: "tool" });
  assert.equal(refused.error.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const allowed = await runSlack("api_request", { path: "/team.info" }, { source: "tool", responses: [{ body: { ok: true, team: { id: "T1" } } }] });
  if (allowed.error) throw allowed.error;
  const node = await runSlack("api_request", { path: "/conversations.join", method: "POST", body: { channel: "C1" } }, { responses: [{ body: { ok: true } }] });
  if (node.error) throw node.error;
});

test("isSlackReadMethodPath accepts read methods only", () => {
  for (const readPath of ["/team.info", "/conversations.list", "/users.getPresence", "/admin.users.list", "/users.lookupByEmail?email=a", "/bookmarks.list"]) assert.equal(isSlackReadMethodPath(readPath), true, readPath);
  for (const writePath of ["/chat.postMessage", "/conversations.join", "/files.getUploadURLExternal", "/chat.delete", "/conversations.list/../chat.postMessage", "/anything", "/users.setPresence"]) assert.equal(isSlackReadMethodPath(writePath), false, writePath);
});
