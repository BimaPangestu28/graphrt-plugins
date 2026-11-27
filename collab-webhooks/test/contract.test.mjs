import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeEvent, pluginDefinition, signBody } from "../definition.mjs";

const PUBLIC_HOST = async () => ["93.184.216.34"];

/** A fetch that records requests and answers with `status`. */
function recordingFetch(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    return new Response(null, { status, headers: status >= 300 && status < 400 ? { location: "https://elsewhere.example/" } : {} });
  };
  return { calls, fetchImpl };
}

function runner(environment, fake) {
  return createOperationRunner(pluginDefinition, environment, { fetchImpl: fake.fetchImpl, resolveHostAddresses: PUBLIC_HOST });
}

const EVENT = {
  event: "version.saved",
  workspace: { id: "ws_1", name: "Acme team", members: ["not sent"] },
  project: { id: "pr_1", name: "Support bot", content: { secret: "never sent" } },
  details: { version: 4, label: "before launch", by: "Ana" },
  at_ms: 1795000000000,
};

test("the manifest declares the webhook service a collaboration server runs", () => {
  const manifest = buildManifest(pluginDefinition);
  const [service] = pluginDefinition.services;
  assert.equal(service.tool, "deliver");
  assert.deepEqual(service.events, ["project.changed", "version.saved", "member.joined"]);
  assert.deepEqual(service.secrets, ["WEBHOOK_URL", "WEBHOOK_SECRET"]);
  assert.equal(service.reads_projects, false);
  assert.ok(manifest.tools.some((tool) => tool.name === "deliver"));
  // Workspace secrets arrive as the tool call's secrets: the plugin must ask for them.
  assert.equal(manifest.permissions.secrets, true);
  assert.deepEqual(manifest.permissions.env, ["COLLAB_WEBHOOK_URL", "COLLAB_WEBHOOK_SECRET"]);
});

test("a service call posts the event to the granted address, signed with the granted secret", async () => {
  const fake = recordingFetch();
  const run = runner({}, fake);
  const toolContext = { secrets: { WEBHOOK_URL: "https://hooks.example.com/abc", WEBHOOK_SECRET: "s3cret" } };
  const result = await run("deliver", EVENT, { source: "tool", toolContext });
  assert.deepEqual(result.data, { delivered: true, status: 200, event: "version.saved", signed: true });
  const [call] = fake.calls;
  assert.equal(call.url, "https://hooks.example.com/abc");
  assert.equal(call.method, "POST");
  assert.equal(call.redirect, "manual");
  const body = JSON.parse(call.body);
  assert.equal(body.text, "Ana saved version 4 “before launch” of “Support bot” in “Acme team”");
  assert.deepEqual(body.graphrt.workspace, { id: "ws_1", name: "Acme team" });
  assert.deepEqual(body.graphrt.project, { id: "pr_1", name: "Support bot" });
  assert.equal(call.body.includes("never sent"), false);
  const expected = `sha256=${createHmac("sha256", "s3cret").update(call.body).digest("hex")}`;
  assert.equal(call.headers["x-graphrt-signature"], expected);
});

test("a node posts to COLLAB_WEBHOOK_URL, unsigned without a secret", async () => {
  const fake = recordingFetch();
  const run = runner({ COLLAB_WEBHOOK_URL: "https://hooks.example.com/node" }, fake);
  const result = await run("deliver", { workspace: { name: "Ops" } }, { source: "node" });
  assert.equal(result.data.event, "test");
  assert.equal(result.data.signed, false);
  assert.equal(JSON.parse(fake.calls[0].body).text, "Test message from Graphrt for “Ops”");
  assert.equal(fake.calls[0].headers["x-graphrt-signature"], undefined);
});

test("refuses internal, plain http and redirecting webhooks, and reports failures", async () => {
  const internal = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch().fetchImpl, resolveHostAddresses: async () => ["10.0.0.5"] });
  const secrets = (url) => ({ source: "tool", toolContext: { secrets: { WEBHOOK_URL: url } } });
  await assert.rejects(internal("deliver", {}, secrets("https://intranet.example/hook")), (error) => /private/.test(error.message) && !error.message.includes("intranet.example"));
  await assert.rejects(runner({}, recordingFetch())("deliver", {}, secrets("http://hooks.example.com/x")), /https/);
  await assert.rejects(runner({}, recordingFetch())("deliver", {}, secrets("https://localhost/x")), /loopback/);
  await assert.rejects(runner({}, recordingFetch(302))("deliver", {}, secrets("https://hooks.example.com/x")), /redirect/);
  await assert.rejects(runner({}, recordingFetch(500))("deliver", {}, secrets("https://hooks.example.com/x")), /HTTP 500/);
  await assert.rejects(runner({}, recordingFetch())("deliver", {}, { source: "tool", toolContext: { secrets: {} } }), /No webhook address/);
});

test("summaries for every event, kept short", () => {
  assert.equal(describeEvent({ event: "project.changed", workspace: { name: "T" }, project: { name: "P" }, details: { by_name: "Ana" } }), "Ana changed “P” in “T”");
  assert.equal(describeEvent({ event: "member.joined", workspace: { name: "T" }, details: { account: { name: "Budi" }, role: "viewer" } }), "Budi joined “T” (viewer)");
  assert.ok(describeEvent({ event: "project.changed", workspace: { name: "x".repeat(500) }, project: { name: "y".repeat(500) } }).length <= 300);
  assert.equal(signBody("k", "{}"), `sha256=${createHmac("sha256", "k").update("{}").digest("hex")}`);
});
