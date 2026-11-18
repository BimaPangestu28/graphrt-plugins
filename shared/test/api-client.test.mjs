import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../lib/api-client.mjs";

function createFakeFetch(responses) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body = {}, headers = {} } = next;
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  fakeFetch.calls = calls;
  return fakeFetch;
}

function createTestClient(fakeFetch, overrides = {}) {
  return createApiClient({
    baseUrl: "https://api.example.com/v1",
    authorize: ({ headers }) => {
      headers.authorization = "Bearer secret-token";
    },
    fetchImpl: fakeFetch,
    retryBaseDelayMs: 1,
    ...overrides,
  });
}

test("request builds the URL with query, auth header and JSON body", async () => {
  const fakeFetch = createFakeFetch([{ body: { id: "1" } }]);
  const result = await createTestClient(fakeFetch).request({
    method: "POST",
    path: "/posts",
    query: { fields: ["id", "message"], limit: 5, skip: undefined },
    json: { message: "hi" },
  });
  assert.deepEqual(result, { id: "1" });
  const [call] = fakeFetch.calls;
  assert.equal(call.url, "https://api.example.com/v1/posts?fields=id%2Cmessage&limit=5");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, "Bearer secret-token");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.equal(call.init.body, JSON.stringify({ message: "hi" }));
});

test("request sends form bodies url-encoded", async () => {
  const fakeFetch = createFakeFetch([{ body: { success: true } }]);
  await createTestClient(fakeFetch).request({ method: "POST", path: "/x", form: { is_hidden: true, message: "a b" } });
  const [call] = fakeFetch.calls;
  assert.equal(call.init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(call.init.body, "is_hidden=true&message=a+b");
});

test("request returns an empty object for 204 responses", async () => {
  const fakeFetch = createFakeFetch([{ status: 204 }]);
  assert.deepEqual(await createTestClient(fakeFetch).request({ method: "DELETE", path: "/posts/1" }), {});
});

test("request accepts an absolute pagination URL on the same origin", async () => {
  const fakeFetch = createFakeFetch([{ body: { data: [] } }]);
  await createTestClient(fakeFetch).request({ path: "https://api.example.com/v1/posts?after=abc" });
  assert.equal(fakeFetch.calls[0].url, "https://api.example.com/v1/posts?after=abc");
});

test("request refuses an absolute URL on another origin so the token never leaks", async () => {
  const fakeFetch = createFakeFetch([]);
  await assert.rejects(
    createTestClient(fakeFetch).request({ path: "https://evil.example.net/steal" }),
    (error) => error.kind === "invalid_input",
  );
  assert.equal(fakeFetch.calls.length, 0);
});

for (const [status, expectedKind] of [
  [400, "invalid_input"],
  [401, "auth_error"],
  [403, "permission_denied"],
  [404, "not_found"],
  [409, "api_error"],
]) {
  test(`request maps HTTP ${status} to ${expectedKind} with the API message`, async () => {
    const fakeFetch = createFakeFetch([{ status, body: { message: "nope from api" } }]);
    await assert.rejects(
      createTestClient(fakeFetch).request({ path: "/x" }),
      (error) => error.kind === expectedKind && error.message.includes("nope from api") && error.message.includes(String(status)),
    );
  });
}

test("request lets the platform parser override the error kind", async () => {
  const fakeFetch = createFakeFetch([{ status: 400, body: { error: { code: 190, message: "token expired" } } }]);
  const client = createTestClient(fakeFetch, {
    parseError: (status, body) => ({ message: body.error.message, kind: body.error.code === 190 ? "auth_error" : undefined }),
  });
  await assert.rejects(client.request({ path: "/x" }), (error) => error.kind === "auth_error" && /token expired/.test(error.message));
});

test("request retries 429 using Retry-After, then succeeds", async () => {
  const fakeFetch = createFakeFetch([{ status: 429, headers: { "retry-after": "0" } }, { body: { ok: true } }]);
  assert.deepEqual(await createTestClient(fakeFetch).request({ method: "POST", path: "/x" }), { ok: true });
  assert.equal(fakeFetch.calls.length, 2);
});

test("request gives up after maxRetries with a retryable rate_limited error", async () => {
  const fakeFetch = createFakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }]);
  await assert.rejects(
    createTestClient(fakeFetch, { maxRetries: 2 }).request({ path: "/x" }),
    (error) => error.kind === "rate_limited" && error.retryable === true,
  );
  assert.equal(fakeFetch.calls.length, 3);
});

test("request retries 5xx for GET but not for POST, so posts are never duplicated", async () => {
  const getFetch = createFakeFetch([{ status: 503 }, { body: { ok: true } }]);
  assert.deepEqual(await createTestClient(getFetch).request({ path: "/x" }), { ok: true });

  const postFetch = createFakeFetch([{ status: 503 }, { body: { ok: true } }]);
  await assert.rejects(
    createTestClient(postFetch).request({ method: "POST", path: "/x" }),
    (error) => error.kind === "api_error" && error.retryable === true,
  );
  assert.equal(postFetch.calls.length, 1);
});

test("request maps network failures to network_error", async () => {
  const fakeFetch = createFakeFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
  await assert.rejects(createTestClient(fakeFetch).request({ path: "/x" }), (error) => error.kind === "network_error");
});

test("request reports cancellation as cancelled", async () => {
  const fakeFetch = async (url, init) => {
    init.signal.throwIfAborted();
    return new Response("{}");
  };
  await assert.rejects(
    createTestClient(fakeFetch).request({ path: "/x", signal: AbortSignal.abort() }),
    (error) => error.kind === "cancelled",
  );
});

test("request never puts the access token in error messages", async () => {
  const fakeFetch = createFakeFetch([{ status: 500, body: { message: "boom" } }, { status: 500 }, { status: 500 }]);
  const client = createTestClient(fakeFetch, {
    authorize: ({ query }) => {
      query.access_token = "secret-token";
    },
  });
  await assert.rejects(client.request({ path: "/x" }), (error) => !error.message.includes("secret-token"));
});
