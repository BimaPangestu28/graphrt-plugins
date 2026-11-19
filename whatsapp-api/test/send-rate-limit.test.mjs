/**
 * Client-side send limits for agent tool calls: a per-process sliding window
 * (WHATSAPP_TOOL_SEND_RATE_LIMIT per minute, 0 turns the limits off) and Meta's
 * pair rate (one message every 6 s to the same recipient). Workflow nodes are not limited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createPluginDefinition } from "../definition.mjs";
import { createFakeResolver, TEST_ENVIRONMENT } from "./helpers.mjs";

const AS_TOOL = { source: "tool" };
const AS_NODE = { source: "node" };
const recipientNumber = (index) => `62812345678${String(index).padStart(2, "0")}`;

/** A runner whose limiter and clock persist across calls, like one long-lived plugin process. */
function createLimitedRunner(extraEnvironment = {}) {
  const clock = { nowMs: 1_000_000 };
  const recordingFetch = createRecordingFetch(Array.from({ length: 100 }, () => ({ body: { messages: [{ id: "wamid.X" }] } })));
  const definition = createPluginDefinition({ resolveHostAddresses: createFakeResolver(), now: () => clock.nowMs });
  const runOperation = createOperationRunner(definition, { ...TEST_ENVIRONMENT, ...extraEnvironment }, { fetchImpl: recordingFetch });
  const sendText = (recipient, callOptions = AS_TOOL) => runOperation("send_text", { to: recipient, body: "halo" }, callOptions);
  return { clock, recordingFetch, runOperation, sendText };
}

const isRateLimited = (error) => error.kind === "rate_limited" && error.retryable === true && error.retryAfterMs > 0;

test("agent sends are capped per minute and the cap frees up as the window slides", async () => {
  const { clock, recordingFetch, sendText } = createLimitedRunner({ WHATSAPP_TOOL_SEND_RATE_LIMIT: "2" });
  await sendText(recipientNumber(1));
  clock.nowMs += 1000;
  await sendText(recipientNumber(2));
  await assert.rejects(sendText(recipientNumber(3)), (error) => isRateLimited(error) && /WHATSAPP_TOOL_SEND_RATE_LIMIT/.test(error.message) && error.retryAfterMs === 59000);
  assert.equal(recordingFetch.calls.length, 2, "a refused send never reaches WhatsApp");
  clock.nowMs += 59000;
  await sendText(recipientNumber(3));
  assert.equal(recordingFetch.calls.length, 3);
});

test("agent sends to the same recipient are spaced 6 s apart (Meta's pair rate limit)", async () => {
  const { clock, recordingFetch, sendText } = createLimitedRunner();
  await sendText(recipientNumber(1));
  clock.nowMs += 2000;
  await assert.rejects(sendText(`+${recipientNumber(1)}`), (error) => isRateLimited(error) && /6 s/.test(error.message) && error.retryAfterMs === 4000);
  await sendText(recipientNumber(2));
  clock.nowMs += 4000;
  await sendText(recipientNumber(1));
  assert.equal(recordingFetch.calls.length, 3);
});

test("every send operation counts, including reactions and media; mark_as_read does not", async () => {
  const { runOperation } = createLimitedRunner({ WHATSAPP_TOOL_SEND_RATE_LIMIT: "2" });
  await runOperation("send_reaction", { to: recipientNumber(1), message_id: "wamid.A", emoji: "👍" }, AS_TOOL);
  await runOperation("mark_as_read", { message_id: "wamid.B" }, AS_TOOL);
  await runOperation("send_media", { to: recipientNumber(2), media_type: "image", link: "https://img.test/a.jpg" }, AS_TOOL);
  await assert.rejects(runOperation("send_template", { to: recipientNumber(3), name: "hello_world" }, AS_TOOL), isRateLimited);
});

test("workflow nodes are never limited and do not use up the agent budget", async () => {
  const { sendText } = createLimitedRunner({ WHATSAPP_TOOL_SEND_RATE_LIMIT: "1" });
  for (let index = 0; index < 5; index += 1) await sendText(recipientNumber(1), AS_NODE);
  await sendText(recipientNumber(1));
  await assert.rejects(sendText(recipientNumber(2)), isRateLimited);
});

test("WHATSAPP_TOOL_SEND_RATE_LIMIT=0 turns the client-side limits off", async () => {
  const { recordingFetch, sendText } = createLimitedRunner({ WHATSAPP_TOOL_SEND_RATE_LIMIT: "0" });
  for (let index = 0; index < 30; index += 1) await sendText(recipientNumber(1));
  assert.equal(recordingFetch.calls.length, 30);
});

test("defaults to 20 agent sends a minute", async () => {
  const { sendText } = createLimitedRunner();
  for (let index = 0; index < 20; index += 1) await sendText(recipientNumber(index));
  await assert.rejects(sendText(recipientNumber(20)), isRateLimited);
});

test("an invalid limit is refused before anything is sent", async () => {
  for (const badValue of ["-1", "2.5", "lots", "1001"]) {
    const { recordingFetch, sendText } = createLimitedRunner({ WHATSAPP_TOOL_SEND_RATE_LIMIT: badValue });
    await assert.rejects(sendText(recipientNumber(1)), (error) => error.kind === "invalid_input" && /WHATSAPP_TOOL_SEND_RATE_LIMIT must be an integer from 0 to 1000/.test(error.message));
    assert.equal(recordingFetch.calls.length, 0, badValue);
  }
});

test("a send refused for bad input does not use up the budget", async () => {
  const { sendText, runOperation } = createLimitedRunner({ WHATSAPP_TOOL_SEND_RATE_LIMIT: "1" });
  await assert.rejects(runOperation("send_text", { to: "0812", body: "halo" }, AS_TOOL), (error) => error.kind === "invalid_input");
  await sendText(recipientNumber(1));
});
