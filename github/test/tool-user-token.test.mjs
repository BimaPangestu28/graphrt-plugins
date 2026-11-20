import { test } from "node:test";
import assert from "node:assert/strict";
import { toolContext } from "../lib/shared/graphrt-plugin.mjs";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const ENV_TOKEN = "ghp_env_token_never_for_tools";
const USER_TOKEN = "gho_user_oauth_token_123";
const CONTEXT_MODE = { GITHUB_TOKEN: ENV_TOKEN, GITHUB_TOOL_TOKEN_SOURCE: "context" };

function createRunner(environment, responses = [{ body: [{ name: "api", owner: { login: "acme" } }] }]) {
  const recordingFetch = createRecordingFetch(responses);
  return { runOperation: createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch }), calls: recordingFetch.calls };
}

test("manifest declares GITHUB_TOOL_TOKEN_SOURCE", () => {
  assert.ok(buildManifest(pluginDefinition).permissions.env.includes("GITHUB_TOOL_TOKEN_SOURCE"));
});

test("context mode: tools act with the end user's token, nodes keep GITHUB_TOKEN", async () => {
  const { runOperation, calls } = createRunner(CONTEXT_MODE, [{ body: [] }, { body: [] }]);
  await runOperation("api_request", { path: "/user/repos" }, { source: "tool", toolContext: toolContext({ secrets: { access_token: USER_TOKEN } }) });
  await runOperation("api_request", { path: "/user/repos" }, { source: "node" });
  assert.equal(calls[0].headers.authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(calls[1].headers.authorization, `Bearer ${ENV_TOKEN}`);
});

test("context mode: no token in context is refused with no request and no fallback to GITHUB_TOKEN", async () => {
  const { runOperation, calls } = createRunner(CONTEXT_MODE);
  await assert.rejects(runOperation("api_request", { path: "/user/repos" }, { source: "tool", toolContext: toolContext({ secrets: { user_jwt: "x.y.z" } }) }), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.match(error.message, /GITHUB_TOOL_TOKEN_SOURCE=context/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("context mode: an echoed token never reaches the tool result or error", async () => {
  const echoing = createRunner(CONTEXT_MODE, [{ body: { note: `token ${USER_TOKEN}` } }, { status: 401, body: { message: `Bad credentials ${USER_TOKEN}` } }]);
  const callContext = toolContext({ secrets: { access_token: USER_TOKEN } });
  const output = await echoing.runOperation("api_request", { path: "/user" }, { source: "tool", toolContext: callContext });
  assert.ok(!JSON.stringify(output).includes(USER_TOKEN));
  await assert.rejects(echoing.runOperation("api_request", { path: "/user" }, { source: "tool", toolContext: callContext }), (error) => !error.message.includes(USER_TOKEN));
});
