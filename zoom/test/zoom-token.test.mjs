import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { authorizeZoomRequest, clearZoomTokenCache, invalidateZoomToken, registerRunSignal, registerTokenFetch, ZOOM_TOKEN_URL } from "../lib/zoom-token.mjs";

const ENVIRONMENT = { ZOOM_ACCOUNT_ID: "acct-1", ZOOM_CLIENT_ID: "client-1", ZOOM_CLIENT_SECRET: "secret-xyz" };

function createTokenFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

function environmentWith(fetchImpl, overrides = {}) {
  const environment = { ...ENVIRONMENT, ...overrides };
  registerTokenFetch(environment, fetchImpl);
  return environment;
}

async function authorize(environment, credential = environment.ZOOM_CLIENT_SECRET) {
  const headers = {};
  const secrets = await authorizeZoomRequest({ headers, credential, environment });
  return { headers, secrets };
}

beforeEach(() => clearZoomTokenCache());

test("requests an account_credentials token with Basic client auth and sends it as Bearer", async () => {
  const { fetchImpl, calls } = createTokenFetch([{ body: { access_token: "tok-1", token_type: "bearer", expires_in: 3599 } }]);
  const { headers, secrets } = await authorize(environmentWith(fetchImpl));
  assert.equal(headers.authorization, "Bearer tok-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ZOOM_TOKEN_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from("client-1:secret-xyz").toString("base64")}`);
  assert.equal(calls[0].init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), { grant_type: "account_credentials", account_id: "acct-1" });
  assert.ok(secrets.includes("tok-1") && secrets.includes("secret-xyz"));
});

test("caches the token per account and client, and concurrent calls share one token request", async () => {
  const { fetchImpl, calls } = createTokenFetch([{ body: { access_token: "tok-1", expires_in: 3599 } }]);
  const environment = environmentWith(fetchImpl);
  const results = await Promise.all([authorize(environment), authorize(environment), authorize(environment)]);
  await authorize(environment);
  assert.equal(calls.length, 1);
  assert.ok(results.every(({ headers }) => headers.authorization === "Bearer tok-1"));
  const otherAccount = environmentWith(fetchImpl, { ZOOM_ACCOUNT_ID: "acct-2" });
  await authorize(otherAccount);
  assert.equal(calls.length, 2);
});

test("an expiring token is fetched again, and invalidateZoomToken drops the cached one", async () => {
  const { fetchImpl, calls } = createTokenFetch([{ body: { access_token: "short", expires_in: 30 } }, { body: { access_token: "tok-2", expires_in: 3599 } }]);
  const environment = environmentWith(fetchImpl);
  await authorize(environment);
  const { headers } = await authorize(environment);
  assert.equal(headers.authorization, "Bearer tok-2");
  invalidateZoomToken(environment);
  await authorize(environment);
  assert.equal(calls.length, 3);
});

test("a node access_token (not the client secret) is sent as Bearer without a token request", async () => {
  const { fetchImpl, calls } = createTokenFetch([]);
  const { headers, secrets } = await authorize(environmentWith(fetchImpl), "node-token-123");
  assert.equal(headers.authorization, "Bearer node-token-123");
  assert.deepEqual(secrets, ["node-token-123"]);
  assert.equal(calls.length, 0);
});

test("missing account or client id is an auth_error naming the env var", async () => {
  const { fetchImpl } = createTokenFetch([]);
  await assert.rejects(authorize(environmentWith(fetchImpl, { ZOOM_ACCOUNT_ID: " " })), (error) => error.kind === "auth_error" && /ZOOM_ACCOUNT_ID/.test(error.message));
  await assert.rejects(authorize(environmentWith(fetchImpl, { ZOOM_CLIENT_ID: undefined })), (error) => error.kind === "auth_error" && /ZOOM_CLIENT_ID/.test(error.message));
});

test("token endpoint 4xx is a non-retryable auth_error with the reason, secrets redacted", async () => {
  const { fetchImpl } = createTokenFetch([{ status: 400, body: { reason: "Invalid client_id or client_secret secret-xyz", error: "invalid_client" } }]);
  await assert.rejects(authorize(environmentWith(fetchImpl)), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.equal(error.retryable, false);
    assert.match(error.message, /invalid_client/);
    assert.doesNotMatch(error.message, /secret-xyz/);
    return true;
  });
});

test("token endpoint 5xx is a retryable api_error, and a network failure a retryable network_error", async () => {
  const serverError = createTokenFetch([{ status: 503, body: {} }]);
  await assert.rejects(authorize(environmentWith(serverError.fetchImpl)), (error) => error.kind === "api_error" && error.retryable === true);
  clearZoomTokenCache();
  const networkFailure = createTokenFetch([new TypeError("fetch failed: secret-xyz")]);
  await assert.rejects(authorize(environmentWith(networkFailure.fetchImpl)), (error) => error.kind === "network_error" && error.retryable === true && !error.message.includes("secret-xyz"));
});

function createHangingTokenFetch() {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url: String(url), init });
    return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  };
  return { fetchImpl, calls };
}

test("the token request honours the run's abort signal", async () => {
  const { fetchImpl } = createHangingTokenFetch();
  const environment = environmentWith(fetchImpl);
  const runController = new AbortController();
  registerRunSignal(environment, runController.signal);
  const pending = authorize(environment);
  runController.abort();
  await assert.rejects(pending, (error) => error.kind === "cancelled" && error.retryable === false);
});

test("a call that shares a token request cancelled by another run fetches its own token", async () => {
  const hanging = createHangingTokenFetch();
  const cancelledEnvironment = environmentWith(hanging.fetchImpl);
  const runController = new AbortController();
  registerRunSignal(cancelledEnvironment, runController.signal);
  const cancelledCall = authorize(cancelledEnvironment);
  const succeeding = createTokenFetch([{ body: { access_token: "tok-own", expires_in: 3600 } }]);
  const waitingCall = authorize(environmentWith((url, init) => (hanging.calls.length > 0 && succeeding.calls.length === 0 && init.signal !== hanging.calls[0].init.signal ? succeeding.fetchImpl(url, init) : hanging.fetchImpl(url, init))));
  runController.abort();
  await assert.rejects(cancelledCall, (error) => error.kind === "cancelled");
  assert.equal((await waitingCall).headers.authorization, "Bearer tok-own");
});

test("a 200 without access_token is an auth_error", async () => {
  const { fetchImpl } = createTokenFetch([{ body: { token_type: "bearer" } }]);
  await assert.rejects(authorize(environmentWith(fetchImpl)), (error) => error.kind === "auth_error");
});
