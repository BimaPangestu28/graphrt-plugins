import { test } from "node:test";
import assert from "node:assert/strict";
import { toolContext } from "../lib/shared/graphrt-plugin.mjs";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const USER_TOKEN = "end-user-token-0123456789";
const CONTEXT_MODE = { ...{ META_ACCESS_TOKEN: "env-meta-page-token", META_PAGE_ID: "999000999", META_IG_USER_ID: "888000888" }, META_API_TOOL_TOKEN_SOURCE: "context" };

async function runTool(operationName, args, responses = [{ body: {} }], secrets = { access_token: USER_TOKEN }) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, CONTEXT_MODE, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  const outcome = await runOperation(operationName, args, { source: "tool", toolContext: toolContext({ secrets }) }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls, sent: JSON.stringify(recordingFetch.calls) };
}

const envValues = Object.entries(CONTEXT_MODE).filter(([envName]) => envName !== "META_API_TOOL_TOKEN_SOURCE").map(([, value]) => value);
const assertNoEnvValueSent = (sent) => envValues.forEach((value) => assert.ok(!sent.includes(value), `${value} was sent`));

test("context mode: Page reads use the end user's Page token and the page_id they pass", async () => {
  const { output, error, calls, sent } = await runTool("get_page", { page_id: "123456" }, [{ body: { id: "123456", name: "Shop", echo: USER_TOKEN } }]);
  if (error) throw error;
  assert.match(calls[0].url, /\/123456(\?|$)/);
  assert.ok(sent.includes(USER_TOKEN), "the context token was sent");
  assertNoEnvValueSent(sent);
  assert.ok(!JSON.stringify(output).includes(USER_TOKEN));
});

test("context mode: META_PAGE_ID and META_IG_USER_ID are not used for the end user", async () => {
  const page = await runTool("get_page", {});
  assert.equal(page.error.kind, "invalid_input");
  assert.match(page.error.message, /page_id/);
  const instagram = await runTool("get_instagram_account", {});
  assert.equal(instagram.error.kind, "invalid_input");
  assert.equal(page.calls.length + instagram.calls.length, 0);
});

test("context mode: no token in context is refused before any request", async () => {
  const { error, calls } = await runTool("get_page", { page_id: "123456" }, [], { access_token: "******" });
  assert.equal(error.kind, "auth_error");
  assert.equal(calls.length, 0);
});
