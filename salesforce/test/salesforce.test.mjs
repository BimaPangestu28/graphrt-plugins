import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearOAuthTokenCache } from "../lib/shared/rest-oauth.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { pluginDefinition } from "../definition.mjs";

const INSTANCE = "https://acme.my.salesforce.com";
const REFRESH_ENV = { SALESFORCE_INSTANCE_URL: INSTANCE, SALESFORCE_CLIENT_ID: "client-1", SALESFORCE_CLIENT_SECRET: "client-secret-1", SALESFORCE_REFRESH_TOKEN: "refresh-token-1" };
const TOKEN = { body: { access_token: "00Dxx!access-1", instance_url: INSTANCE, token_type: "Bearer" } };

beforeEach(() => clearOAuthTokenCache());

async function runSalesforce(operationName, args, { environment = REFRESH_ENV, source = "tool", responses = [TOKEN, { body: {} }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: OAuth envs, instance/login URL and version are allowed; delete is not a tool", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env.sort(), [
    "SALESFORCE_API_VERSION",
    "SALESFORCE_CLIENT_ID",
    "SALESFORCE_CLIENT_SECRET",
    "SALESFORCE_INSTANCE_URL",
    "SALESFORCE_LOGIN_URL",
    "SALESFORCE_REFRESH_TOKEN",
  ]);
  const toolNames = manifest.tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("delete_record"), false);
  assert.equal(toolNames.includes("create_record"), true);
});

test("refresh token flow: token from login.salesforce.com, Bearer on the instance, token redacted", async () => {
  const { output, calls } = await runSalesforce("get_limits", {}, { responses: [TOKEN, { body: { echo: "00Dxx!access-1" } }] });
  assert.equal(calls[0].url, "https://login.salesforce.com/services/oauth2/token");
  assert.equal(new URLSearchParams(calls[0].body).get("grant_type"), "refresh_token");
  assert.equal(calls[1].url, `${INSTANCE}/services/data/v66.0/limits`);
  assert.equal(calls[1].headers.authorization, "Bearer 00Dxx!access-1");
  assert.equal(output.data.echo, "[redacted]");
});

test("client credentials flow without a refresh token: token from the org's My Domain", async () => {
  const environment = { SALESFORCE_INSTANCE_URL: INSTANCE, SALESFORCE_CLIENT_ID: "client-2", SALESFORCE_CLIENT_SECRET: "client-secret-2", SALESFORCE_API_VERSION: "62.0" };
  const { error, calls } = await runSalesforce("get_limits", {}, { environment });
  if (error) throw error;
  assert.equal(calls[0].url, `${INSTANCE}/services/oauth2/token`);
  assert.equal(new URLSearchParams(calls[0].body).get("grant_type"), "client_credentials");
  assert.equal(calls[1].url, `${INSTANCE}/services/data/v62.0/limits`);
});

test("an expired session (INVALID_SESSION_ID) refreshes the token once and retries", async () => {
  const expired = { status: 401, body: [{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }] };
  const { output, calls } = await runSalesforce("get_limits", {}, { responses: [TOKEN, expired, { body: { access_token: "00Dxx!access-2" } }, { body: { ok: 1 } }] });
  assert.deepEqual(output.data, { ok: 1 });
  assert.equal(calls[3].headers.authorization, "Bearer 00Dxx!access-2");
});

test("an instance URL outside Salesforce is refused before any request", async () => {
  const { error, calls } = await runSalesforce("get_limits", {}, { environment: { ...REFRESH_ENV, SALESFORCE_INSTANCE_URL: "https://acme.my.salesforce.com.evil.example" } });
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("missing credentials are an auth_error naming the env", async () => {
  const { error, calls } = await runSalesforce("get_limits", {}, { environment: { SALESFORCE_INSTANCE_URL: INSTANCE } });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /SALESFORCE_CLIENT_ID|SALESFORCE_CLIENT_SECRET|SALESFORCE_REFRESH_TOKEN/);
  assert.equal(calls.length, 0);
});

test("Salesforce error arrays map to kinds with the message and code", () => {
  const parseError = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [403, "rate_limited", [{ message: "TotalRequests Limit exceeded.", errorCode: "REQUEST_LIMIT_EXCEEDED" }]],
    [400, "invalid_input", [{ message: "unexpected token: FORM", errorCode: "MALFORMED_QUERY" }]],
    [404, "not_found", [{ message: "The requested resource does not exist", errorCode: "NOT_FOUND" }]],
    [403, "permission_denied", [{ message: "insufficient access rights on object id", errorCode: "INSUFFICIENT_ACCESS_OR_READONLY" }]],
  ];
  for (const [status, kind, body] of cases) {
    const error = parseError(status, body);
    assert.equal(error.kind, kind, body[0].errorCode);
    assert.match(error.message, new RegExp(body[0].errorCode));
  }
});

test("query_more takes a queryAll nextRecordsUrl too", async () => {
  const { calls } = await runSalesforce("query_more", { query_locator: "/services/data/v66.0/queryAll/01gD0000002HU6KIAW-4000" });
  assert.equal(calls[1].url, `${INSTANCE}/services/data/v66.0/query/01gD0000002HU6KIAW-4000`);
});
