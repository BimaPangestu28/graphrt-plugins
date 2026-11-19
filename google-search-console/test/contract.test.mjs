import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { clearCachedAccessTokens } from "../lib/google-auth.mjs";
import { pluginDefinition, READONLY_SCOPE, WRITE_SCOPE } from "../definition.mjs";

const API = "https://searchconsole.googleapis.com";
const SITE = "https://www.example.com/";
const ENCODED_SITE = "https%3A%2F%2Fwww.example.com%2F";
const SITEMAP = "https://www.example.com/sitemap.xml";
const ENCODED_SITEMAP = "https%3A%2F%2Fwww.example.com%2Fsitemap.xml";

describeRestPluginContract(pluginDefinition, {
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `Bearer ${credential}`),
  operations: {
    list_sites: {
      args: {},
      request: { method: "GET", url: `${API}/webmasters/v3/sites`, query: "absent" },
      response: { body: { siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] } },
      expect: { data: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] },
    },
    get_site: { args: { site_url: "sc-domain:example.com" }, request: { method: "GET", url: `${API}/webmasters/v3/sites/sc-domain%3Aexample.com`, query: "absent" } },
    add_site: { args: { site_url: SITE }, request: { method: "PUT", url: `${API}/webmasters/v3/sites/${ENCODED_SITE}`, query: "absent", body: "absent" } },
    delete_site: { args: { site_url: SITE }, request: { method: "DELETE", url: `${API}/webmasters/v3/sites/${ENCODED_SITE}`, query: "absent", body: "absent" } },
    query_search_analytics: {
      args: {
        site_url: SITE,
        start_date: "2026-10-01",
        end_date: "2026-10-31",
        dimensions: ["query", "page"],
        search_type: "web",
        dimension_filter_groups: [{ filters: [{ dimension: "country", operator: "equals", expression: "idn" }] }],
        data_state: "all",
        limit: 500,
        cursor: "500",
      },
      request: {
        method: "POST",
        url: `${API}/webmasters/v3/sites/${ENCODED_SITE}/searchAnalytics/query`,
        query: "absent",
        json: {
          startDate: "2026-10-01",
          endDate: "2026-10-31",
          dimensions: ["query", "page"],
          type: "web",
          dimensionFilterGroups: [{ filters: [{ dimension: "country", operator: "equals", expression: "idn" }] }],
          dataState: "all",
          startRow: 500,
          rowLimit: 500,
        },
      },
      response: { body: { rows: [{ keys: ["sepatu", SITE], clicks: 3, impressions: 40, ctr: 0.075, position: 7.2 }], responseAggregationType: "byPage" } },
      expect: { data: [{ keys: ["sepatu", SITE], clicks: 3, impressions: 40, ctr: 0.075, position: 7.2 }] },
    },
    list_sitemaps: {
      args: { site_url: SITE, sitemap_index: "https://www.example.com/sitemap_index.xml" },
      request: { method: "GET", url: `${API}/webmasters/v3/sites/${ENCODED_SITE}/sitemaps`, query: { sitemapIndex: "https://www.example.com/sitemap_index.xml" } },
      response: { body: { sitemap: [{ path: SITEMAP, errors: "0" }] } },
      expect: { data: [{ path: SITEMAP, errors: "0" }] },
    },
    get_sitemap: { args: { site_url: SITE, sitemap_url: SITEMAP }, request: { method: "GET", url: `${API}/webmasters/v3/sites/${ENCODED_SITE}/sitemaps/${ENCODED_SITEMAP}`, query: "absent" } },
    submit_sitemap: { args: { site_url: SITE, sitemap_url: SITEMAP }, request: { method: "PUT", url: `${API}/webmasters/v3/sites/${ENCODED_SITE}/sitemaps/${ENCODED_SITEMAP}`, query: "absent", body: "absent" } },
    delete_sitemap: { args: { site_url: SITE, sitemap_url: SITEMAP }, request: { method: "DELETE", url: `${API}/webmasters/v3/sites/${ENCODED_SITE}/sitemaps/${ENCODED_SITEMAP}`, query: "absent", body: "absent" } },
    inspect_url: {
      args: { inspection_url: `${SITE}produk/sepatu`, site_url: SITE, language_code: "id" },
      request: { method: "POST", url: `${API}/v1/urlInspection/index:inspect`, query: "absent", json: { inspectionUrl: `${SITE}produk/sepatu`, siteUrl: SITE, languageCode: "id" } },
      response: { body: { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } } },
      expect: { data: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } },
    },
  },
});

afterEach(() => clearCachedAccessTokens());

async function runSearchConsole(operationName, args, { environment = { GOOGLE_ACCESS_TOKEN: "fake-google-token" }, source = "tool", responses = [{ body: {} }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: removals are node only, writes opt-in, Google credentials and the opt-in are the env", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["delete_site", "delete_sitemap"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  for (const toolName of ["query_search_analytics", "inspect_url", "submit_sitemap", "add_site"]) assert.equal(toolNames.includes(toolName), true, toolName);
  assert.deepEqual(manifest.permissions.env.sort(), [
    "GOOGLE_ACCESS_TOKEN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
  ]);
});

test("submit_sitemap and add_site as tools need GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES=1", async () => {
  for (const [operationName, args] of [["submit_sitemap", { site_url: SITE, sitemap_url: SITEMAP }], ["add_site", { site_url: SITE }]]) {
    const refused = await runSearchConsole(operationName, args);
    assert.equal(refused.error?.kind, "permission_denied", operationName);
    assert.match(refused.error.message, /GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES/);
    assert.equal(refused.calls.length, 0);
    const allowed = await runSearchConsole(operationName, args, { environment: { GOOGLE_ACCESS_TOKEN: "fake-google-token", GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES: "1" } });
    if (allowed.error) throw allowed.error;
    assert.equal(allowed.calls[0].method, "PUT");
  }
});

test("search analytics and URL inspection POSTs are reads: retried after a 5xx", async () => {
  const unavailable = { status: 503, body: { error: { code: 503, message: "Backend Error", status: "UNAVAILABLE" } } };
  const { error, calls } = await runSearchConsole("inspect_url", { inspection_url: `${SITE}a`, site_url: SITE }, { responses: [unavailable, { body: { inspectionResult: {} } }] });
  if (error) throw error;
  assert.equal(calls.length, 2);
});

test("search analytics pages with startRow/rowLimit: next_cursor while a page is full", async () => {
  const { output, calls } = await runSearchConsole("query_search_analytics", { site_url: SITE, start_date: "2026-10-01", end_date: "2026-10-02", limit: 2 }, { responses: [{ body: { rows: [{ clicks: 1 }, { clicks: 2 }] } }] });
  assert.deepEqual([calls[0].json.startRow, calls[0].json.rowLimit], [undefined, 2], "startRow defaults to 0 on the first page");
  assert.equal(output.next_cursor, "2");
});

test("Search Console errors map by status, with v3 messages", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [403, "permission_denied", { error: { code: 403, message: "User does not have sufficient permission for site 'https://www.example.com/'.", errors: [{ reason: "forbidden" }], status: "PERMISSION_DENIED" } }],
    [429, "rate_limited", { error: { code: 429, message: "Quota exceeded for quota metric 'URL Inspection'.", status: "RESOURCE_EXHAUSTED" } }],
    [400, "invalid_input", { error: { code: 400, message: "Invalid dimension.", status: "INVALID_ARGUMENT" } }],
    [401, "auth_error", { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }],
  ];
  for (const [status, kind, body] of cases) assert.equal(parseDeclared(status, body).kind, kind, body.error.message);
});

/**
 * Writes a throwaway service account key file (a fresh RSA key, never a real credential).
 *
 * @returns Path of the key file (string)
 */
function writeThrowawayServiceAccountKey() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyFilePath = join(mkdtempSync(join(tmpdir(), "gsc-sa-")), "key.json");
  writeFileSync(keyFilePath, JSON.stringify({ type: "service_account", client_email: "fake@fake-project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
  return keyFilePath;
}

function readAssertionScope(tokenRequestBody) {
  const assertion = new URLSearchParams(String(tokenRequestBody)).get("assertion");
  return JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8")).scope;
}

test("service account tokens: webmasters.readonly for reads, webmasters only for write requests", async (context) => {
  const requestedScopes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requestedScopes.push(readAssertionScope(init.body));
    return new Response(JSON.stringify({ access_token: `fake-token-${requestedScopes.length}`, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const environment = { GOOGLE_SERVICE_ACCOUNT_JSON: writeThrowawayServiceAccountKey() };
  const read = await runSearchConsole("list_sites", {}, { environment, source: "node" });
  if (read.error) throw read.error;
  const write = await runSearchConsole("submit_sitemap", { site_url: SITE, sitemap_url: SITEMAP }, { environment, source: "node" });
  if (write.error) throw write.error;
  assert.deepEqual(requestedScopes, [READONLY_SCOPE, WRITE_SCOPE]);
  assert.equal(read.calls[0].headers.authorization, "Bearer fake-token-1");
  assert.equal(write.calls[0].headers.authorization, "Bearer fake-token-2");
});
