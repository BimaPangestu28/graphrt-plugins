import { test } from "node:test";
import assert from "node:assert/strict";
import { toolContext } from "../lib/shared/graphrt-plugin.mjs";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const USER_TOKEN = "end-user-token-0123456789";
const CONTEXT_MODE = { ...{ LINKEDIN_ACCESS_TOKEN: "env-linkedin-token", LINKEDIN_AUTHOR_URN: "urn:li:organization:999" }, LINKEDIN_API_TOOL_TOKEN_SOURCE: "context" };

async function runTool(operationName, args, responses = [{ body: {} }], secrets = { access_token: USER_TOKEN }) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, CONTEXT_MODE, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  const outcome = await runOperation(operationName, args, { source: "tool", toolContext: toolContext({ secrets }) }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls, sent: JSON.stringify(recordingFetch.calls) };
}

const envValues = Object.entries(CONTEXT_MODE).filter(([envName]) => envName !== "LINKEDIN_API_TOOL_TOKEN_SOURCE").map(([, value]) => value);
const assertNoEnvValueSent = (sent) => envValues.forEach((value) => assert.ok(!sent.includes(value), `${value} was sent`));

test("context mode: tools use the end user's token, never LINKEDIN_ACCESS_TOKEN", async () => {
  const { output, error, calls, sent } = await runTool("get_userinfo", {}, [{ body: { sub: "abc", note: USER_TOKEN } }]);
  if (error) throw error;
  assert.equal(calls[0].headers.authorization, `Bearer ${USER_TOKEN}`);
  assertNoEnvValueSent(sent);
  assert.ok(!JSON.stringify(output).includes(USER_TOKEN));
});

test("context mode: the operator's LINKEDIN_AUTHOR_URN is not used for the end user", async () => {
  const { error, calls } = await runTool("list_organization_posts", {});
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /author_urn/);
  assert.equal(calls.length, 0);
});

test("context mode: no token in context is refused before any request", async () => {
  const { error, calls } = await runTool("get_userinfo", {}, [], {});
  assert.equal(error.kind, "auth_error");
  assert.equal(calls.length, 0);
});
