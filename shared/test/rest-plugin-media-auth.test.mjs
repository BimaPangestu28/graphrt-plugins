import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearOAuthTokenCache } from "../lib/rest-oauth.mjs";
import { buildSpec, createScriptedFetch, runOperation } from "./fixtures/rest-test-helpers.mjs";

async function withOutputDirectory(runWithDirectory) {
  const directory = await mkdtemp(join(tmpdir(), "rest-media-"));
  try {
    return await runWithDirectory(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// --- b. binary responses ----------------------------------------------------------------------------

const speechSpec = () =>
  buildSpec([
    { name: "speak", title: "S", description: "d", method: "POST", write: "unsafe", path: "/audio/speech", params: { input: { in: "body", type: "string", required: true } }, response: { binary: { envDir: "PROBE_OUT", maxBytes: 1024 } } },
  ]);

test("a binary response is streamed to a file in the env directory", async () => {
  await withOutputDirectory(async (directory) => {
    const fetchImpl = createScriptedFetch(() => new Response(Buffer.from([0xff, 0xfb, 0x90, 0x00]), { headers: { "content-type": "audio/mpeg" } }));
    const { output, error } = await runOperation(speechSpec(), "speak", { input: "hi" }, { fetchImpl, environment: { PROBE_OUT: directory } });
    if (error) throw error;
    assert.equal(output.data.content_type, "audio/mpeg");
    assert.equal(output.data.bytes, 4);
    assert.ok(output.data.path.startsWith(directory) && output.data.path.endsWith(".mp3"));
    assert.deepEqual([...(await readFile(output.data.path))], [0xff, 0xfb, 0x90, 0x00]);
  });
});

test("a binary response needs its output directory and respects maxBytes", async () => {
  await withOutputDirectory(async (directory) => {
    const missingDirectory = await runOperation(speechSpec(), "speak", { input: "hi" });
    assert.equal(missingDirectory.error?.kind, "invalid_input");
    assert.match(missingDirectory.error.message, /PROBE_OUT/);
    const tooLarge = createScriptedFetch(() => new Response(Buffer.alloc(2048), { headers: { "content-type": "audio/mpeg" } }));
    const { error } = await runOperation(speechSpec(), "speak", { input: "hi" }, { fetchImpl: tooLarge, environment: { PROBE_OUT: directory } });
    assert.equal(error?.kind, "invalid_input");
  });
});

// --- c. base64 fields --------------------------------------------------------------------------------

test("base64 fields are decoded to files and replaced in the result by the saved path", async () => {
  await withOutputDirectory(async (directory) => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const spec = buildSpec([
      { name: "image", title: "I", description: "d", method: "POST", write: "unsafe", path: "/images", params: {}, download: { saveTo: { base64Paths: ["data[].b64_json"], envDir: "PROBE_OUT" } } },
    ]);
    const responses = [{ body: { data: [{ b64_json: pngBytes.toString("base64"), revised_prompt: "p" }] } }];
    const { output, error } = await runOperation(spec, "image", {}, { responses, environment: { PROBE_OUT: directory } });
    if (error) throw error;
    const [savedFile] = output.data.saved_files;
    assert.ok(savedFile.path.endsWith(".png"));
    assert.equal(savedFile.content_type, "image/png");
    assert.deepEqual(await readFile(savedFile.path), pngBytes);
    assert.equal(output.data.result.data[0].b64_json, `[saved to ${savedFile.path}]`);
    assert.equal(output.data.result.data[0].revised_prompt, "p");
  });
});

// --- g. jobs with poll and result URLs from the create response --------------------------------------

const urlJobSpec = (jobOverrides = {}) =>
  buildSpec(
    [
      {
        name: "predict",
        title: "P",
        description: "d",
        method: "POST",
        write: "unsafe",
        path: "/predictions",
        params: {},
        job: { idPath: "request_id", poll: { urlPath: "status_url" }, statusPath: "status", doneValues: ["COMPLETED"], result: { urlPath: "response_url" }, resultPath: "images", allowedHosts: ["queue.example.net"], intervalMs: 0, ...jobOverrides },
      },
    ],
    { auth: { type: "header", header: "Authorization", prefix: "Key ", env: "PROBE_KEY" } },
  );

test("a job can poll the status URL and fetch the result URL from the create response", async () => {
  const responses = [
    { body: { request_id: "r1", status_url: "https://queue.example.net/r/r1/status", response_url: "https://queue.example.net/r/r1" } },
    { body: { status: "IN_PROGRESS" } },
    { body: { status: "COMPLETED" } },
    { body: { images: [{ url: "https://cdn.example.com/1.png" }] } },
  ];
  const { output, calls, error } = await runOperation(urlJobSpec(), "predict", {}, { responses });
  if (error) throw error;
  assert.equal(calls[1].url, "https://queue.example.net/r/r1/status");
  assert.equal(calls[3].url, "https://queue.example.net/r/r1");
  assert.equal(calls[3].headers.authorization, "Key secret-key-123456");
  assert.deepEqual(output.data, { job_id: "r1", status: "COMPLETED", result: [{ url: "https://cdn.example.com/1.png" }] });
});

test("a poll or result URL on a host that is not allowed is refused, naming the job", async () => {
  for (const statusUrl of ["https://evil.example.com/r/r1/status", "http://queue.example.net/r/r1/status"]) {
    const { error, calls } = await runOperation(urlJobSpec(), "predict", {}, { responses: [{ body: { request_id: "r1", status_url: statusUrl, response_url: "https://queue.example.net/r/r1" } }] });
    assert.equal(error?.kind, "api_error", statusUrl);
    assert.equal(error.retryable, false);
    assert.match(error.message, /r1/);
    assert.equal(calls.length, 1, "no request to the refused URL");
  }
});

// --- f. OAuth2 ------------------------------------------------------------------------------------------

beforeEach(() => clearOAuthTokenCache());

const oauthSpec = (authOverrides = {}) =>
  buildSpec([{ name: "me", title: "M", description: "d", path: "/me" }], {
    auth: { type: "oauth2", grant: "client_credentials", tokenUrl: "https://auth.example.com/oauth/token", clientIdEnv: "PROBE_CLIENT_ID", clientSecretEnv: "PROBE_CLIENT_SECRET", scope: "read", ...authOverrides },
  });
const OAUTH_ENV = { PROBE_CLIENT_ID: "client-1", PROBE_CLIENT_SECRET: "client-secret-xyz", PROBE_REFRESH_TOKEN: "refresh-abc-123" };

test("oauth2 client_credentials fetches a token once, caches it and sends it as Bearer", async () => {
  const fetchImpl = createScriptedFetch((url) => (url.startsWith("https://auth.") ? { body: { access_token: "at-1", expires_in: 3600 } } : { body: { id: "me" } }));
  await runOperation(oauthSpec(), "me", {}, { fetchImpl, environment: OAUTH_ENV });
  const { output } = await runOperation(oauthSpec(), "me", {}, { fetchImpl, environment: OAUTH_ENV });
  const tokenCalls = fetchImpl.calls.filter((call) => call.url.startsWith("https://auth."));
  assert.equal(tokenCalls.length, 1);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenCalls[0].init.body)), { grant_type: "client_credentials", client_id: "client-1", client_secret: "client-secret-xyz", scope: "read" });
  assert.equal(fetchImpl.calls.at(-1).headers.authorization, "Bearer at-1");
  assert.deepEqual(output.data, { id: "me" });
});

test("oauth2 refresh_token grant refreshes once on 401 and retries with the new token", async () => {
  let issuedTokens = 0;
  const fetchImpl = createScriptedFetch((url, init) => {
    if (url.startsWith("https://auth.")) return { body: { access_token: `at-${(issuedTokens += 1)}`, expires_in: 3600 } };
    return init.headers.authorization === "Bearer at-1" ? { status: 401, body: { message: "expired" } } : { body: { ok: true } };
  });
  const spec = oauthSpec({ grant: "refresh_token", refreshTokenEnv: "PROBE_REFRESH_TOKEN", clientAuth: "basic", scope: undefined });
  const { output, error } = await runOperation(spec, "me", {}, { fetchImpl, environment: OAUTH_ENV });
  if (error) throw error;
  assert.deepEqual(output.data, { ok: true });
  const tokenCall = fetchImpl.calls.find((call) => call.url.startsWith("https://auth."));
  assert.equal(tokenCall.headers.authorization, `Basic ${Buffer.from("client-1:client-secret-xyz").toString("base64")}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenCall.init.body)), { grant_type: "refresh_token", refresh_token: "refresh-abc-123" });
  assert.equal(issuedTokens, 2);
});

test("oauth2 token errors are auth_error and never echo the client secret or refresh token", async () => {
  const fetchImpl = createScriptedFetch(() => ({ status: 400, body: { error: "invalid_client", error_description: "bad secret client-secret-xyz refresh-abc-123" } }));
  const spec = oauthSpec({ grant: "refresh_token", refreshTokenEnv: "PROBE_REFRESH_TOKEN" });
  const { error } = await runOperation(spec, "me", {}, { fetchImpl, environment: OAUTH_ENV });
  assert.equal(error?.kind, "auth_error");
  assert.match(error.message, /invalid_client/);
  assert.equal(error.message.includes("client-secret-xyz") || error.message.includes("refresh-abc-123"), false);
});

test("oauth2 with a missing env names it, and a node access_token skips the token endpoint", async () => {
  const missing = await runOperation(oauthSpec(), "me", {}, { environment: { PROBE_CLIENT_ID: "c" } });
  assert.equal(missing.error?.kind, "auth_error");
  assert.match(missing.error.message, /PROBE_CLIENT_SECRET/);
  const fetchImpl = createScriptedFetch(() => ({ body: {} }));
  await runOperation(oauthSpec(), "me", { access_token: "node-token" }, { fetchImpl, environment: OAUTH_ENV });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].headers.authorization, "Bearer node-token");
});

// --- j. truncation for agent tools ------------------------------------------------------------------------

test("tool results are truncated by items and characters with a truncated flag; nodes get everything", async () => {
  const spec = buildSpec([{ name: "list", title: "L", description: "d", path: "/l", toolOutput: { maxItems: 2 } }, { name: "blob", title: "B", description: "d", path: "/b", toolOutput: { maxChars: 50 } }]);
  const items = { body: [1, 2, 3, 4] };
  const truncatedList = await runOperation(spec, "list", {}, { responses: [items], source: "tool" });
  assert.deepEqual(truncatedList.output.data, { truncated: true, items: [1, 2], total_items: 4 });
  const nodeList = await runOperation(spec, "list", {}, { responses: [items], source: "node" });
  assert.deepEqual(nodeList.output.data, [1, 2, 3, 4]);
  const truncatedBlob = await runOperation(spec, "blob", {}, { responses: [{ body: { text: "x".repeat(200) } }], source: "tool" });
  assert.equal(truncatedBlob.output.data.truncated, true);
  assert.equal(truncatedBlob.output.data.preview.length, 50);
  assert.ok(truncatedBlob.output.data.total_chars > 200);
});

test("tool results are capped at 100000 characters by default; toolOutput: false turns it off", async () => {
  const bigBody = { body: { text: "y".repeat(150000) } };
  const capped = await runOperation(buildSpec([{ name: "big", title: "B", description: "d", path: "/b" }]), "big", {}, { responses: [bigBody], source: "tool" });
  assert.equal(capped.output.data.truncated, true);
  const uncapped = await runOperation(buildSpec([{ name: "big", title: "B", description: "d", path: "/b" }], { toolOutput: false }), "big", {}, { responses: [bigBody], source: "tool" });
  assert.equal(uncapped.output.data.text.length, 150000);
});
