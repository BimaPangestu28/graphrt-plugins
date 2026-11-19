import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpec, createScriptedFetch, runOperation, TEST_KEY, waitOrAbort } from "./fixtures/rest-test-helpers.mjs";

const leaks = (value) => JSON.stringify(value).includes(TEST_KEY);

// --- 1. credential redaction in normal results -------------------------------------------------

test("a credential echoed in a 200 body and in the Link header never reaches data or next_cursor", async () => {
  const spec = buildSpec([{ name: "list", title: "List", description: "d", path: "/items", response: { dataPath: "items", nextLinkHeader: true } }]);
  const responses = [{ body: { items: [{ self: `https://api.example.com/v1/items/1?api_key=${TEST_KEY}` }] }, headers: { link: `<https://api.example.com/v1/items?page=2&api_key=${TEST_KEY}>; rel="next"` } }];
  const { output, error } = await runOperation(spec, "list", {}, { responses, source: "tool" });
  if (error) throw error;
  assert.equal(leaks(output), false, JSON.stringify(output));
  assert.match(output.next_cursor, /page=2/);
});

test("a redacted Link cursor still works: the real credential replaces the placeholder", async () => {
  const spec = buildSpec([{ name: "list", title: "List", description: "d", path: "/items", response: { nextLinkHeader: true } }]);
  const { calls } = await runOperation(spec, "list", { cursor: "https://api.example.com/v1/items?page=2&api_key=[redacted]" }, { responses: [{ body: [] }] });
  assert.equal(new URL(calls[0].url).searchParams.get("api_key"), TEST_KEY);
  assert.equal(new URL(calls[0].url).searchParams.get("page"), "2");
});

test("a cursor read from the body is redacted", async () => {
  const spec = buildSpec([{ name: "list", title: "List", description: "d", path: "/items", response: { dataPath: "items", cursorPath: "links.next", cursorParam: "c" } }]);
  const { output } = await runOperation(spec, "list", {}, { responses: [{ body: { items: [], links: { next: `tok-${TEST_KEY}` } } }] });
  assert.equal(leaks(output), false);
});

test("job create responses, poll responses and results are redacted", async () => {
  const spec = buildSpec([jobOperation()]);
  const responses = [{ body: { id: "j1", echo: TEST_KEY } }, { body: { status: "done", output: { url: `https://cdn.example.com/a?api_key=${TEST_KEY}` } } }];
  const { output, error } = await runOperation(spec, "generate", {}, { responses });
  if (error) throw error;
  assert.equal(leaks(output), false);
  const immediate = await runOperation(spec, "generate", { wait: false }, { responses: [{ body: { id: "j1", echo: TEST_KEY } }] });
  assert.equal(leaks(immediate.output), false);
});

// --- 2. jobs: one absolute deadline ---------------------------------------------------------------

function jobOperation(overrides = {}) {
  return {
    name: "generate",
    title: "Generate",
    description: "Start a job",
    method: "POST",
    path: "/jobs",
    write: "unsafe",
    job: { idPath: "id", poll: { path: "/jobs/{id}" }, statusPath: "status", doneValues: ["done"], failedValues: ["failed"], resultPath: "output", intervalMs: 20, ...overrides.job },
    ...(overrides.download ? { download: overrides.download } : {}),
  };
}

test("the job deadline counts from the start of the call, including a slow create request", async () => {
  const spec = buildSpec([jobOperation({ job: { timeoutMs: 400 } })]);
  const fetchImpl = createScriptedFetch(async (url, init, callIndex) => {
    if (callIndex === 0) await waitOrAbort(250, init.signal);
    return { body: callIndex === 0 ? { id: "job-777" } : { status: "running" } };
  });
  const startedAt = Date.now();
  const { error } = await runOperation(spec, "generate", {}, { fetchImpl, environment: { GRAPHRT_POLL_INTERVAL_MS: "20" } });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(error?.kind, "timeout");
  assert.equal(error.retryable, false);
  assert.match(error.message, /job-777/);
  assert.ok(elapsedMs < 600, `took ${elapsedMs} ms; the 400 ms budget includes the create request`);
});

test("cancellation while polling is reported with the job id and is not retryable", async () => {
  const spec = buildSpec([jobOperation()]);
  const controller = new AbortController();
  const fetchImpl = createScriptedFetch((url, init, callIndex) => {
    if (callIndex === 1) controller.abort();
    return { body: callIndex === 0 ? { id: "job-cancel" } : { status: "running" } };
  });
  const { error } = await runOperation(spec, "generate", {}, { fetchImpl, signal: controller.signal, environment: { GRAPHRT_POLL_INTERVAL_MS: "20" } });
  assert.equal(error?.kind, "cancelled");
  assert.equal(error.retryable, false);
  assert.match(error.message, /job-cancel/);
});

test("a download that runs into the deadline becomes a per-file error entry; the job and URLs are returned", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "rest-deadline-"));
  try {
    const download = { saveTo: { urlPaths: ["url"], envDir: "PROBE_OUT" } };
    const spec = buildSpec([jobOperation({ job: { timeoutMs: 300 }, download })]);
    const fetchImpl = createScriptedFetch(async (url, init, callIndex) => {
      if (callIndex === 0) return { body: { id: "job-dl" } };
      if (callIndex === 1) return { body: { status: "done", output: { url: "https://cdn.example.com/big.mp4" } } };
      await waitOrAbort(5000, init.signal);
      return { body: "never" };
    });
    const startedAt = Date.now();
    const { output, error } = await runOperation(spec, "generate", {}, { fetchImpl, environment: { PROBE_OUT: outputDirectory } });
    if (error) throw error;
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(output.data.job_id, "job-dl");
    assert.deepEqual(output.data.result, { url: "https://cdn.example.com/big.mp4" });
    assert.equal(output.data.saved_files[0].url, "https://cdn.example.com/big.mp4");
    assert.ok(output.data.saved_files[0].error);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

// --- 4. page pagination with firstPage 0 ------------------------------------------------------------

test("page pagination with firstPage 0 stops on the last page of totalPages", async () => {
  const spec = buildSpec([{ name: "pages", title: "P", description: "d", path: "/p", response: { dataPath: "items", pagePagination: { pageParam: "page", sizeParam: "size", firstPage: 0, totalPagesPath: "totalPages" } } }]);
  const last = await runOperation(spec, "pages", { cursor: "2" }, { responses: [{ body: { items: [1], totalPages: 3 } }] });
  assert.equal(last.output.next_cursor, null);
  const middle = await runOperation(spec, "pages", { cursor: "1" }, { responses: [{ body: { items: [1], totalPages: 3 } }] });
  assert.equal(middle.output.next_cursor, "2");
  const first = await runOperation(spec, "pages", {}, { responses: [{ body: { items: [1], totalPages: 3 } }] });
  assert.equal(first.output.next_cursor, "1");
});

// --- 7. pagination styles ------------------------------------------------------------------------------

test("nextUrlPath reads the next URL from the body, including escaped dotted keys", async () => {
  const spec = buildSpec([{ name: "graph", title: "G", description: "d", path: "/users", response: { dataPath: "value", nextUrlPath: '["@odata.nextLink"]' } }]);
  const nextLink = "https://api.example.com/v1/users?$skiptoken=abc";
  const first = await runOperation(spec, "graph", {}, { responses: [{ body: { value: [1], "@odata.nextLink": nextLink } }] });
  assert.equal(first.output.next_cursor, nextLink);
  const second = await runOperation(spec, "graph", { cursor: nextLink }, { responses: [{ body: { value: [] } }] });
  assert.equal(new URL(second.calls[0].url).searchParams.get("$skiptoken"), "abc");
  assert.equal(second.output.next_cursor, null);
});

const linkSpec = () => buildSpec([{ name: "list", title: "List", description: "d", path: "/items", response: { nextLinkHeader: true } }]);

test("next-URL and Link cursors must stay under the base path, not just the origin", async () => {
  for (const escapingCursor of ["https://api.example.com/admin/users?x=1", "https://api.example.com/v10/items", "https://api.example.com/v1/../admin"]) {
    const { error, calls } = await runOperation(linkSpec(), "list", { cursor: escapingCursor }, { source: "tool" });
    assert.equal(error?.kind, "invalid_input", escapingCursor);
    assert.equal(calls.length, 0);
  }
});

test("lastItemCursor uses the last item's id as the cursor (Stripe starting_after) while has_more is true", async () => {
  const spec = buildSpec([{ name: "charges", title: "C", description: "d", path: "/charges", response: { dataPath: "data", lastItemCursor: { itemIdPath: "id", param: "starting_after", hasMorePath: "has_more" }, limitParam: "limit" } }]);
  const first = await runOperation(spec, "charges", { limit: 2 }, { responses: [{ body: { data: [{ id: "ch_1" }, { id: "ch_2" }], has_more: true } }] });
  assert.equal(first.output.next_cursor, "ch_2");
  const second = await runOperation(spec, "charges", { cursor: "ch_2", limit: 2 }, { responses: [{ body: { data: [{ id: "ch_3" }], has_more: false } }] });
  assert.equal(new URL(second.calls[0].url).searchParams.get("starting_after"), "ch_2");
  assert.equal(second.output.next_cursor, null);
});

// --- minor runtime checks ------------------------------------------------------------------------------

test("header param values with CR, LF or NUL are refused before any request", async () => {
  const spec = buildSpec([{ name: "hdr", title: "H", description: "d", path: "/h", params: { thing: { in: "header", type: "string", wireName: "X-Thing" } } }]);
  for (const injected of ["a\r\nX-Evil: 1", "a\nb", "a\u0000b"]) {
    const { error, calls } = await runOperation(spec, "hdr", { thing: injected });
    assert.equal(error?.kind, "invalid_input");
    assert.equal(calls.length, 0);
  }
});

test("api_request as a tool cannot reach the path of a nodeOnly or opt-in GET operation", async () => {
  const spec = buildSpec([
    { name: "get_secret", title: "S", description: "d", path: "/admin/keys/{key_id}", nodeOnly: true, params: { key_id: { in: "path", type: "string", required: true } } },
    { name: "list_users", title: "U", description: "d", path: "/users", toolPolicy: "optIn:PROBE_TOOL_ALLOW_USERS" },
    { name: "list_items", title: "I", description: "d", path: "/items" },
  ]);
  for (const blockedPath of ["/admin/keys/k1", "/admin/keys/k1/", "/ADMIN/keys/k1?x=1", "/users"]) {
    const { error, calls } = await runOperation(spec, "api_request", { path: blockedPath }, { source: "tool" });
    assert.equal(error?.kind, "permission_denied", blockedPath);
    assert.equal(calls.length, 0);
  }
  assert.equal((await runOperation(spec, "api_request", { path: "/users" }, { source: "tool", environment: { PROBE_TOOL_ALLOW_USERS: "1" } })).error, undefined);
  assert.equal((await runOperation(spec, "api_request", { path: "/items" }, { source: "tool" })).error, undefined);
  assert.equal((await runOperation(spec, "api_request", { path: "/admin/keys/k1" }, { source: "node" })).error, undefined);
});

test("api_request as a tool cannot reach a protected path through encoded slashes or double encoding", async () => {
  const spec = buildSpec([
    { name: "list_webhooks", title: "W", description: "d", path: "/webhooks", nodeOnly: true },
    { name: "get_secret", title: "S", description: "d", path: "/admin/keys/{key_id}", nodeOnly: true, params: { key_id: { in: "path", type: "string", required: true } } },
  ]);
  for (const blockedPath of ["/admin%2Fkeys%2Fk1", "/admin%252Fkeys%252Fk1", "%2Fwebhooks", "/webhooks%2F", "//webhooks"]) {
    const { error, calls } = await runOperation(spec, "api_request", { path: blockedPath }, { source: "tool" });
    assert.ok(error?.kind === "permission_denied" || error?.kind === "invalid_input", `${blockedPath}: ${error?.kind}`);
    assert.equal(calls.length, 0, blockedPath);
  }
});

test("allowedHostSuffix keeps a function baseUrl on the API's own domain", async () => {
  const spec = buildSpec([{ name: "me", title: "M", description: "d", path: "/me" }], {
    baseUrl: (environment) => `https://${environment.PROBE_SITE}/rest`,
    allowedHostSuffix: ".atlassian.net",
    extraEnv: ["PROBE_SITE"],
  });
  const allowed = await runOperation(spec, "me", {}, { environment: { PROBE_SITE: "acme.atlassian.net" } });
  assert.equal(new URL(allowed.calls[0].url).host, "acme.atlassian.net");
  for (const site of ["evil.com", "atlassian.net.evil.com", "evilatlassian.net"]) {
    const { error, calls } = await runOperation(spec, "me", {}, { environment: { PROBE_SITE: site } });
    assert.equal(error?.kind, "invalid_input", site);
    assert.equal(calls.length, 0);
  }
});

test("sendCredential: false sends an operation to its own host without the credential", async () => {
  const spec = buildSpec(
    [{ name: "cdn", title: "C", description: "d", baseUrl: "https://cdn.example.org", sendCredential: false, path: "/files/{name}", params: { name: { in: "path", type: "string", required: true } } }],
    { auth: { type: "bearer", env: "PROBE_KEY" } },
  );
  const { calls } = await runOperation(spec, "cdn", { name: "a.txt" });
  assert.equal(calls[0].url, "https://cdn.example.org/files/a.txt");
  assert.equal(calls[0].headers.authorization, undefined);
});

test("downloads are capped at saveTo.maxFiles URLs", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "rest-maxfiles-"));
  try {
    const spec = buildSpec([{ name: "images", title: "I", description: "d", path: "/images", download: { saveTo: { urlPaths: ["[].url"], envDir: "PROBE_OUT", maxFiles: 2 } } }]);
    const urls = ["https://cdn.example.com/1.png", "https://cdn.example.com/2.png", "https://cdn.example.com/3.png"];
    const responses = [{ body: urls.map((url) => ({ url })) }, { body: "a", headers: { "content-type": "image/png" } }, { body: "b", headers: { "content-type": "image/png" } }];
    const { output, error } = await runOperation(spec, "images", {}, { responses, environment: { PROBE_OUT: outputDirectory } });
    if (error) throw error;
    assert.equal(output.data.saved_files.length, 3);
    assert.ok(output.data.saved_files[0].path && output.data.saved_files[1].path);
    assert.match(output.data.saved_files[2].error, /maxFiles|limit/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
