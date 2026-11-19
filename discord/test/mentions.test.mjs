import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const SEND_ALLOWED = { DISCORD_BOT_TOKEN: "discord-test-token-1", DISCORD_TOOL_ALLOW_SEND: "1" };
const MASS_MENTIONS_ENV = "DISCORD_TOOL_ALLOW_MASS_MENTIONS";

async function sendMessage(args, { environment = {}, source = "tool" } = {}) {
  const recordingFetch = createRecordingFetch([{ body: { id: "301" } }]);
  const run = createOperationRunner(pluginDefinition, { ...SEND_ALLOWED, ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run("send_message", { channel_id: "20", content: "@everyone deploy", ...args }, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

const massMentions = [{ parse: ["everyone"] }, { parse: ["users", "roles"] }, { parse: [], roles: ["555"] }];

test("tool sends may not ping @everyone/@here or roles without DISCORD_TOOL_ALLOW_MASS_MENTIONS=1", async () => {
  for (const allowedMentions of massMentions) {
    const { error, calls } = await sendMessage({ allowed_mentions: allowedMentions });
    assert.equal(error?.kind, "permission_denied", JSON.stringify(allowedMentions));
    assert.match(error.message, /DISCORD_TOOL_ALLOW_MASS_MENTIONS/);
    assert.equal(calls.length, 0);
  }
});

test("mass mentions are allowed with the opt-in, and from nodes", async () => {
  for (const allowedMentions of massMentions) {
    const optedIn = await sendMessage({ allowed_mentions: allowedMentions }, { environment: { [MASS_MENTIONS_ENV]: "1" } });
    if (optedIn.error) throw optedIn.error;
    assert.deepEqual(optedIn.calls[0].json.allowed_mentions, allowedMentions);
    const node = await sendMessage({ allowed_mentions: allowedMentions }, { source: "node" });
    if (node.error) throw node.error;
  }
});

test("tool sends may ping users and keep the no-ping default", async () => {
  const users = await sendMessage({ allowed_mentions: { parse: ["users"] } });
  if (users.error) throw users.error;
  const byDefault = await sendMessage({});
  if (byDefault.error) throw byDefault.error;
  assert.deepEqual(byDefault.calls[0].json.allowed_mentions, { parse: [] });
});

test("manifest allows DISCORD_TOOL_ALLOW_MASS_MENTIONS", () => {
  assert.ok(buildManifest(pluginDefinition).permissions.env.includes(MASS_MENTIONS_ENV));
});
