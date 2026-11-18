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
    (error) => error.kind === "api_error" && error.retryable === false,
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

test("detectBodyError turns a 200 response with an error body into a PluginError", async () => {
  const fakeFetch = createFakeFetch([{ body: { error: { code: "access_token_invalid", message: "bad token" } } }]);
  const client = createTestClient(fakeFetch, {
    detectBodyError: (body) => (body.error?.code !== "ok" ? { message: body.error.message, kind: "auth_error" } : null),
  });
  await assert.rejects(client.request({ path: "/x" }), (error) => error.kind === "auth_error" && /bad token/.test(error.message));
});

test("detectBodyError returning null keeps the response", async () => {
  const fakeFetch = createFakeFetch([{ body: { error: { code: "ok" }, data: { id: 1 } } }]);
  const client = createTestClient(fakeFetch, { detectBodyError: () => null });
  assert.deepEqual((await client.request({ path: "/x" })).data, { id: 1 });
});

test("authorize may be async", async () => {
  const fakeFetch = createFakeFetch([{ body: {} }]);
  const client = createTestClient(fakeFetch, {
    authorize: async ({ headers }) => {
      headers.authorization = "Bearer late-token";
    },
  });
  await client.request({ path: "/x" });
  assert.equal(fakeFetch.calls[0].init.headers.authorization, "Bearer late-token");
});

test("refreshCredentials is called once on 401 and the request is retried", async () => {
  let currentToken = "old-token";
  let refreshCount = 0;
  const fakeFetch = createFakeFetch([{ status: 401, body: { message: "expired" } }, { body: { ok: true } }]);
  const client = createTestClient(fakeFetch, {
    authorize: ({ headers }) => {
      headers.authorization = `Bearer ${currentToken}`;
    },
    refreshCredentials: async () => {
      refreshCount += 1;
      currentToken = "new-token";
      return true;
    },
  });
  assert.deepEqual(await client.request({ method: "POST", path: "/x" }), { ok: true });
  assert.equal(refreshCount, 1);
  assert.equal(fakeFetch.calls[1].init.headers.authorization, "Bearer new-token");
});

test("refreshCredentials returning false surfaces the auth_error", async () => {
  const fakeFetch = createFakeFetch([{ status: 401, body: { message: "expired" } }]);
  const client = createTestClient(fakeFetch, { refreshCredentials: async () => false });
  await assert.rejects(client.request({ path: "/x" }), (error) => error.kind === "auth_error");
  assert.equal(fakeFetch.calls.length, 1);
});

test("an explicitly undefined fetchImpl falls back to the global fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFakeFetch([{ body: { via: "global" } }]);
  try {
    const client = createApiClient({ baseUrl: "https://api.example.com", fetchImpl: undefined, retryBaseDelayMs: 1 });
    assert.deepEqual(await client.request({ path: "/x" }), { via: "global" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- review fixes ---
for (const sneakyPath of ["//evil.example.net/a", "/\\evil.example.net/a", "/..//evil.example.net"]) {
  test(`request refuses ${JSON.stringify(sneakyPath)} on an origin-only base URL`, async () => {
    const fakeFetch = createFakeFetch([{ body: {} }]);
    const client = createTestClient(fakeFetch, { baseUrl: "https://api.example.com" });
    await assert.rejects(client.request({ path: sneakyPath }), (error) => error.kind === "invalid_input");
    assert.equal(fakeFetch.calls.length, 0);
  });
}

test("a POST network failure is not retryable and says the outcome is unknown", async () => {
  const fakeFetch = createFakeFetch([new TypeError("fetch failed")]);
  await assert.rejects(
    createTestClient(fakeFetch).request({ method: "POST", path: "/x" }),
    (error) => error.kind === "network_error" && error.retryable === false && /outcome unknown/i.test(error.message),
  );
});

test("a POST 5xx is not retryable, a GET 5xx is", async () => {
  await assert.rejects(
    createTestClient(createFakeFetch([{ status: 500 }])).request({ method: "POST", path: "/x" }),
    (error) => error.kind === "api_error" && error.retryable === false,
  );
  await assert.rejects(
    createTestClient(createFakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }])).request({ path: "/x" }),
    (error) => error.kind === "api_error" && error.retryable === true,
  );
});

test("parseError can mark a rate limit as not retryable (e.g. daily quota)", async () => {
  const fakeFetch = createFakeFetch([{ status: 403 }, { body: {} }]);
  const client = createTestClient(fakeFetch, { parseError: () => ({ kind: "rate_limited", retryable: false, message: "quota" }) });
  await assert.rejects(client.request({ path: "/x" }), (error) => error.kind === "rate_limited" && error.retryable === false);
  assert.equal(fakeFetch.calls.length, 1);
});

test("a GET with a body is rejected before sending", async () => {
  const fakeFetch = createFakeFetch([]);
  await assert.rejects(createTestClient(fakeFetch).request({ path: "/x", json: {} }), (error) => error.kind === "invalid_input");
  assert.equal(fakeFetch.calls.length, 0);
});

test("object query values are sent as JSON", async () => {
  const fakeFetch = createFakeFetch([{ body: {} }]);
  await createTestClient(fakeFetch).request({ path: "/x", query: { filtering: [{ field: "a" }] } });
  assert.equal(new URL(fakeFetch.calls[0].url).searchParams.get("filtering"), '[{"field":"a"}]');
});

test("a failure while reading the body is classified, not thrown raw", async () => {
  const brokenFetch = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError("terminated"); } });
  await assert.rejects(
    createApiClient({ baseUrl: "https://api.example.com", fetchImpl: brokenFetch, retryBaseDelayMs: 1, maxRetries: 0 }).request({ path: "/x" }),
    (error) => error.kind === "network_error",
  );
});

test("secrets returned by authorize are redacted too", async () => {
  const fakeFetch = createFakeFetch([{ status: 400, body: { message: "bad header biz-secret-123" } }]);
  const client = createTestClient(fakeFetch, {
    authorize: ({ headers }) => {
      headers["access-token"] = "biz-secret-123";
      return ["biz-secret-123"];
    },
  });
  await assert.rejects(client.request({ path: "/x" }), (error) => !error.message.includes("biz-secret-123"));
});

test("redactResponse scrubs credentials echoed in the response body", async () => {
  const fakeFetch = createFakeFetch([{ body: { paging: { next: "https://api.example.com/v1/x?access_token=secret-token&after=A" } } }]);
  const result = await createTestClient(fakeFetch).request({ path: "/x", redactResponse: true });
  assert.equal(result.paging.next.includes("secret-token"), false);
});

test("a retry wait ends immediately when the signal is already aborted", async () => {
  const abortController = new AbortController();
  const slowFetch = async () => {
    abortController.abort();
    return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
  };
  const startedAt = Date.now();
  await assert.rejects(
    createTestClient(slowFetch).request({ path: "/x", signal: abortController.signal }),
    (error) => error.kind === "cancelled",
  );
  assert.ok(Date.now() - startedAt < 1000);
});

test("a per-request timeoutMs overrides the client timeout", async () => {
  const slowFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("{}")), 60);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    });
  const client = createTestClient(slowFetch, { timeoutMs: 10, maxRetries: 0 });
  await assert.rejects(client.request({ path: "/x" }), (error) => error.kind === "network_error");
  assert.deepEqual(await client.request({ path: "/x", timeoutMs: 500 }), {});
});
