import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearOAuthTokenCache } from "../lib/shared/rest-oauth.mjs";
import { buildApiBaseUrl, buildTokenUrl, createZohoAuth, readDataCenter, resolveZohoCredential } from "../lib/zoho-auth.mjs";

const TRIO = { ZOHO_CLIENT_ID: "1000.CLIENT", ZOHO_CLIENT_SECRET: "client-secret-1", ZOHO_REFRESH_TOKEN: "1000.refresh-1" };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOAuthTokenCache();
});

test("data centers map to their API and accounts hosts; default us", () => {
  assert.equal(readDataCenter({}), "us");
  assert.equal(buildApiBaseUrl({}), "https://www.zohoapis.com/crm/v8");
  assert.equal(buildApiBaseUrl({ ZOHO_DATA_CENTER: "EU" }), "https://www.zohoapis.eu/crm/v8");
  assert.equal(buildApiBaseUrl({ ZOHO_DATA_CENTER: "ca" }), "https://www.zohoapis.ca/crm/v8");
  assert.equal(buildApiBaseUrl({ ZOHO_DATA_CENTER: "cn" }), "https://www.zohoapis.com.cn/crm/v8");
  assert.equal(buildTokenUrl("au"), "https://accounts.zoho.com.au/oauth/v2/token");
  assert.equal(buildTokenUrl("ca"), "https://accounts.zohocloud.ca/oauth/v2/token");
  assert.equal(buildTokenUrl("sa"), "https://accounts.zoho.sa/oauth/v2/token");
  assert.equal(buildTokenUrl("uk"), "https://accounts.zoho.uk/oauth/v2/token");
  assert.equal(buildApiBaseUrl({ ZOHO_DATA_CENTER: "uk" }), "https://www.zohoapis.uk/crm/v8");
});

test("an unknown data center is refused", () => {
  assert.throws(() => readDataCenter({ ZOHO_DATA_CENTER: "evil.example" }), (error) => error.kind === "invalid_input" && /ZOHO_DATA_CENTER/.test(error.message));
});

test("resolveZohoCredential: node token, then the refresh trio, then ZOHO_ACCESS_TOKEN; none is an auth_error", () => {
  assert.equal(resolveZohoCredential({ environment: TRIO, nodeToken: "1000.node" }), "1000.node");
  assert.equal(resolveZohoCredential({ environment: { ...TRIO, ZOHO_ACCESS_TOKEN: "1000.static" } }), null);
  assert.equal(resolveZohoCredential({ environment: { ZOHO_ACCESS_TOKEN: "1000.static" } }), "1000.static");
  assert.throws(() => resolveZohoCredential({ environment: { ZOHO_CLIENT_ID: "x" } }), (error) => error.kind === "auth_error" && /ZOHO_REFRESH_TOKEN/.test(error.message));
});

test("authorize: a credential is sent as Zoho-oauthtoken", async () => {
  const headers = {};
  const secrets = await createZohoAuth().authorize({ headers, credential: "1000.static", environment: {} });
  assert.equal(headers.authorization, "Zoho-oauthtoken 1000.static");
  assert.deepEqual(secrets, []);
});

test("authorize: the refresh trio gets a token from the data center's accounts host, cached and redacted", async () => {
  const tokenRequests = [];
  globalThis.fetch = async (url, init) => {
    tokenRequests.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify({ access_token: "1000.access-1", api_domain: "https://www.zohoapis.eu", token_type: "Bearer", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
  };
  const environment = { ...TRIO, ZOHO_DATA_CENTER: "eu" };
  const headers = {};
  const secrets = await createZohoAuth().authorize({ headers, credential: null, environment });
  await createZohoAuth().authorize({ headers: {}, credential: null, environment });
  assert.equal(tokenRequests.length, 1, "the token is cached");
  assert.equal(tokenRequests[0].url, "https://accounts.zoho.eu/oauth/v2/token");
  assert.deepEqual(tokenRequests[0].form, { grant_type: "refresh_token", refresh_token: "1000.refresh-1", client_id: "1000.CLIENT", client_secret: "client-secret-1" });
  assert.equal(headers.authorization, "Zoho-oauthtoken 1000.access-1");
  assert.ok(secrets.includes("1000.access-1") && secrets.includes("client-secret-1") && secrets.includes("1000.refresh-1"));
});

test("authorize: Zoho's 200 {error: invalid_code} for a bad refresh token is an auth_error", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_code" }), { headers: { "content-type": "application/json" } });
  await assert.rejects(createZohoAuth().authorize({ headers: {}, credential: null, environment: TRIO }), (error) => error.kind === "auth_error" && /invalid_code/.test(error.message));
});
