import { test } from "node:test";
import assert from "node:assert/strict";
import { REFRESH_ENVIRONMENT, runKeepingTokenCache, runWithResponses } from "./helpers.mjs";
import { clearCachedAccessTokens, createAccessTokenSource, fetchAccessTokenWithRefreshToken } from "../lib/oauth.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const tokenResponse = (accessToken, expiresIn = 3599) => ({ body: { access_token: accessToken, expires_in: expiresIn, token_type: "Bearer" } });
const unauthorizedResponse = { status: 401, body: { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } } };
const isAuthError = (error) => error.kind === "auth_error";

test("without any credentials the error names both options", async () => {
  await assert.rejects(runWithResponses("get_my_channel", {}, [], {}), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.match(error.message, /YOUTUBE_ACCESS_TOKEN/);
    assert.match(error.message, /YOUTUBE_REFRESH_TOKEN/);
    assert.match(error.message, /YOUTUBE_CLIENT_ID/);
    assert.match(error.message, /YOUTUBE_CLIENT_SECRET/);
    return true;
  });
});

test("an incomplete refresh trio names the missing variable", async () => {
  const { YOUTUBE_CLIENT_SECRET, ...partialEnvironment } = REFRESH_ENVIRONMENT;
  assert.ok(YOUTUBE_CLIENT_SECRET);
  await assert.rejects(runWithResponses("get_my_channel", {}, [], partialEnvironment), (error) => isAuthError(error) && /missing YOUTUBE_CLIENT_SECRET/.test(error.message));
});

test("with the refresh trio the plugin fetches a token from Google, then calls YouTube with it", async () => {
  const { calls } = await runWithResponses("get_my_channel", {}, [tokenResponse("fresh-1"), { body: { items: [{ id: "UC1" }] } }], REFRESH_ENVIRONMENT);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].form, {
    grant_type: "refresh_token",
    refresh_token: "refresh-secret-value",
    client_id: "client-id.apps.googleusercontent.com",
    client_secret: "client-secret-value",
  });
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[1].path, "/youtube/v3/channels");
  assert.equal(calls[1].headers.authorization, "Bearer fresh-1");
});

test("the fetched token is cached across runs until shortly before it expires", async () => {
  await runWithResponses("get_my_channel", {}, [tokenResponse("fresh-1"), { body: { items: [{}] } }], REFRESH_ENVIRONMENT);
  const cachedRun = await runKeepingTokenCache("get_my_channel", {}, [{ body: { items: [{}] } }], REFRESH_ENVIRONMENT);
  assert.equal(cachedRun.calls.length, 1);
  assert.equal(cachedRun.calls[0].headers.authorization, "Bearer fresh-1");
});

test("a token that expires within 60 seconds is not reused", async () => {
  await runWithResponses("get_my_channel", {}, [tokenResponse("short-lived", 30), { body: { items: [{}] } }], REFRESH_ENVIRONMENT);
  const nextRun = await runKeepingTokenCache("get_my_channel", {}, [tokenResponse("fresh-2"), { body: { items: [{}] } }], REFRESH_ENVIRONMENT);
  assert.equal(nextRun.calls[0].url, TOKEN_URL);
  assert.equal(nextRun.calls[1].headers.authorization, "Bearer fresh-2");
});

test("a 401 forces one refresh and retries with the new token", async () => {
  const { calls, output } = await runWithResponses(
    "get_my_channel",
    {},
    [tokenResponse("stale"), unauthorizedResponse, tokenResponse("fresh-2"), { body: { items: [{ id: "UC1" }] } }],
    REFRESH_ENVIRONMENT,
  );
  assert.deepEqual(
    calls.map((call) => call.headers.authorization ?? call.url),
    [TOKEN_URL, "Bearer stale", TOKEN_URL, "Bearer fresh-2"],
  );
  assert.deepEqual(output.data, { id: "UC1" });
});

test("a second 401 after the refresh is returned as auth_error", async () => {
  await assert.rejects(
    runWithResponses("get_my_channel", {}, [tokenResponse("a"), unauthorizedResponse, tokenResponse("b"), unauthorizedResponse], REFRESH_ENVIRONMENT),
    isAuthError,
  );
});

test("with only an access token a 401 is not retried", async () => {
  const environment = { YOUTUBE_ACCESS_TOKEN: "yt-token" };
  clearCachedAccessTokens();
  await assert.rejects(runKeepingTokenCache("get_my_channel", {}, [unauthorizedResponse, { body: {} }], environment), isAuthError);
});

test("an access token is used first and the refresh trio takes over after a 401", async () => {
  const environment = { ...REFRESH_ENVIRONMENT, YOUTUBE_ACCESS_TOKEN: "expired-env-token" };
  const { calls } = await runWithResponses("get_my_channel", {}, [unauthorizedResponse, tokenResponse("fresh-3"), { body: { items: [{}] } }], environment);
  assert.deepEqual(
    calls.map((call) => call.headers.authorization ?? call.url),
    ["Bearer expired-env-token", TOKEN_URL, "Bearer fresh-3"],
  );
});

test("a node access_token overrides the environment and is never replaced by a refresh", async () => {
  const { calls } = await runWithResponses("get_my_channel", { access_token: "node-token" }, [{ body: { items: [{}] } }], REFRESH_ENVIRONMENT, "node");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer node-token");
  await assert.rejects(runWithResponses("get_my_channel", { access_token: "node-token" }, [unauthorizedResponse, tokenResponse("x")], REFRESH_ENVIRONMENT, "node"), isAuthError);
});

test("a rejected refresh token becomes auth_error without leaking secrets", async () => {
  const rejection = { status: 400, body: { error: "invalid_grant", error_description: "Bad refresh-secret-value / client-secret-value" } };
  await assert.rejects(runWithResponses("get_my_channel", {}, [rejection], REFRESH_ENVIRONMENT), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.match(error.message, /invalid_grant/);
    assert.doesNotMatch(error.message, /refresh-secret-value|client-secret-value/);
    return true;
  });
});

test("token endpoint failures map to stable kinds", async () => {
  const cases = [
    [{ status: 401, body: { error: "invalid_client" } }, "auth_error"],
    [{ status: 429, body: { error: "rate_limit_exceeded" } }, "rate_limited"],
    [{ status: 503, body: { text: "unavailable" } }, "api_error"],
    [{ body: { token_type: "Bearer" } }, "api_error"],
  ];
  for (const [response, expectedKind] of cases) {
    clearCachedAccessTokens();
    await assert.rejects(fetchAccessTokenWithRefreshToken(REFRESH_ENVIRONMENT_GRANT, createRecordingFetch([response])), (error) => error.kind === expectedKind);
  }
});

test("token endpoint network errors are redacted", async () => {
  const failingFetch = async () => {
    throw new Error("socket closed while sending refresh-secret-value");
  };
  await assert.rejects(fetchAccessTokenWithRefreshToken(REFRESH_ENVIRONMENT_GRANT, failingFetch), (error) => {
    assert.equal(error.kind, "network_error");
    assert.doesNotMatch(error.message, /refresh-secret-value/);
    return true;
  });
});

test("concurrent requests share one token refresh", async () => {
  clearCachedAccessTokens();
  const recordingFetch = createRecordingFetch([tokenResponse("shared"), tokenResponse("unused")]);
  const tokenSource = createAccessTokenSource({ refreshGrant: REFRESH_ENVIRONMENT_GRANT }, recordingFetch);
  const tokens = await Promise.all([tokenSource.getAccessToken(), tokenSource.getAccessToken(), tokenSource.getAccessToken()]);
  assert.deepEqual(tokens, ["shared", "shared", "shared"]);
  assert.equal(recordingFetch.calls.length, 1);
});

const REFRESH_ENVIRONMENT_GRANT = {
  refreshToken: REFRESH_ENVIRONMENT.YOUTUBE_REFRESH_TOKEN,
  clientId: REFRESH_ENVIRONMENT.YOUTUBE_CLIENT_ID,
  clientSecret: REFRESH_ENVIRONMENT.YOUTUBE_CLIENT_SECRET,
};

test("cancelling the run aborts a pending Google token request", { timeout: 5000 }, async () => {
  clearCachedAccessTokens();
  const tokenRequestSignals = [];
  const hangingFetch = (url, init = {}) => {
    tokenRequestSignals.push(init.signal);
    return new Promise((resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)));
  };
  const runOperation = createOperationRunner(pluginDefinition, REFRESH_ENVIRONMENT, { fetchImpl: hangingFetch });
  const cancelController = new AbortController();
  setTimeout(() => cancelController.abort(), 20);
  await assert.rejects(runOperation("get_my_channel", {}, { source: "node", signal: cancelController.signal }), (error) => error.kind === "cancelled");
  assert.equal(tokenRequestSignals.length, 1);
  assert.equal(tokenRequestSignals[0].aborted, true);
});

test("a run that is cancelled while another run's token request is pending does not break that run", async () => {
  clearCachedAccessTokens();
  let releaseTokenResponse;
  const tokenFetch = createRecordingFetch([tokenResponse("shared")]);
  const slowFetch = (url, init) => new Promise((resolve) => { releaseTokenResponse = () => resolve(tokenFetch(url, init)); });
  const tokenSource = createAccessTokenSource({ refreshGrant: REFRESH_ENVIRONMENT_GRANT }, slowFetch);
  const cancelController = new AbortController();
  const firstWaiter = tokenSource.getAccessToken();
  const cancelledWaiter = tokenSource.getAccessToken(cancelController.signal);
  cancelController.abort();
  await assert.rejects(cancelledWaiter, (error) => error.kind === "cancelled");
  releaseTokenResponse();
  assert.equal(await firstWaiter, "shared");
});

test("a partial refresh setup next to YOUTUBE_ACCESS_TOKEN is named when that token is rejected", async () => {
  const environment = { YOUTUBE_ACCESS_TOKEN: "expired-env-token", YOUTUBE_REFRESH_TOKEN: "refresh-secret-value" };
  await assert.rejects(runWithResponses("get_my_channel", {}, [unauthorizedResponse], environment), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.match(error.message, /refresh setup is incomplete: missing YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET/);
    assert.doesNotMatch(error.message, /refresh-secret-value/);
    return true;
  });
});

test("once the refresh trio replaced a rejected env token, later runs skip that token", async () => {
  const environment = { ...REFRESH_ENVIRONMENT, YOUTUBE_ACCESS_TOKEN: "expired-env-token" };
  await runWithResponses("get_my_channel", {}, [unauthorizedResponse, tokenResponse("fresh-3"), { body: { items: [{}] } }], environment);
  const laterRun = await runKeepingTokenCache("get_my_channel", {}, [{ body: { items: [{}] } }], environment);
  assert.deepEqual(laterRun.calls.map((call) => call.headers.authorization), ["Bearer fresh-3"]);
  const newEnvTokenRun = await runKeepingTokenCache("get_my_channel", {}, [{ body: { items: [{}] } }], { ...environment, YOUTUBE_ACCESS_TOKEN: "new-env-token" });
  assert.deepEqual(newEnvTokenRun.calls.map((call) => call.headers.authorization), ["Bearer new-env-token"]);
});
