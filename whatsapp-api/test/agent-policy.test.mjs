/**
 * Agent policy: every send from an agent tool needs WHATSAPP_TOOL_ALLOW_SEND=1 and a recipient in
 * WHATSAPP_TOOL_RECIPIENT_ALLOWLIST (exact E.164, or a "+digits*" prefix with at least 4 digits).
 * mark_as_read stays free, deletes are node only and workflow nodes are never limited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { buildManifest } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createPluginDefinition } from "../definition.mjs";
import { createFakeResolver } from "./helpers.mjs";

const RECIPIENT = "6281234567890";
const BASE_ENVIRONMENT = { WHATSAPP_ACCESS_TOKEN: "fake-token", WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_BUSINESS_ACCOUNT_ID: "222" };
const ALLOWED_ENVIRONMENT = { ...BASE_ENVIRONMENT, WHATSAPP_TOOL_ALLOW_SEND: "1", WHATSAPP_TOOL_RECIPIENT_ALLOWLIST: `+${RECIPIENT}` };

const SEND_CASES = [
  ["send_text", { to: RECIPIENT, body: "halo" }],
  ["send_text", { to: RECIPIENT, body: "a reply", reply_to_message_id: "wamid.A" }],
  ["send_template", { to: RECIPIENT, name: "hello_world" }],
  ["send_media", { to: RECIPIENT, media_type: "image", link: "https://img.test/a.jpg" }],
  ["send_location", { to: RECIPIENT, latitude: 1, longitude: 2 }],
  ["send_interactive_buttons", { to: RECIPIENT, body: "Pilih", buttons: ["Ya"] }],
  ["send_interactive_list", { to: RECIPIENT, body: "Pilih", button_text: "Menu", sections: [{ rows: [{ id: "a", title: "A" }] }] }],
  ["send_reaction", { to: RECIPIENT, message_id: "wamid.A", emoji: "👍" }],
];

function createRunner(environment) {
  const recordingFetch = createRecordingFetch(Array.from({ length: 20 }, () => ({ body: { messages: [{ id: "wamid.X" }] } })));
  const definition = createPluginDefinition({ resolveHostAddresses: createFakeResolver() });
  const runOperation = createOperationRunner(definition, environment, { fetchImpl: recordingFetch });
  return { runOperation, calls: recordingFetch.calls };
}

const isPermissionDenied = (pattern) => (error) => error.kind === "permission_denied" && pattern.test(error.message);

for (const [operationName, args] of SEND_CASES) {
  test(`${operationName} as a tool is refused without WHATSAPP_TOOL_ALLOW_SEND=1, before any request`, async () => {
    const { runOperation, calls } = createRunner({ ...BASE_ENVIRONMENT, WHATSAPP_TOOL_RECIPIENT_ALLOWLIST: `+${RECIPIENT}` });
    await assert.rejects(runOperation(operationName, args, { source: "tool" }), isPermissionDenied(/WHATSAPP_TOOL_ALLOW_SEND=1/));
    assert.equal(calls.length, 0);
  });

  test(`${operationName} as a tool is refused with the opt-in but no allowlist`, async () => {
    const { runOperation, calls } = createRunner({ ...BASE_ENVIRONMENT, WHATSAPP_TOOL_ALLOW_SEND: "1" });
    await assert.rejects(runOperation(operationName, args, { source: "tool" }), isPermissionDenied(/WHATSAPP_TOOL_RECIPIENT_ALLOWLIST, which is not set/));
    assert.equal(calls.length, 0);
  });

  test(`${operationName} as a tool is sent with the opt-in and an allowlisted recipient`, async () => {
    const { runOperation, calls } = createRunner(ALLOWED_ENVIRONMENT);
    await runOperation(operationName, args, { source: "tool" });
    assert.equal(calls.length, 1);
  });

  test(`${operationName} as a workflow node needs neither the opt-in nor the allowlist`, async () => {
    const { runOperation, calls } = createRunner(BASE_ENVIRONMENT);
    await runOperation(operationName, args, { source: "node" });
    assert.equal(calls.length, 1);
  });
}

test("the allowlist matches the normalised number exactly; formatting in `to` does not matter", async () => {
  const { runOperation, calls } = createRunner(ALLOWED_ENVIRONMENT);
  await runOperation("send_text", { to: "+62 812-3456-7890", body: "halo" }, { source: "tool" });
  for (const otherNumber of ["62812345678901", "628123456789", "6281234567891"]) {
    await assert.rejects(runOperation("send_text", { to: otherNumber, body: "halo" }, { source: "tool" }), isPermissionDenied(new RegExp(`not allowed: \\+${otherNumber}`)));
  }
  assert.equal(calls.length, 1);
});

test("allowlist prefixes need at least 4 digits and match by prefix", async () => {
  const prefixRunner = createRunner({ ...ALLOWED_ENVIRONMENT, WHATSAPP_TOOL_RECIPIENT_ALLOWLIST: "+62812*" });
  await prefixRunner.runOperation("send_text", { to: "6281299999999", body: "halo" }, { source: "tool" });
  await assert.rejects(prefixRunner.runOperation("send_text", { to: "6285799999999", body: "halo" }, { source: "tool" }), isPermissionDenied(/not allowed/));
  const broadRunner = createRunner({ ...ALLOWED_ENVIRONMENT, WHATSAPP_TOOL_RECIPIENT_ALLOWLIST: "+62*" });
  await assert.rejects(broadRunner.runOperation("send_text", { to: RECIPIENT, body: "halo" }, { source: "tool" }), (error) => error.kind === "invalid_input" && /at least 4 digits/.test(error.message));
  assert.equal(broadRunner.calls.length, 0);
});

test("a refused agent send does not use up the per-minute send budget", async () => {
  const { runOperation, calls } = createRunner({ ...ALLOWED_ENVIRONMENT, WHATSAPP_TOOL_SEND_RATE_LIMIT: "1" });
  await assert.rejects(runOperation("send_text", { to: "6285700000000", body: "halo" }, { source: "tool" }), isPermissionDenied(/not allowed/));
  await runOperation("send_text", { to: RECIPIENT, body: "halo" }, { source: "tool" });
  assert.equal(calls.length, 1);
});

const ACCOUNT_WRITE_CASES = [
  ["update_business_profile", { about: "Buka 24 jam" }, "WHATSAPP_TOOL_ALLOW_PROFILE"],
  ["create_template", { name: "order_update", category: "UTILITY", language: "id", components: [{ type: "BODY", text: "Pesanan dikirim" }] }, "WHATSAPP_TOOL_ALLOW_TEMPLATES"],
];

for (const [operationName, args, optInEnv] of ACCOUNT_WRITE_CASES) {
  test(`${operationName} as a tool is refused without ${optInEnv}=1, before any request`, async () => {
    // The send opt-in and the other account opt-in do not unlock it.
    const otherOptIns = { WHATSAPP_TOOL_ALLOW_PROFILE: "1", WHATSAPP_TOOL_ALLOW_TEMPLATES: "1", [optInEnv]: undefined };
    const { runOperation, calls } = createRunner({ ...ALLOWED_ENVIRONMENT, ...otherOptIns });
    await assert.rejects(runOperation(operationName, args, { source: "tool" }), isPermissionDenied(new RegExp(`${optInEnv}=1`)));
    assert.equal(calls.length, 0);
  });

  test(`${operationName} as a tool runs with ${optInEnv}=1`, async () => {
    const { runOperation, calls } = createRunner({ ...BASE_ENVIRONMENT, [optInEnv]: "1" });
    await runOperation(operationName, args, { source: "tool" });
    assert.equal(calls.length, 1);
  });

  test(`${operationName} as a workflow node needs no opt-in`, async () => {
    const { runOperation, calls } = createRunner(BASE_ENVIRONMENT);
    await runOperation(operationName, args, { source: "node" });
    assert.equal(calls.length, 1);
  });
}

test("upload_media stays a free tool", async () => {
  const recordingFetch = createRecordingFetch([{ body: "x", headers: { "content-type": "image/jpeg" } }, { body: { id: "media-1" } }]);
  const definition = createPluginDefinition({ resolveHostAddresses: createFakeResolver() });
  const runOperation = createOperationRunner(definition, BASE_ENVIRONMENT, { fetchImpl: recordingFetch });
  await runOperation("upload_media", { url: "https://img.test/a.jpg", media_type: "image" }, { source: "tool" });
  assert.equal(recordingFetch.calls.length, 2);
});

test("mark_as_read stays a free tool: no opt-in or allowlist needed", async () => {
  const { runOperation, calls } = createRunner(BASE_ENVIRONMENT);
  await runOperation("mark_as_read", { message_id: "wamid.A" }, { source: "tool" });
  assert.equal(calls.length, 1);
});

test("deletes are workflow nodes only", async () => {
  const manifest = buildManifest(createPluginDefinition());
  const toolNames = new Set(manifest.tools.map((tool) => tool.name));
  for (const operationName of ["delete_media", "delete_template"]) {
    assert.equal(toolNames.has(operationName), false, operationName);
    assert.ok(manifest.nodes.some((node) => node.kind === `whatsapp-api.${operationName}`), operationName);
  }
  const { runOperation } = createRunner(ALLOWED_ENVIRONMENT);
  await assert.rejects(runOperation("delete_media", { media_id: "m1" }, { source: "tool" }), (error) => error.kind === "invalid_input");
});

test("the manifest passes the policy envs through and tool descriptions name the opt-in", () => {
  const manifest = buildManifest(createPluginDefinition());
  assert.ok(manifest.permissions.env.includes("WHATSAPP_TOOL_ALLOW_SEND"));
  assert.ok(manifest.permissions.env.includes("WHATSAPP_TOOL_RECIPIENT_ALLOWLIST"));
  assert.ok(manifest.permissions.env.includes("WHATSAPP_TOOL_ALLOW_PROFILE"));
  assert.ok(manifest.permissions.env.includes("WHATSAPP_TOOL_ALLOW_TEMPLATES"));
  assert.match(manifest.tools.find((tool) => tool.name === "update_business_profile").description, /WHATSAPP_TOOL_ALLOW_PROFILE=1/);
  assert.match(manifest.tools.find((tool) => tool.name === "create_template").description, /WHATSAPP_TOOL_ALLOW_TEMPLATES=1/);
  const sendTool = manifest.tools.find((tool) => tool.name === "send_text");
  assert.match(sendTool.description, /WHATSAPP_TOOL_ALLOW_SEND=1/);
  assert.match(sendTool.description, /WHATSAPP_TOOL_RECIPIENT_ALLOWLIST/);
});
