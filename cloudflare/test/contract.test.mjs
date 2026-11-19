import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.cloudflare.com/client/v4";
const ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353";
const ACCOUNT_ID = "01a7362d577a6c3019a474fd6f485823";
const RECORD_ID = "372e67954025e0ba6aaa6d586b9e0b59";
const ZONE = `${API}/zones/${ZONE_ID}`;
const WORKER = `${API}/accounts/${ACCOUNT_ID}/workers/scripts/edge-api`;
const envelope = (result, resultInfo) => ({ success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) });

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls api_request on "/anything" as a tool; the extra-paths env lets that path through.
  environment: { CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES: "*.example.com", CLOUDFLARE_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    verify_token: {
      args: {},
      request: { method: "GET", url: `${API}/user/tokens/verify`, query: "absent" },
      response: { body: envelope({ id: "tok", status: "active" }) },
      expect: { data: { id: "tok", status: "active" } },
    },
    list_accounts: { args: { limit: 50 }, request: { method: "GET", url: `${API}/accounts`, query: { per_page: "50" } } },
    list_zones: {
      args: { name: "example.com", status: "active", account_id: ACCOUNT_ID },
      request: { method: "GET", url: `${API}/zones`, query: { name: "example.com", status: "active", "account.id": ACCOUNT_ID } },
      response: { body: envelope([{ id: ZONE_ID, name: "example.com" }], { page: 1, per_page: 20, total_pages: 1 }) },
      expect: { data: [{ id: ZONE_ID, name: "example.com" }] },
    },
    get_zone: { args: { zone_id: ZONE_ID }, request: { method: "GET", url: ZONE, query: "absent" } },
    list_dns_records: {
      args: { zone_id: ZONE_ID, record_type: "CNAME", name: "www.example.com", limit: 100 },
      request: { method: "GET", url: `${ZONE}/dns_records`, query: { type: "CNAME", name: "www.example.com", per_page: "100" } },
    },
    get_dns_record: { args: { zone_id: ZONE_ID, record_id: RECORD_ID }, request: { method: "GET", url: `${ZONE}/dns_records/${RECORD_ID}`, query: "absent" } },
    create_dns_record: {
      args: { zone_id: ZONE_ID, record_type: "A", name: "api.example.com", content: "198.51.100.4", proxied: true, comment: "graphrt" },
      request: { method: "POST", url: `${ZONE}/dns_records`, query: "absent", json: { type: "A", name: "api.example.com", content: "198.51.100.4", ttl: 1, proxied: true, comment: "graphrt" } },
    },
    update_dns_record: {
      args: { zone_id: ZONE_ID, record_id: RECORD_ID, record_type: "CNAME", content: "edge.example.net", ttl: 300 },
      request: { method: "PATCH", url: `${ZONE}/dns_records/${RECORD_ID}`, query: "absent", json: { type: "CNAME", content: "edge.example.net", ttl: 300 } },
      // An agent-tool update first reads the record to check its name (see agent-policy.test.mjs).
      response: { body: envelope({ id: RECORD_ID, name: "api.example.com" }) },
    },
    verify_account_token: {
      args: { account_id: ACCOUNT_ID },
      request: { method: "GET", url: `${API}/accounts/${ACCOUNT_ID}/tokens/verify`, query: "absent" },
      response: { body: envelope({ id: "tok", status: "active" }) },
      expect: { data: { id: "tok", status: "active" } },
    },
    delete_dns_record: { args: { zone_id: ZONE_ID, record_id: RECORD_ID }, request: { method: "DELETE", url: `${ZONE}/dns_records/${RECORD_ID}`, query: "absent", body: "absent" } },
    purge_cache: {
      args: { zone_id: ZONE_ID, files: ["https://example.com/app.css"] },
      request: { method: "POST", url: `${ZONE}/purge_cache`, query: "absent", json: { files: ["https://example.com/app.css"] } },
    },
    list_workers: { args: { account_id: ACCOUNT_ID }, request: { method: "GET", url: `${API}/accounts/${ACCOUNT_ID}/workers/scripts`, query: "absent" } },
    get_worker_settings: { args: { account_id: ACCOUNT_ID, script_name: "edge-api" }, request: { method: "GET", url: `${WORKER}/settings`, query: "absent" } },
    list_worker_deployments: {
      args: { account_id: ACCOUNT_ID, script_name: "edge-api" },
      request: { method: "GET", url: `${WORKER}/deployments`, query: "absent" },
      response: { body: envelope({ deployments: [{ id: "d1" }] }) },
      expect: { data: [{ id: "d1" }] },
    },
  },
});

async function runAsTool(operationName, args, responses, extraEnvironment = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { CLOUDFLARE_API_TOKEN: "cf-test", ...extraEnvironment }, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source: "tool" }), calls: recordingFetch.calls };
}

test("page pagination uses result_info.total_pages", async () => {
  const { result, calls } = await runAsTool("list_dns_records", { zone_id: ZONE_ID, cursor: "2", limit: 5 }, [{ body: envelope([{ id: "r6" }], { page: 2, per_page: 5, total_pages: 3 }) }]);
  assert.equal(calls[0].query.page, "2");
  assert.equal(result.next_cursor, "3");
  const lastPage = await runAsTool("list_dns_records", { zone_id: ZONE_ID, cursor: "3" }, [{ body: envelope([{ id: "r11" }], { page: 3, per_page: 5, total_pages: 3 }) }]);
  assert.equal(lastPage.result.next_cursor, null);
});

test("an invalid API token (code 1000) is an auth_error with Cloudflare's message", async () => {
  const body = { success: false, errors: [{ code: 1000, message: "Invalid API Token" }], messages: [], result: null };
  await assert.rejects(runAsTool("verify_token", {}, [{ status: 401, body }]), (error) => error.kind === "auth_error" && error.message.includes("Invalid API Token (1000)"));
});

test("a 400 with an error chain shows the inner message", async () => {
  const body = { success: false, errors: [{ code: 6003, message: "", error_chain: [{ code: 6111, message: "Invalid format for Authorization header" }] }] };
  await assert.rejects(runAsTool("list_zones", {}, [{ status: 400, body }]), (error) => error.kind === "auth_error" && error.message.includes("Invalid format for Authorization header"));
});

test("DNS writes are opt-in for tools; delete and purge are node only", async () => {
  await assert.rejects(runAsTool("create_dns_record", { zone_id: ZONE_ID, record_type: "A", name: "a", content: "198.51.100.1" }, []), (error) => error.kind === "permission_denied" && error.message.includes("CLOUDFLARE_TOOL_ALLOW_WRITE"));
  const toolNames = new Set(buildManifest(pluginDefinition).tools.map((tool) => tool.name));
  assert.equal(toolNames.has("delete_dns_record"), false);
  assert.equal(toolNames.has("purge_cache"), false);
});

// graphrt reads these keys from a workflow node itself (dsl.rs), so a parameter with one of these names could never
// be set from a node.
test("no parameter uses a key graphrt reserves on workflow nodes", () => {
  const reservedKeys = ["id", "type", "title", "parent", "data", "desc", "position", "width", "height", "timeout", "timeout_ms", "retry", "retry_config", "on_error", "error_strategy", "default_value"];
  for (const operation of pluginDefinition.operations) {
    const clashes = Object.keys(operation.parameters.properties).filter((key) => reservedKeys.includes(key));
    assert.deepEqual(clashes, [], operation.name);
  }
});
