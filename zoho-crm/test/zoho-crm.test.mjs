import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearOAuthTokenCache } from "../lib/shared/rest-oauth.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { pluginDefinition } from "../definition.mjs";

const TRIO = { ZOHO_CLIENT_ID: "1000.CLIENT", ZOHO_CLIENT_SECRET: "client-secret-1", ZOHO_REFRESH_TOKEN: "1000.refresh-1" };
const INVALID_TOKEN = { status: 401, body: { code: "INVALID_TOKEN", details: {}, message: "invalid oauth token", status: "error" } };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOAuthTokenCache();
});

// Token requests go through globalThis.fetch; API requests through the recording fetch.
function stubTokenEndpoint(accessTokens) {
  const tokenRequests = [];
  globalThis.fetch = async (url) => {
    tokenRequests.push(String(url));
    const accessToken = accessTokens[Math.min(tokenRequests.length - 1, accessTokens.length - 1)];
    return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), { headers: { "content-type": "application/json" } });
  };
  return tokenRequests;
}

async function runZoho(operationName, args, { environment = TRIO, source = "tool", responses = [{ body: {} }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: Zoho envs are allowed; delete is not a tool", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env.sort(), ["ZOHO_ACCESS_TOKEN", "ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_CRM_TOOL_TOKEN_SOURCE", "ZOHO_DATA_CENTER", "ZOHO_REFRESH_TOKEN"]);
  const toolNames = manifest.tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("delete_records"), false);
  assert.equal(toolNames.includes("insert_records"), true);
});

test("the refresh trio: token from the data center's accounts host, API on its zohoapis host, token redacted", async () => {
  const tokenRequests = stubTokenEndpoint(["1000.access-1"]);
  const { output, calls } = await runZoho("get_org", {}, { environment: { ...TRIO, ZOHO_DATA_CENTER: "in" }, responses: [{ body: { org: [{ id: "o1", echo: "1000.access-1" }] } }] });
  assert.deepEqual(tokenRequests, ["https://accounts.zoho.in/oauth/v2/token"]);
  assert.equal(calls[0].url, "https://www.zohoapis.in/crm/v8/org");
  assert.equal(calls[0].headers.authorization, "Zoho-oauthtoken 1000.access-1");
  assert.equal(output.data.echo, "[redacted]");
});

test("INVALID_TOKEN on a cached token: one fresh token and one retry", async () => {
  const tokenRequests = stubTokenEndpoint(["1000.access-1", "1000.access-2"]);
  const { output, calls } = await runZoho("insert_records", { module: "Leads", records: [{ Last_Name: "Daly" }] }, { responses: [INVALID_TOKEN, { status: 201, body: { data: [{ code: "SUCCESS" }] } }] });
  assert.equal(tokenRequests.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.authorization, "Zoho-oauthtoken 1000.access-2");
  assert.deepEqual(output.data, { data: [{ code: "SUCCESS" }] });
});

test("INVALID_TOKEN with a static ZOHO_ACCESS_TOKEN is not retried", async () => {
  const { error, calls } = await runZoho("get_org", {}, { environment: { ZOHO_ACCESS_TOKEN: "1000.static" }, responses: [INVALID_TOKEN] });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /invalid oauth token \(INVALID_TOKEN\)/);
  assert.equal(calls.length, 1);
});

test("no credential at all is an auth_error before any request; a bad data center is invalid_input", async () => {
  const missing = await runZoho("get_org", {}, { environment: {} });
  assert.equal(missing.error.kind, "auth_error");
  assert.equal(missing.calls.length, 0);
  const badDataCenter = await runZoho("get_org", {}, { environment: { ZOHO_ACCESS_TOKEN: "1000.static", ZOHO_DATA_CENTER: "evil.example" } });
  assert.equal(badDataCenter.error.kind, "invalid_input");
  assert.equal(badDataCenter.calls.length, 0);
});

test("api_request as a tool reads records and metadata, not Deluge variables, watch channels or encoded bypasses", async () => {
  const refusedPaths = ["/settings/variables", "/settings/variables/1", "/actions/watch", "/Leads/%2e%2e/settings/variables", "/Leads/%252e%252e/actions/watch", "/settings/modules/%2e%2e/variables", "/Leads/a%2f..%2f..%2factions%2fwatch"];
  for (const path of refusedPaths) {
    const refused = await runZoho("api_request", { path }, { environment: { ZOHO_ACCESS_TOKEN: "1000.static" } });
    assert.equal(refused.error?.kind, "permission_denied", path);
    assert.equal(refused.calls.length, 0, path);
  }
  for (const path of ["/Leads/4876876000000376008/Notes", "/settings/layouts?module=Leads", "/users", "/org", "/Deals/search"]) {
    const allowed = await runZoho("api_request", { path }, { environment: { ZOHO_ACCESS_TOKEN: "1000.static" } });
    if (allowed.error) throw allowed.error;
  }
  const fromNode = await runZoho("api_request", { path: "/settings/variables" }, { source: "node", environment: { ZOHO_ACCESS_TOKEN: "1000.static" } });
  if (fromNode.error) throw fromNode.error;
});

test("search_records needs one of criteria, email, phone or word before any request", async () => {
  const { error, calls } = await runZoho("search_records", { module: "Leads", converted: "both" }, { environment: { ZOHO_ACCESS_TOKEN: "1000.static" } });
  assert.equal(error?.kind, "invalid_input");
  assert.match(error.message, /criteria, email, phone or word/);
  assert.equal(calls.length, 0);
});

test("update_records is never retried after a 5xx (workflows may have run)", async () => {
  const { error, calls } = await runZoho("update_records", { module: "Leads", records: [{ id: "1", Lead_Status: "Contacted" }] }, {
    environment: { ZOHO_ACCESS_TOKEN: "1000.static" },
    responses: [{ status: 500, body: { code: "INTERNAL_ERROR", message: "internal error", status: "error" } }, { body: { data: [] } }],
  });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
});

test("Zoho error bodies map to kinds", () => {
  const parseError = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [401, "permission_denied", { code: "OAUTH_SCOPE_MISMATCH", details: {}, message: "invalid oauth scope to access this URL", status: "error" }],
    [404, "not_found", { code: "INVALID_URL_PATTERN", details: {}, message: "Please check if the URL trying to access is a correct one", status: "error" }],
    [400, "invalid_input", { code: "INVALID_QUERY", details: {}, message: "invalid query formed", status: "error" }],
    [429, "rate_limited", { code: "TOO_MANY_REQUESTS", details: {}, message: "too many requests", status: "error" }],
  ];
  for (const [status, kind, body] of cases) assert.equal(parseError(status, body).kind, kind, body.code);
});
