import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRestPlugin } from "../lib/rest-plugin.mjs";
import { buildManifest, createOperationRunner } from "../lib/operations.mjs";
import { createRecordingFetch } from "../lib/testing.mjs";
import { demoSpec } from "./fixtures/demo-rest-spec.mjs";

const TOKEN = "demo-secret-token-123";
const ENVIRONMENT = { DEMO_TOKEN: TOKEN, GRAPHRT_POLL_INTERVAL_MS: "0" };
const publicResolver = async () => ["93.184.216.34"];

const demoDefinition = defineRestPlugin(demoSpec());

async function runDemo(operationName, args, responses = [{ body: {} }], options = {}) {
  const definition = options.definition ?? demoDefinition;
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(definition, { ...ENVIRONMENT, ...options.environment }, { fetchImpl: recordingFetch, resolveHostAddresses: publicResolver });
  const output = await runOperation(operationName, args, { source: options.source ?? "node" });
  return { output, calls: recordingFetch.calls };
}

async function rejectsDemo(operationName, args, responses, matcher, options) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(options?.definition ?? demoDefinition, { ...ENVIRONMENT, ...options?.environment }, { fetchImpl: recordingFetch });
  await assert.rejects(runOperation(operationName, args, { source: options?.source ?? "node" }), matcher);
  return recordingFetch.calls;
}

// --- definition shape ---------------------------------------------------------

test("defineRestPlugin returns a normal plugin definition: manifest, nodes, tools and api_request", () => {
  const manifest = buildManifest(demoDefinition);
  assert.equal(manifest.name, "demo-api");
  assert.deepEqual(manifest.permissions, { network: true, secrets: true, env: ["DEMO_TOKEN", "DEMO_TOOL_ALLOW_SEARCH", "DEMO_OUTPUT_DIR", "DEMO_UPLOAD_DIR"] });
  const nodeKinds = manifest.nodes.map((node) => node.kind);
  assert.ok(nodeKinds.includes("demo-api.delete_item"));
  assert.ok(nodeKinds.includes("demo-api.api_request"));
  assert.equal(manifest.tools.some((tool) => tool.name === "delete_item"), false, "nodeOnly ops are not tools");
  assert.ok(manifest.tools.some((tool) => tool.name === "api_request"));
});

test("param specs become a JSON schema with required, enum, min/max and defaults", () => {
  const sendMessage = demoDefinition.operations.find((operation) => operation.name === "send_message");
  assert.deepEqual(sendMessage.parameters.required, ["channel", "text"]);
  assert.deepEqual(sendMessage.parameters.properties.priority, { type: "string", enum: ["low", "high"] });
  assert.equal(sendMessage.parameters.properties.silent.default, false);
  assert.equal(sendMessage.parameters.properties.text.minLength, 1);
  const listCursor = demoDefinition.operations.find((operation) => operation.name === "list_cursor");
  assert.equal(listCursor.parameters.properties.limit.type, "integer");
  assert.equal(listCursor.parameters.properties.limit.maximum, 100);
  assert.equal(listCursor.parameters.properties.limit.default, 20);
  assert.equal(listCursor.parameters.properties.cursor.type, "string");
  const generate = demoDefinition.operations.find((operation) => operation.name === "generate_image");
  assert.equal(generate.parameters.properties.wait.default, true);
});

test("an optIn tool policy is stated in the operation description", () => {
  const search = demoDefinition.operations.find((operation) => operation.name === "search_items");
  assert.match(search.description, /DEMO_TOOL_ALLOW_SEARCH=1/);
});

test("apiRequest: false leaves api_request out", () => {
  const definition = defineRestPlugin(demoSpec({ apiRequest: false }));
  assert.equal(definition.operations.some((operation) => operation.name === "api_request"), false);
});

// --- request shape --------------------------------------------------------------

test("GET puts path params (encoded), query params (wireName, arrays joined), headers and auth in place", async () => {
  const { calls } = await runDemo("get_item", { item_id: "a/b c", fields: ["id", "name"], expand: true, trace: "t-1" });
  const [call] = calls;
  assert.equal(call.method, "GET");
  assert.equal(call.url, "https://api.example.com/v1/items/a%2Fb%20c?fields=id%2Cname&expand_all=true");
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.headers["x-trace-id"], "t-1");
  assert.equal(call.headers["x-api-version"], "2026-01");
  assert.equal(call.body, undefined);
});

test("a path param of '..' or '.' is refused before any request; '../x' stays one encoded segment", async () => {
  for (const traversal of ["..", "."]) {
    const calls = await rejectsDemo("get_item", { item_id: traversal }, [], (error) => error.kind === "invalid_input");
    assert.equal(calls.length, 0);
  }
  const { calls } = await runDemo("get_item", { item_id: "../../admin" });
  assert.equal(calls[0].path, "/v1/items/..%2F..%2Fadmin");
});

test("body params nest by dotted wireName and defaults are sent", async () => {
  const { calls } = await runDemo("send_message", { channel: "general", text: "hi" });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/v1/channels/general/messages");
  assert.deepEqual(calls[0].json, { message: { text: "hi", options: { silent: false } } });
});

test("bodyMode raw sends the object param as the whole body; form mode url-encodes", async () => {
  const document = { title: "T", tags: ["a"] };
  const raw = await runDemo("replace_item", { item_id: "i1", document });
  assert.equal(raw.calls[0].method, "PUT");
  assert.deepEqual(raw.calls[0].json, document);
  const form = await runDemo("search_items", { q: "shoes" });
  assert.deepEqual(form.calls[0].form, { q: "shoes" });
});

test("missing required params are refused before any request", async () => {
  const calls = await rejectsDemo("send_message", { channel: "general" }, [], (error) => error.kind === "invalid_input" && /text/.test(error.message));
  assert.equal(calls.length, 0);
});

// --- auth types ---------------------------------------------------------------------

const authSpec = (auth, extraEnvironment) => ({
  definition: defineRestPlugin(demoSpec({ auth })),
  environment: extraEnvironment,
});

test("header auth puts the credential (with prefix) in the named header", async () => {
  const options = authSpec({ type: "header", header: "X-Api-Key", env: "DEMO_TOKEN", prefix: "Key " });
  const { calls } = await runDemo("get_item", { item_id: "1" }, undefined, options);
  assert.equal(calls[0].headers["x-api-key"], `Key ${TOKEN}`);
  assert.equal(calls[0].headers.authorization, undefined);
});

test("query auth puts the credential in the query and redacts it from errors", async () => {
  const options = authSpec({ type: "query", param: "apikey", env: "DEMO_TOKEN" });
  const { calls } = await runDemo("get_item", { item_id: "1" }, undefined, options);
  assert.equal(calls[0].query.apikey, TOKEN);
  await rejectsDemo("get_item", { item_id: "1" }, [{ status: 400, body: { message: `bad key ${TOKEN}` } }], (error) => !error.message.includes(TOKEN) && /\[redacted\]/.test(error.message), options);
});

test("basic auth from user and password envs, and from one token env with a fixed user", async () => {
  const twoEnvs = authSpec({ type: "basic", userEnv: "DEMO_USER", passwordEnv: "DEMO_TOKEN" }, { DEMO_USER: "alice" });
  const first = await runDemo("get_item", { item_id: "1" }, undefined, twoEnvs);
  assert.equal(first.calls[0].headers.authorization, `Basic ${Buffer.from(`alice:${TOKEN}`).toString("base64")}`);
  const fixedUser = authSpec({ type: "basic", tokenEnv: "DEMO_TOKEN", user: "api" });
  const second = await runDemo("get_item", { item_id: "1" }, undefined, fixedUser);
  assert.equal(second.calls[0].headers.authorization, `Basic ${Buffer.from(`api:${TOKEN}`).toString("base64")}`);
  const tokenAsUser = authSpec({ type: "basic", tokenEnv: "DEMO_TOKEN", password: "" });
  const third = await runDemo("get_item", { item_id: "1" }, undefined, tokenAsUser);
  assert.equal(third.calls[0].headers.authorization, `Basic ${Buffer.from(`${TOKEN}:`).toString("base64")}`);
});

test("basic auth with a missing user env fails with auth_error naming it", async () => {
  const options = authSpec({ type: "basic", userEnv: "DEMO_USER", passwordEnv: "DEMO_TOKEN" });
  const calls = await rejectsDemo("get_item", { item_id: "1" }, [], (error) => error.kind === "auth_error" && /DEMO_USER/.test(error.message), options);
  assert.equal(calls.length, 0);
});

test("a missing credential env fails with auth_error naming it", async () => {
  const recordingFetch = createRecordingFetch([]);
  const runOperation = createOperationRunner(demoDefinition, {}, { fetchImpl: recordingFetch });
  await assert.rejects(runOperation("get_item", { item_id: "1" }, { source: "tool" }), (error) => error.kind === "auth_error" && /DEMO_TOKEN/.test(error.message));
});

test("the credential from the env is trimmed and a node access_token overrides it, but a tool's does not", async () => {
  const trimmed = await runDemo("get_item", { item_id: "1" }, undefined, { environment: { DEMO_TOKEN: ` ${TOKEN}\n` } });
  assert.equal(trimmed.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const nodeOverride = await runDemo("get_item", { item_id: "1", access_token: "node-token-xyz" });
  assert.equal(nodeOverride.calls[0].headers.authorization, "Bearer node-token-xyz");
  const toolAttempt = await runDemo("get_item", { item_id: "1", access_token: "llm-token" }, undefined, { source: "tool" });
  assert.equal(toolAttempt.calls[0].headers.authorization, `Bearer ${TOKEN}`);
});

test("auth none sends no credential, needs no env and asks for no secrets", async () => {
  const definition = defineRestPlugin(demoSpec({ auth: { type: "none" } }));
  const manifest = buildManifest(definition);
  assert.equal(manifest.permissions.secrets, false);
  assert.equal(manifest.permissions.env.includes("DEMO_TOKEN"), false);
  const recordingFetch = createRecordingFetch([{ body: {} }]);
  await createOperationRunner(definition, {}, { fetchImpl: recordingFetch })("get_item", { item_id: "1" }, { source: "tool" });
  assert.equal(recordingFetch.calls[0].headers.authorization, undefined);
});

test("custom auth receives the credential and its returned secrets are redacted", async () => {
  const authorize = ({ headers, credential }) => {
    headers["x-signature"] = `sig-${credential}`;
    return [`sig-${credential}`];
  };
  const options = authSpec({ type: "custom", env: "DEMO_TOKEN", authorize });
  const { calls } = await runDemo("get_item", { item_id: "1" }, undefined, options);
  assert.equal(calls[0].headers["x-signature"], `sig-${TOKEN}`);
  await rejectsDemo("get_item", { item_id: "1" }, [{ status: 400, body: { message: `bad sig-${TOKEN}` } }], (error) => !error.message.includes(TOKEN), options);
});

test("a baseUrl function receives the environment; its errors become invalid_input", async () => {
  const baseUrl = (environment) => {
    if (!/^[a-z]{2}$/.test(environment.DEMO_REGION ?? "")) throw new Error("DEMO_REGION must be a two-letter region");
    return `https://${environment.DEMO_REGION}.api.example.com`;
  };
  const definition = defineRestPlugin(demoSpec({ baseUrl, extraEnv: ["DEMO_REGION"] }));
  const { calls } = await runDemo("get_item", { item_id: "1" }, undefined, { definition, environment: { DEMO_REGION: "eu" } });
  assert.equal(calls[0].url, "https://eu.api.example.com/items/1");
  await rejectsDemo("get_item", { item_id: "1" }, [], (error) => error.kind === "invalid_input" && /DEMO_REGION/.test(error.message), { definition, environment: { DEMO_REGION: "evil.com/" } });
  const httpDefinition = defineRestPlugin(demoSpec({ baseUrl: () => "http://evil.example.com" }));
  await rejectsDemo("get_item", { item_id: "1" }, [], (error) => error.kind === "invalid_input" && /https/.test(error.message), { definition: httpDefinition });
});

// --- errors -----------------------------------------------------------------------------

test("declared error paths give the message, code-based kind and retry hint", async () => {
  await rejectsDemo(
    "get_item",
    { item_id: "1" },
    [{ status: 400, body: { error: { message: "Token expired", code: "token_expired" } } }],
    (error) => error.kind === "auth_error" && /Token expired \(token_expired\)/.test(error.message),
  );
  await rejectsDemo(
    "send_message",
    { channel: "c", text: "t" },
    [{ status: 400, body: { error: { message: "Slow down", code: "quota", retry_after: 120 } } }],
    (error) => error.kind === "rate_limited" && error.retryAfterMs === 120000,
  );
});

test("error-in-2xx: okPath/okValue and errorPath detectors turn a 200 into an error", async () => {
  const okDefinition = defineRestPlugin(demoSpec({ errors: { okPath: "ok", okValue: true, messagePath: "description", codePath: "error_code", kindByCode: { 401: "auth_error" } } }));
  await rejectsDemo("get_item", { item_id: "1" }, [{ body: { ok: false, description: "Unauthorized", error_code: 401 } }], (error) => error.kind === "auth_error" && /Unauthorized/.test(error.message), { definition: okDefinition });
  const { output } = await runDemo("get_item", { item_id: "1" }, [{ body: { ok: true, result: 1 } }], { definition: okDefinition });
  assert.deepEqual(output.data, { ok: true, result: 1 });
  const errorDefinition = defineRestPlugin(demoSpec({ errors: { errorPath: "error", messagePath: "reason" } }));
  await rejectsDemo("get_item", { item_id: "1" }, [{ body: { error: true, reason: "Latitude must be in range" } }], (error) => error.kind === "api_error" && /Latitude/.test(error.message), { definition: errorDefinition });
});

test("kindByStatus maps statuses the API uses unusually", async () => {
  const definition = defineRestPlugin(demoSpec({ maxRetries: 0, errors: { kindByStatus: { 529: "rate_limited" } } }));
  await rejectsDemo("send_message", { channel: "c", text: "t" }, [{ status: 529, body: {} }], (error) => error.kind === "rate_limited" && error.retryable, { definition });
});

// --- write classes ------------------------------------------------------------------------

test("an unsafe write is never retried after a 5xx and carries the unknown-outcome note plus its check hint", async () => {
  const calls = await rejectsDemo(
    "send_message",
    { channel: "c", text: "t" },
    [{ status: 503, headers: { "retry-after": "0" } }, { body: {} }],
    (error) => error.retryable === false && /outcome unknown/.test(error.message) && /To check: list the channel's recent messages/.test(error.message),
  );
  assert.equal(calls.length, 1);
});

test("an unsafe DELETE is not retried either", async () => {
  const calls = await rejectsDemo("delete_item", { item_id: "1" }, [{ status: 502, headers: { "retry-after": "0" } }, { body: {} }], (error) => error.retryable === false);
  assert.equal(calls.length, 1);
});

test("idempotent (POST) and read operations are retried after a 5xx", async () => {
  const idempotent = await runDemo("list_offsets", {}, [{ status: 503, headers: { "retry-after": "0" } }, { body: { records: [] } }]);
  assert.equal(idempotent.calls.length, 2);
  const read = await runDemo("get_item", { item_id: "1" }, [{ status: 500, headers: { "retry-after": "0" } }, { body: { id: "1" } }]);
  assert.equal(read.calls.length, 2);
  assert.deepEqual(read.output.data, { id: "1" });
});

// --- tool policy and api_request ---------------------------------------------------------------

test("nodeOnly operations are refused as tools", async () => {
  const calls = await rejectsDemo("delete_item", { item_id: "1" }, [], (error) => error.kind === "invalid_input", { source: "tool" });
  assert.equal(calls.length, 0);
});

test("optIn tool policy refuses tool calls unless the env is 1, and never limits nodes", async () => {
  const calls = await rejectsDemo("search_items", { q: "x" }, [], (error) => error.kind === "permission_denied" && /DEMO_TOOL_ALLOW_SEARCH=1/.test(error.message), { source: "tool" });
  assert.equal(calls.length, 0);
  await rejectsDemo("search_items", { q: "x" }, [], (error) => error.kind === "permission_denied", { source: "tool", environment: { DEMO_TOOL_ALLOW_SEARCH: "true" } });
  const allowed = await runDemo("search_items", { q: "x" }, undefined, { source: "tool", environment: { DEMO_TOOL_ALLOW_SEARCH: "1" } });
  assert.equal(allowed.calls.length, 1);
  const asNode = await runDemo("search_items", { q: "x" });
  assert.equal(asNode.calls.length, 1);
});

test("api_request is GET-only for tools and redacts the credential from responses", async () => {
  const calls = await rejectsDemo("api_request", { method: "POST", path: "/items", body: {} }, [], (error) => error.kind === "permission_denied", { source: "tool" });
  assert.equal(calls.length, 0);
  const { output } = await runDemo("api_request", { path: "/me" }, [{ body: { echoed: `token=${TOKEN}` } }], { source: "tool" });
  assert.equal(output.data.echoed, "token=[redacted]");
});

// --- pagination ------------------------------------------------------------------------------------

test("cursor pagination maps limit/cursor to the API's names and reads next_cursor", async () => {
  const { output, calls } = await runDemo("list_cursor", { limit: 5, cursor: "c1", status: "open" }, [{ body: { data: [{ id: 1 }], meta: { next: "c2", has_more: true } } }]);
  assert.deepEqual(calls[0].query, { status: "open", starting_after: "c1", page_size: "5" });
  assert.deepEqual(output, { data: [{ id: 1 }], next_cursor: "c2" });
  const lastPage = await runDemo("list_cursor", {}, [{ body: { data: [], meta: { next: "c3", has_more: false } } }]);
  assert.equal(lastPage.calls[0].query.page_size, "20", "defaultLimit is sent");
  assert.equal(lastPage.output.next_cursor, null, "has_more false ends paging");
});

test("limit above maxLimit is refused", async () => {
  await rejectsDemo("list_cursor", { limit: 101 }, [], (error) => error.kind === "invalid_input" && /limit/.test(error.message));
});

test("Link-header pagination returns the next URL and follows it as the cursor", async () => {
  const nextUrl = "https://api.example.com/v1/repos?page=2&per_page=10";
  const first = await runDemo("list_links", { limit: 10 }, [{ body: [{ id: 1 }], headers: { link: `<${nextUrl}>; rel="next", <https://api.example.com/v1/repos?page=9>; rel="last"` } }]);
  assert.equal(first.calls[0].query.per_page, "10");
  assert.equal(first.output.next_cursor, nextUrl);
  const second = await runDemo("list_links", { cursor: nextUrl }, [{ body: [] }]);
  assert.equal(second.calls[0].url, nextUrl);
  assert.equal(second.output.next_cursor, null);
});

test("a Link-header cursor on another origin is refused, so the token cannot leave the API", async () => {
  await rejectsDemo("list_links", { cursor: "https://evil.example.com/steal" }, [], (error) => error.kind === "invalid_input");
});

test("page pagination: cursor is the page number, a full page yields the next one", async () => {
  const full = await runDemo("list_pages", { limit: 2, cursor: "3" }, [{ body: { results: [1, 2] } }]);
  assert.deepEqual(full.calls[0].query, { page: "3", per_page: "2" });
  assert.equal(full.output.next_cursor, "4");
  const partial = await runDemo("list_pages", { limit: 2 }, [{ body: { results: [1] } }]);
  assert.equal(partial.calls[0].query.page, undefined);
  assert.equal(partial.output.next_cursor, null);
  await rejectsDemo("list_pages", { cursor: "abc" }, [], (error) => error.kind === "invalid_input");
});

test("offset pagination in a POST body uses totalPath to stop", async () => {
  const first = await runDemo("list_offsets", { limit: 2, cursor: "4" }, [{ body: { records: [1, 2], total: 10 } }]);
  assert.deepEqual(first.calls[0].json, { skip: 4, take: 2 });
  assert.equal(first.output.next_cursor, "6");
  const last = await runDemo("list_offsets", { limit: 2, cursor: "8" }, [{ body: { records: [9, 10], total: 10 } }]);
  assert.equal(last.output.next_cursor, null);
});

// --- jobs and downloads ------------------------------------------------------------------------------

const jobCreated = { body: { job: { id: "job/42" } } };

test("a job is created once, polled with the encoded id and returns the result", async () => {
  const { output, calls } = await runDemo("generate_image", { prompt: "cat" }, [jobCreated, { body: { status: "running" } }, { body: { status: "succeeded", output: { images: [] } } }]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].path, "/v1/images/job%2F42");
  assert.deepEqual(calls[1].query, { verbose: "1" });
  assert.deepEqual(output.data, { job_id: "job/42", status: "succeeded", result: { images: [] }, saved_files: [] });
});

test("a failed job reports the API's reason, names the job and is not retryable", async () => {
  await rejectsDemo(
    "generate_image",
    { prompt: "cat" },
    [jobCreated, { body: { status: "failed", error: { message: "NSFW prompt" } } }],
    (error) => error.kind === "api_error" && error.retryable === false && /NSFW prompt/.test(error.message) && /job\/42/.test(error.message),
  );
});

test("a job that does not finish in time returns its id with retryable false", async () => {
  const pending = Array.from({ length: 50 }, () => ({ body: { status: "running" } }));
  await rejectsDemo(
    "generate_image",
    { prompt: "cat" },
    [jobCreated, ...pending],
    (error) => error.kind === "timeout" && error.retryable === false && /job\/42/.test(error.message),
    { environment: { GRAPHRT_JOB_TIMEOUT_MS: "1" } },
  );
});

test("transient poll errors are tolerated after the client's own retries", async () => {
  const serverFailure = { status: 503, headers: { "retry-after": "0" }, body: {} };
  const { output, calls } = await runDemo("generate_image", { prompt: "cat" }, [
    jobCreated,
    serverFailure,
    serverFailure,
    serverFailure,
    { body: { status: "succeeded", output: {} } },
  ]);
  assert.equal(calls.length, 5);
  assert.equal(output.data.status, "succeeded");
});

test("wait: false returns the job id at once", async () => {
  const { output, calls } = await runDemo("generate_image", { prompt: "cat", wait: false }, [jobCreated]);
  assert.equal(calls.length, 1);
  assert.deepEqual(output.data, { job_id: "job/42", response: { job: { id: "job/42" } } });
});

test("a create response without a job id fails clearly and is not retryable", async () => {
  await rejectsDemo("generate_image", { prompt: "cat" }, [{ body: {} }], (error) => error.kind === "api_error" && error.retryable === false && /job\.id/.test(error.message));
});

test("download.saveTo streams result URLs into the env directory and keeps the URLs", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "rest-download-"));
  try {
    const images = { images: [{ url: "https://cdn.example.com/a.png" }, { url: "http://cdn.example.com/b.png" }] };
    const { output, calls } = await runDemo(
      "generate_image",
      { prompt: "cat" },
      [jobCreated, { body: { status: "succeeded", output: images } }, { body: "PNG", headers: { "content-type": "image/png" } }],
      { environment: { DEMO_OUTPUT_DIR: outputDirectory } },
    );
    assert.equal(calls[2].url, "https://cdn.example.com/a.png");
    assert.equal(calls[2].headers.authorization, undefined, "downloads never carry the credential");
    const [savedImage, refusedImage] = output.data.saved_files;
    assert.equal(savedImage.url, "https://cdn.example.com/a.png");
    assert.equal(savedImage.content_type, "image/png");
    assert.ok(savedImage.path.startsWith(outputDirectory));
    assert.equal(await readFile(savedImage.path, "utf8"), "PNG");
    assert.equal(refusedImage.url, "http://cdn.example.com/b.png");
    assert.match(refusedImage.error, /https/);
    assert.deepEqual(output.data.result, images);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("download.saveTo refuses a relative output directory", async () => {
  await rejectsDemo(
    "generate_image",
    { prompt: "cat" },
    [jobCreated, { body: { status: "succeeded", output: { images: [{ url: "https://cdn.example.com/a.png" }] } } }],
    (error) => error.kind === "invalid_input" && /DEMO_OUTPUT_DIR/.test(error.message),
    { environment: { DEMO_OUTPUT_DIR: "relative/dir" } },
  );
});

test("response.dataPath picks the data out of the body", async () => {
  const { output } = await runDemo("list_pages", {}, [{ body: { results: ["x"], meta: {} } }]);
  assert.deepEqual(output.data, ["x"]);
});

test("the definition exposes its normalized spec for the contract tests", () => {
  assert.equal(demoDefinition.restSpec.operations.find((operation) => operation.name === "send_message").write, "unsafe");
  assert.equal(demoDefinition.restSpec.operations.find((operation) => operation.name === "get_item").write, "read");
});

test("an operation-level baseUrl sends that operation (and only it) to another host", async () => {
  const geocode = { name: "geocode", title: "Geocode", description: "Search places", baseUrl: "https://geo.example.com/v1", path: "/search", params: { name: { in: "query", type: "string", required: true } } };
  const definition = defineRestPlugin(demoSpec({ operations: [geocode, ...demoSpec().operations] }));
  const { calls } = await runDemo("geocode", { name: "Berlin" }, undefined, { definition });
  assert.equal(calls[0].url, "https://geo.example.com/v1/search?name=Berlin");
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const other = await runDemo("get_item", { item_id: "1" }, undefined, { definition });
  assert.equal(other.calls[0].url, "https://api.example.com/v1/items/1");
});
