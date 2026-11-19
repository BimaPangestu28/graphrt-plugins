import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { matchesDnsAllowlist } from "../lib/cloudflare-wrappers.mjs";
import { pluginDefinition } from "../definition.mjs";

const ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353";
const RECORD_ID = "372e67954025e0ba6aaa6d586b9e0b59";
const envelope = (result) => ({ success: true, errors: [], messages: [], result });
const writeEnvironment = { CLOUDFLARE_TOOL_ALLOW_WRITE: "1", CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES: "api.example.com, *.preview.example.com" };

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: envelope({ id: RECORD_ID }) }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { CLOUDFLARE_API_TOKEN: "cf-test", ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("matchesDnsAllowlist matches exact names and *.suffix wildcards, case- and trailing-dot-insensitive", () => {
  const allowlist = "api.example.com, *.preview.example.com";
  assert.equal(matchesDnsAllowlist("API.example.com.", allowlist), true);
  assert.equal(matchesDnsAllowlist("pr-12.preview.example.com", allowlist), true);
  assert.equal(matchesDnsAllowlist("a.b.preview.example.com", allowlist), true);
  assert.equal(matchesDnsAllowlist("preview.example.com", allowlist), false);
  assert.equal(matchesDnsAllowlist("www.example.com", allowlist), false);
  assert.equal(matchesDnsAllowlist("evilpreview.example.com", allowlist), false);
  assert.equal(matchesDnsAllowlist("@", allowlist), false);
  assert.equal(matchesDnsAllowlist("api.example.com", ""), false);
});

test("tools cannot create DNS records without CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES, even with the write opt-in", async () => {
  const args = { zone_id: ZONE_ID, record_type: "A", name: "api.example.com", content: "198.51.100.4" };
  await assert.rejects(run("create_dns_record", args, { environment: { CLOUDFLARE_TOOL_ALLOW_WRITE: "1" } }), (error) => error.kind === "permission_denied" && error.message.includes("CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES"));
  await assert.rejects(run("create_dns_record", { ...args, name: "www.example.com" }, { environment: writeEnvironment }), (error) => error.kind === "permission_denied" && error.message.includes("www.example.com"));
  const { calls } = await run("create_dns_record", { ...args, name: "pr-7.preview.example.com" }, { environment: writeEnvironment });
  assert.equal(calls.length, 1);
});

test("without the write opt-in the refusal names CLOUDFLARE_TOOL_ALLOW_WRITE", async () => {
  const args = { zone_id: ZONE_ID, record_type: "A", name: "api.example.com", content: "198.51.100.4" };
  await assert.rejects(run("create_dns_record", args, { environment: { CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES: "api.example.com" } }), (error) => error.message.includes("CLOUDFLARE_TOOL_ALLOW_WRITE"));
});

test("a tool update checks the existing record's name before changing it", async () => {
  const existingWww = { body: envelope({ id: RECORD_ID, name: "www.example.com", type: "A" }) };
  await assert.rejects(
    run("update_dns_record", { zone_id: ZONE_ID, record_id: RECORD_ID, content: "203.0.113.9" }, { environment: writeEnvironment, responses: [existingWww] }),
    (error) => error.kind === "permission_denied" && error.message.includes("www.example.com"),
  );
  const existingApi = { body: envelope({ id: RECORD_ID, name: "api.example.com", type: "A" }) };
  const allowed = await run("update_dns_record", { zone_id: ZONE_ID, record_id: RECORD_ID, content: "203.0.113.9" }, { environment: writeEnvironment, responses: [existingApi, { body: envelope({ id: RECORD_ID }) }] });
  assert.equal(allowed.calls[0].method, "GET");
  assert.equal(allowed.calls[0].url, `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}`);
  assert.equal(allowed.calls[1].method, "PATCH");
});

test("a tool update cannot rename an allowed record to a name outside the allowlist", async () => {
  const existingApi = { body: envelope({ id: RECORD_ID, name: "api.example.com" }) };
  await assert.rejects(
    run("update_dns_record", { zone_id: ZONE_ID, record_id: RECORD_ID, name: "www.example.com" }, { environment: writeEnvironment, responses: [existingApi] }),
    (error) => error.kind === "permission_denied" && error.message.includes("www.example.com"),
  );
});

test("a tool update refuses traversal in the ids before the pre-check request", async () => {
  await assert.rejects(run("update_dns_record", { zone_id: "..", record_id: RECORD_ID, content: "x" }, { environment: writeEnvironment, responses: [] }), (error) => error.kind === "invalid_input");
});

test("workflow nodes change any record without the allowlist and without the pre-check", async () => {
  const { calls } = await run("update_dns_record", { zone_id: ZONE_ID, record_id: RECORD_ID, content: "203.0.113.9" }, { source: "node" });
  assert.deepEqual(calls.map((call) => call.method), ["PATCH"]);
});

test("tool calls of list_zones and list_accounts send at least per_page=5 (Cloudflare's minimum); nodes send as configured", async () => {
  const zones = await run("list_zones", { limit: 2 }, { responses: [{ body: envelope([]) }] });
  assert.equal(zones.calls[0].query.per_page, "5");
  const accounts = await run("list_accounts", { limit: 20 }, { responses: [{ body: envelope([]) }] });
  assert.equal(accounts.calls[0].query.per_page, "20");
  const nodeCall = await run("list_zones", { limit: 2 }, { source: "node", responses: [{ body: envelope([]) }] });
  assert.equal(nodeCall.calls[0].query.per_page, "2");
});

const BLOCKED_PATHS = [
  "/accounts/a/cfd_tunnel/t/token",
  "/accounts/a/warp_connector/w/token",
  "/accounts/a/workers/scripts/w/content/v2",
  "/accounts/a/workers/scripts/w",
  "/accounts/a/workers/scripts/w/secrets",
  "/accounts/a/tokens",
  "/user/tokens",
  "/accounts/a/storage/kv/namespaces/n/values/k",
  "/accounts/a/pages/projects/site",
  "/zones/z/dns_records/../../../accounts/a/tokens",
  "/zones/z/%2E%2E/%2E%2E/user/tokens",
  "/accounts/a/access/service_tokens",
  "/zones/z/keyless_certificates",
];
for (const blockedPath of BLOCKED_PATHS) {
  test(`tools cannot reach ${blockedPath} through api_request`, async () => {
    await assert.rejects(run("api_request", { path: blockedPath }), (error) => error.kind === "permission_denied");
  });
}

for (const allowedPath of ["/zones", `/zones/${ZONE_ID}/settings/ssl`, `/zones/${ZONE_ID}/dns_records/export`, "/accounts/a/workers/scripts/w/versions"]) {
  test(`tools may read ${allowedPath} through api_request`, async () => {
    const { calls } = await run("api_request", { path: allowedPath }, { responses: [{ body: envelope([]) }] });
    assert.equal(calls.length, 1);
  });
}
