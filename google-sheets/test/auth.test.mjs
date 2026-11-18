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
import { clearCachedAccessTokens, createAccessTokenSource } from "../lib/google-auth.mjs";
import { requestGoogleAccessToken } from "../lib/google-token-endpoint.mjs";
import { buildServiceAccountAssertion, readServiceAccountKey } from "../lib/service-account.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const OPERATION = "get_spreadsheet";
const ARGS = { spreadsheet_id: "sheet1" };
const okSpreadsheet = { body: { spreadsheetId: "sheet1" } };

test("without any credentials the error names every option", async () => {
  await assert.rejects(runWithResponses(OPERATION, ARGS, [], {}), (error) => {
    assert.equal(error.kind, "auth_error");
    for (const variableName of ["GOOGLE_REFRESH_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_ACCESS_TOKEN"]) {
      assert.match(error.message, new RegExp(variableName));
    }
    return true;
  });
});

test("an incomplete refresh trio names the missing variable", async () => {
  const { GOOGLE_CLIENT_SECRET, ...partialEnvironment } = REFRESH_ENVIRONMENT;
  assert.ok(GOOGLE_CLIENT_SECRET);
  await assert.rejects(runWithResponses(OPERATION, ARGS, [], partialEnvironment), (error) => isAuthError(error) && /missing GOOGLE_CLIENT_SECRET/.test(error.message));
});

test("with the refresh trio the plugin fetches a token from Google, then calls Sheets with it", async () => {
  const { calls } = await runWithResponses(OPERATION, ARGS, [tokenResponse("fresh-1"), okSpreadsheet], REFRESH_ENVIRONMENT);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.deepEqual(calls[0].form, {
    grant_type: "refresh_token",
    refresh_token: "refresh-secret-value",
    client_id: "client-id.apps.googleusercontent.com",
    client_secret: "client-secret-value",
  });
  assert.equal(calls[1].headers.authorization, "Bearer fresh-1");
});

test("the fetched token is cached across runs until shortly before it expires", async () => {
  await runWithResponses(OPERATION, ARGS, [tokenResponse("fresh-1"), okSpreadsheet], REFRESH_ENVIRONMENT);
  const cachedRun = await runKeepingTokenCache(OPERATION, ARGS, [okSpreadsheet], REFRESH_ENVIRONMENT);
  assert.equal(cachedRun.calls.length, 1);
  assert.equal(cachedRun.calls[0].headers.authorization, "Bearer fresh-1");
  await runWithResponses(OPERATION, ARGS, [tokenResponse("short-lived", 30), okSpreadsheet], REFRESH_ENVIRONMENT);
  const nextRun = await runKeepingTokenCache(OPERATION, ARGS, [tokenResponse("fresh-2"), okSpreadsheet], REFRESH_ENVIRONMENT);
  assert.equal(nextRun.calls[0].url, TOKEN_URL);
});

test("a 401 forces one refresh and retries; a second 401 is auth_error", async () => {
  const { calls } = await runWithResponses(OPERATION, ARGS, [tokenResponse("stale"), unauthorizedResponse, tokenResponse("fresh-2"), okSpreadsheet], REFRESH_ENVIRONMENT);
  assert.deepEqual(
    calls.map((call) => call.headers.authorization ?? call.url),
    [TOKEN_URL, "Bearer stale", TOKEN_URL, "Bearer fresh-2"],
  );
  await assert.rejects(
    runWithResponses(OPERATION, ARGS, [tokenResponse("a"), unauthorizedResponse, tokenResponse("b"), unauthorizedResponse], REFRESH_ENVIRONMENT),
    isAuthError,
  );
});

test("a node access_token is used as-is and never refreshed", async () => {
  const { calls } = await runWithResponses(OPERATION, { ...ARGS, access_token: "node-token" }, [okSpreadsheet], REFRESH_ENVIRONMENT, "node");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer node-token");
  await assert.rejects(runWithResponses(OPERATION, { ...ARGS, access_token: "node-token" }, [unauthorizedResponse, tokenResponse("x")], REFRESH_ENVIRONMENT, "node"), isAuthError);
});

test("GOOGLE_ACCESS_TOKEN alone is not retried after a 401", async () => {
  await assert.rejects(runWithResponses(OPERATION, ARGS, [unauthorizedResponse, okSpreadsheet], { GOOGLE_ACCESS_TOKEN: "env-token" }), isAuthError);
});

test("a rejected refresh token becomes auth_error without leaking secrets", async () => {
  const rejection = { status: 400, body: { error: "invalid_grant", error_description: "Bad refresh-secret-value / client-secret-value" } };
  await assert.rejects(runWithResponses(OPERATION, ARGS, [rejection], REFRESH_ENVIRONMENT), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.match(error.message, /invalid_grant/);
    assert.doesNotMatch(error.message, /refresh-secret-value|client-secret-value/);
    return true;
  });
});

test("token endpoint failures map to stable kinds and network errors are redacted", async () => {
  const cases = [
    [{ status: 401, body: { error: "invalid_client" } }, "auth_error"],
    [{ status: 429, body: { error: "rate_limit_exceeded" } }, "rate_limited"],
    [{ status: 503, body: { text: "unavailable" } }, "api_error"],
    [{ body: { token_type: "Bearer" } }, "api_error"],
  ];
  const request = { form: { grant_type: "refresh_token" }, secrets: ["secret-value"], flowName: "token refresh" };
  for (const [response, expectedKind] of cases) {
    await assert.rejects(requestGoogleAccessToken(request, createRecordingFetch([response])), (error) => error.kind === expectedKind);
  }
  const failingFetch = async () => {
    throw new Error("socket closed while sending secret-value");
  };
  await assert.rejects(requestGoogleAccessToken(request, failingFetch), (error) => error.kind === "network_error" && !/secret-value/.test(error.message));
});

test("token endpoint network errors name the cause even when its message is empty", async () => {
  const request = { form: {}, secrets: [], flowName: "token refresh" };
  const resetFetch = async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(""), { code: "ECONNRESET" }) });
  };
  await assert.rejects(requestGoogleAccessToken(request, resetFetch), (error) => error.kind === "network_error" && /ECONNRESET: fetch failed/.test(error.message));
  const timeoutFetch = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  await assert.rejects(requestGoogleAccessToken(request, timeoutFetch), (error) => /request timed out/.test(error.message) && error.retryable === true);
});

test("concurrent requests share one token fetch", async () => {
  clearCachedAccessTokens();
  const recordingFetch = createRecordingFetch([tokenResponse("shared"), tokenResponse("unused")]);
  const grant = { type: "refresh_token", refreshToken: "r", clientId: "c", clientSecret: "s" };
  const tokenSource = createAccessTokenSource({ grant }, { scope: SHEETS_SCOPE, fetchImpl: recordingFetch });
  const tokens = await Promise.all([tokenSource.getAccessToken(), tokenSource.getAccessToken(), tokenSource.getAccessToken()]);
  assert.deepEqual(tokens, ["shared", "shared", "shared"]);
  assert.equal(recordingFetch.calls.length, 1);
});

test("a service account signs an RS256 JWT, exchanges it at oauth2.googleapis.com and calls Sheets", async () => {
  const { keyFilePath, publicKey, clientEmail } = writeTestServiceAccountKey();
  const startSeconds = Math.floor(Date.now() / 1000);
  const { calls } = await runWithResponses(OPERATION, ARGS, [tokenResponse("sa-token"), okSpreadsheet], { GOOGLE_SERVICE_ACCOUNT_JSON: keyFilePath });
  assert.equal(calls[0].url, TOKEN_URL, "the key file's token_uri is ignored");
  assert.equal(calls[0].form.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const { header, claims, signingInput, signature, encodedParts } = decodeAssertion(calls[0].form.assertion);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: "key-id-1" });
  assert.equal(claims.iss, clientEmail);
  assert.equal(claims.scope, SHEETS_SCOPE);
  assert.equal(claims.aud, TOKEN_URL);
  assert.ok(claims.iat >= startSeconds && claims.iat <= startSeconds + 5);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(claims.sub, undefined);
  for (const encodedPart of encodedParts) assert.match(encodedPart, /^[A-Za-z0-9_-]+$/, "base64url without padding");
  assert.ok(verify("RSA-SHA256", Buffer.from(signingInput), publicKey, signature), "signature verifies with the public key");
  assert.equal(calls[1].headers.authorization, "Bearer sa-token");
});

test("buildServiceAccountAssertion uses the given clock and omits kid when the key has no id", async () => {
  const { keyFilePath } = writeTestServiceAccountKey({ private_key_id: undefined });
  const serviceAccountKey = await readServiceAccountKey(keyFilePath);
  const { header, claims } = decodeAssertion(buildServiceAccountAssertion(serviceAccountKey, "scope-a scope-b", 1700000000999));
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(claims.iat, 1700000000);
  assert.equal(claims.exp, 1700003600);
  assert.equal(claims.scope, "scope-a scope-b");
});

test("the service account token is cached and refreshed once on 401", async () => {
  const { keyFilePath } = writeTestServiceAccountKey();
  const environment = { GOOGLE_SERVICE_ACCOUNT_JSON: keyFilePath };
  await runWithResponses(OPERATION, ARGS, [tokenResponse("sa-1"), okSpreadsheet], environment);
  const cachedRun = await runKeepingTokenCache(OPERATION, ARGS, [unauthorizedResponse, tokenResponse("sa-2"), okSpreadsheet], environment);
  assert.deepEqual(
    cachedRun.calls.map((call) => call.headers.authorization ?? call.url),
    ["Bearer sa-1", TOKEN_URL, "Bearer sa-2"],
  );
});

test("the refresh trio takes precedence over a service account", async () => {
  const { keyFilePath } = writeTestServiceAccountKey();
  const { calls } = await runWithResponses(OPERATION, ARGS, [tokenResponse("trio"), okSpreadsheet], { ...REFRESH_ENVIRONMENT, GOOGLE_SERVICE_ACCOUNT_JSON: keyFilePath });
  assert.equal(calls[0].form.grant_type, "refresh_token");
});

test("service account key problems are auth_error, make no request and never echo the private key", async () => {
  const { privateKeyPem } = writeTestServiceAccountKey();
  const keyBody = privateKeyPem.split("\n")[1];
  const brokenJson = writeTestServiceAccountKey();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(brokenJson.keyFilePath, `{"private_key": "${keyBody}", oops`);
  const cases = [
    ["/nonexistent/key.json", /cannot be read/],
    [brokenJson.keyFilePath, /not valid JSON/],
    [writeTestServiceAccountKey({ type: "authorized_user" }).keyFilePath, /service_account/],
    [writeTestServiceAccountKey({ client_email: undefined }).keyFilePath, /client_email/],
    [writeTestServiceAccountKey({ private_key: `-----BEGIN PRIVATE KEY-----\n${keyBody}garbage\n-----END PRIVATE KEY-----\n` }).keyFilePath, /not a PEM RSA private key/],
  ];
  for (const [keyFilePath, expectedMessage] of cases) {
    const recordingFetch = createRecordingFetch([]);
    clearCachedAccessTokens();
    const { createOperationRunner } = await import("../lib/shared/operations.mjs");
    const { pluginDefinition } = await import("../definition.mjs");
    const runOperation = createOperationRunner(pluginDefinition, { GOOGLE_SERVICE_ACCOUNT_JSON: keyFilePath }, { fetchImpl: recordingFetch });
    await assert.rejects(runOperation(OPERATION, ARGS, { source: "tool" }), (error) => {
      assert.equal(error.kind, "auth_error");
      assert.match(error.message, expectedMessage);
      assert.match(error.message, /GOOGLE_SERVICE_ACCOUNT_JSON/);
      assert.ok(!error.message.includes(keyBody.slice(0, 16)), "private key material must not appear");
      return true;
    });
    assert.equal(recordingFetch.calls.length, 0);
  }
});

test("a rejected service account assertion is auth_error and the assertion is redacted", async () => {
  const { keyFilePath } = writeTestServiceAccountKey();
  let sentAssertion;
  const rejectingFetch = async (url, init) => {
    sentAssertion = new URLSearchParams(init.body).get("assertion");
    return new Response(JSON.stringify({ error: "invalid_grant", error_description: `Invalid JWT Signature. ${sentAssertion}` }), { status: 400 });
  };
  const { createOperationRunner } = await import("../lib/shared/operations.mjs");
  const { pluginDefinition } = await import("../definition.mjs");
  clearCachedAccessTokens();
  const runOperation = createOperationRunner(pluginDefinition, { GOOGLE_SERVICE_ACCOUNT_JSON: keyFilePath }, { fetchImpl: rejectingFetch });
  await assert.rejects(runOperation(OPERATION, ARGS, { source: "tool" }), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.match(error.message, /invalid_grant: Invalid JWT Signature/);
    assert.match(error.message, /robot@test-project/);
    assert.ok(!error.message.includes(sentAssertion));
    return true;
  });
});
