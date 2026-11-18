import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import {
  REFRESH_ENVIRONMENT,
  TOKEN_URL,
  decodeAssertion,
  isAuthError,
  runKeepingTokenCache,
  runWithResponses,
  tokenResponse,
  unauthorizedResponse,
  writeTestServiceAccountKey,
} from "./helpers.mjs";

const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";
const okAccounts = { body: { accounts: [{ name: "accounts/1" }] } };

test("without credentials the error names every option", async () => {
  await assert.rejects(runWithResponses("list_accounts", {}, [], {}), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.match(error.message, /GOOGLE_REFRESH_TOKEN/);
    assert.match(error.message, /GOOGLE_SERVICE_ACCOUNT_JSON/);
    return true;
  });
  const { GOOGLE_CLIENT_ID, ...partialEnvironment } = REFRESH_ENVIRONMENT;
  assert.ok(GOOGLE_CLIENT_ID);
  await assert.rejects(runWithResponses("list_accounts", {}, [], partialEnvironment), (error) => isAuthError(error) && /missing GOOGLE_CLIENT_ID/.test(error.message));
});

test("the refresh trio fetches a token once and the cache serves every host", async () => {
  const { calls } = await runWithResponses("list_accounts", {}, [tokenResponse("fresh-1"), okAccounts], REFRESH_ENVIRONMENT);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].form.grant_type, "refresh_token");
  assert.equal(calls[1].headers.authorization, "Bearer fresh-1");
  const performanceRun = await runKeepingTokenCache(
    "get_daily_metrics",
    { location_id: "9", start_date: "2026-11-01", end_date: "2026-11-02" },
    [{ body: {} }],
    REFRESH_ENVIRONMENT,
  );
  assert.equal(performanceRun.calls.length, 1);
  assert.equal(new URL(performanceRun.calls[0].url).host, "businessprofileperformance.googleapis.com");
  assert.equal(performanceRun.calls[0].headers.authorization, "Bearer fresh-1");
});

test("a 401 refreshes once and retries; a node access_token is never refreshed", async () => {
  const { calls } = await runWithResponses("list_accounts", {}, [tokenResponse("stale"), unauthorizedResponse, tokenResponse("fresh"), okAccounts], REFRESH_ENVIRONMENT);
  assert.deepEqual(
    calls.map((call) => call.headers.authorization ?? call.url),
    [TOKEN_URL, "Bearer stale", TOKEN_URL, "Bearer fresh"],
  );
  await assert.rejects(runWithResponses("list_accounts", { access_token: "node-token" }, [unauthorizedResponse, tokenResponse("x")], REFRESH_ENVIRONMENT, "node"), isAuthError);
});

test("a service account signs an RS256 JWT for the business.manage scope", async () => {
  const { keyFilePath, publicKey, clientEmail } = writeTestServiceAccountKey();
  const { calls } = await runWithResponses("list_accounts", {}, [tokenResponse("sa-token"), okAccounts], { GOOGLE_SERVICE_ACCOUNT_JSON: keyFilePath });
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].form.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const { header, claims, signingInput, signature } = decodeAssertion(calls[0].form.assertion);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: "key-id-1" });
  assert.deepEqual({ iss: claims.iss, scope: claims.scope, aud: claims.aud, lifetime: claims.exp - claims.iat }, { iss: clientEmail, scope: BUSINESS_SCOPE, aud: TOKEN_URL, lifetime: 3600 });
  assert.ok(verify("RSA-SHA256", Buffer.from(signingInput), publicKey, signature));
  assert.equal(calls[1].headers.authorization, "Bearer sa-token");
});

test("a rejected refresh token is auth_error without secrets", async () => {
  const rejection = { status: 401, body: { error: "invalid_client", error_description: "The OAuth client was not found. client-secret-value" } };
  await assert.rejects(runWithResponses("list_accounts", {}, [rejection], REFRESH_ENVIRONMENT), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.match(error.message, /invalid_client/);
    assert.doesNotMatch(error.message, /client-secret-value|refresh-secret-value/);
    return true;
  });
});
