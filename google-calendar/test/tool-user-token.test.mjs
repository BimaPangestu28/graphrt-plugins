import { test } from "node:test";
import assert from "node:assert/strict";
import { toolContext } from "../lib/shared/graphrt-plugin.mjs";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearCachedAccessTokens } from "../lib/google-auth.mjs";
import { pluginDefinition } from "../definition.mjs";
import { REFRESH_ENVIRONMENT } from "./helpers.mjs";

const USER_TOKEN = "ya29.end-user-access-token";
const CONTEXT_MODE = { ...REFRESH_ENVIRONMENT, GOOGLE_ACCESS_TOKEN: "env-access-token", GOOGLE_CALENDAR_TOOL_TOKEN_SOURCE: "context" };

async function runTool(responses, secrets) {
  clearCachedAccessTokens();
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, CONTEXT_MODE, { fetchImpl: recordingFetch });
  const outcome = await runOperation("list_calendars", {}, { source: "tool", toolContext: toolContext({ secrets }) }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("context mode: Calendar is called with the end user's token, never a refreshed or env token", async () => {
  const { output, error, calls } = await runTool([{ body: { items: [{ id: "primary" }] } }], { access_token: USER_TOKEN });
  if (error) throw error;
  assert.equal(calls.length, 1, "no request to Google's token endpoint");
  assert.equal(calls[0].headers.authorization, `Bearer ${USER_TOKEN}`);
  assert.ok(!JSON.stringify(output).includes(USER_TOKEN));
});

test("context mode: a 401 is not retried with the env refresh token", async () => {
  const { error, calls } = await runTool([{ status: 401, body: { error: { code: 401, message: `Invalid token ${USER_TOKEN}` } } }], { access_token: USER_TOKEN });
  assert.equal(error.kind, "auth_error");
  assert.ok(!error.message.includes(USER_TOKEN));
  assert.equal(calls.length, 1);
});

test("context mode: no access_token in context is refused before any request", async () => {
  const { error, calls } = await runTool([], {});
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /GOOGLE_CALENDAR_TOOL_TOKEN_SOURCE=context/);
  assert.equal(calls.length, 0);
});
