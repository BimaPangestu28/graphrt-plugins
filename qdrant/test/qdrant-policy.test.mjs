import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { resolveQdrantBaseUrl } from "../lib/qdrant-config.mjs";
import { containsInferenceInput } from "../lib/inference-routing.mjs";
import { pluginDefinition } from "../definition.mjs";

const ok = (result) => ({ body: { result, status: "ok", time: 0.001 } });

async function run(operationName, args, { environment = {}, source = "tool", responses = [ok({})] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("QDRANT_URL defaults to a local server and loses its trailing slash", () => {
  assert.equal(resolveQdrantBaseUrl({}), "http://localhost:6333");
  assert.equal(resolveQdrantBaseUrl({ QDRANT_URL: " https://q.example.com:6333/ " }), "https://q.example.com:6333");
});

test("a local server works without a key: no api-key header is sent", async () => {
  const { calls } = await run("list_collections", {}, { responses: [ok({ collections: [] })] });
  assert.equal(calls[0].url, "http://localhost:6333/collections");
  assert.equal(calls[0].headers["api-key"], undefined);
});

test("QDRANT_API_KEY is sent as api-key and redacted from errors", async () => {
  const environment = { QDRANT_URL: "https://q.example.com", QDRANT_API_KEY: "qd-secret-key" };
  const { calls } = await run("list_collections", {}, { environment, responses: [ok({ collections: [] })] });
  assert.equal(calls[0].headers["api-key"], "qd-secret-key");
  await assert.rejects(
    run("get_collection", { collection_name: "x" }, { environment, responses: [{ status: 404, body: { status: { error: "Not found: qd-secret-key" }, time: 0 } }] }),
    (error) => error.kind === "not_found" && !error.message.includes("qd-secret-key") && error.message.includes("Not found"),
  );
});

test("plain http to a remote host is refused before any request", async () => {
  await assert.rejects(run("list_collections", {}, { environment: { QDRANT_URL: "http://qdrant.example.com:6333" }, responses: [] }), (error) => error.kind === "invalid_input" && /https/.test(error.message));
});

test("a digit-only scroll cursor is sent as an integer point id, a UUID cursor as a string", async () => {
  const numeric = await run("scroll_points", { collection_name: "docs", cursor: "42" }, { responses: [ok({ points: [], next_page_offset: null })] });
  assert.equal(numeric.calls[0].json.offset, 42);
  const uuid = "5c56c793-69f3-4fbf-87e6-c4bf54c28c26";
  const uuidCall = await run("scroll_points", { collection_name: "docs", cursor: uuid }, { responses: [ok({ points: [], next_page_offset: null })] });
  assert.equal(uuidCall.calls[0].json.offset, uuid);
});

test("scroll_points returns next_page_offset as next_cursor", async () => {
  const { result } = await run("scroll_points", { collection_name: "docs" }, { responses: [ok({ points: [{ id: 1 }], next_page_offset: 2 })] });
  assert.equal(result.next_cursor, "2");
});

test("tool writes need QDRANT_TOOL_ALLOW_WRITES=1; deletes are not tools", async () => {
  const points = [{ id: 1, vector: [0.1] }];
  await assert.rejects(run("upsert_points", { collection_name: "docs", points }), (error) => error.kind === "permission_denied" && error.message.includes("QDRANT_TOOL_ALLOW_WRITES"));
  const allowed = await run("upsert_points", { collection_name: "docs", points }, { environment: { QDRANT_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(allowed.calls[0].method, "PUT");
  for (const name of ["delete_points", "delete_collection"]) {
    await assert.rejects(run(name, { collection_name: "docs" }, { environment: { QDRANT_TOOL_ALLOW_WRITES: "1" } }), (error) => error.message.includes("Unknown operation"), name);
  }
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.tools.some((tool) => tool.name === "delete_points"), false);
});

test("tool api_request reaches metadata but not snapshots, telemetry, cluster or issues", async () => {
  for (const path of ["/telemetry", "/metrics", "/cluster", "/issues", "/snapshots", "/collections/docs/snapshots/s1", "/collections/docs/shards/0/snapshot", "/collections/docs/%2e%2e/../telemetry"]) {
    await assert.rejects(run("api_request", { path }), (error) => error.kind === "permission_denied", path);
  }
  const { calls } = await run("api_request", { path: "/collections/docs/optimizations" });
  assert.equal(calls[0].url, "http://localhost:6333/collections/docs/optimizations");
});

test("tool api_request cannot read a collection's cluster info (peer and shard topology)", async () => {
  for (const path of ["/collections/docs/cluster", "/collections/DOCS/Cluster/"]) {
    await assert.rejects(run("api_request", { path }), (error) => error.kind === "permission_denied", path);
  }
});

// One 503, then success: a retried request succeeds on its second attempt, an unsafe one fails after one.
const failingResponses = () => [{ status: 503, body: { status: { error: "unavailable" } } }, ok({ points: [] })];

async function countAttempts(operationName, args) {
  const recordingFetch = createRecordingFetch(failingResponses());
  const runner = createOperationRunner(pluginDefinition, { QDRANT_TOOL_ALLOW_WRITES: "1" }, { fetchImpl: recordingFetch });
  const outcome = await runner(operationName, args, { source: "tool" }).then(() => "ok", (error) => error);
  return { attempts: recordingFetch.calls.length, outcome, calls: recordingFetch.calls };
}

test("query_points with inference inputs (text, image or object with a model) is never retried", async () => {
  const inferenceQueries = [
    { query: { nearest: { text: "red shoes", model: "sentence-transformers/all-minilm-l6-v2" } } },
    { query: { fusion: "rrf" }, prefetch: [{ query: { image: "https://x.example/a.png", model: "qdrant/clip-vit-b-32-vision" }, using: "image" }] },
    { query: { text: "red shoes", model: "qdrant/bm25" } },
  ];
  for (const [operationName, extraArgs] of [["query_points", {}], ["query_points_groups", { group_by: "doc" }]]) {
    for (const queryArgs of inferenceQueries) {
      const label = `${operationName} ${JSON.stringify(queryArgs)}`;
      const { attempts, outcome, calls } = await countAttempts(operationName, { collection_name: "docs", ...extraArgs, ...queryArgs });
      assert.equal(attempts, 1, label);
      assert.equal(outcome.retryable, false, label);
      assert.match(outcome.message, /outcome unknown/, label);
      assert.match(calls[0].url, /\/points\/query/, label);
    }
  }
});

test("upsert_points with inference documents as vectors is never retried; plain vectors and payload text still are", async () => {
  const documentPoints = [{ id: 1, vector: { text: "red shoes", model: "sentence-transformers/all-minilm-l6-v2" }, payload: { sku: "a" } }];
  const billed = await countAttempts("upsert_points", { collection_name: "docs", points: documentPoints });
  assert.equal(billed.attempts, 1);
  assert.equal(billed.outcome.retryable, false);
  assert.match(billed.outcome.message, /outcome unknown/);
  assert.equal(billed.calls[0].method, "PUT");
  const plainPoints = [{ id: 1, vector: [0.1, 0.2], payload: { text: "red shoes", model: "x" } }];
  const free = await countAttempts("upsert_points", { collection_name: "docs", points: plainPoints });
  assert.equal(free.outcome, "ok");
  assert.ok(free.attempts > 1);
});

test("query_points with a plain vector is a read and is retried after a 5xx", async () => {
  const { attempts, outcome } = await countAttempts("query_points", { collection_name: "docs", query: { nearest: [0.1, 0.2] } });
  assert.equal(outcome, "ok");
  assert.ok(attempts > 1);
});

test("the unsafe inference twins are internal: no node, no tool, not callable by name", async () => {
  const manifest = buildManifest(pluginDefinition);
  const names = [...manifest.nodes.map((node) => node.kind), ...manifest.tools.map((tool) => tool.name)];
  assert.equal(names.some((name) => name.includes("with_inference")), false);
  await assert.rejects(run("query_points_with_inference", { collection_name: "docs" }), (error) => error.message.includes("Unknown operation"));
});

test("containsInferenceInput finds model-backed text/image/object inputs at any depth, nothing else", () => {
  assert.equal(containsInferenceInput([{ nearest: { text: "a", model: "m" } }, undefined]), true);
  assert.equal(containsInferenceInput([undefined, [{ query: { recommend: { positive: [{ object: {}, model: "m" }] } } }]]), true);
  assert.equal(containsInferenceInput([{ nearest: [0.1, 0.2] }, [{ query: { nearest: 42 } }]]), false);
  assert.equal(containsInferenceInput([{ order_by: "text" }, undefined]), false);
  assert.equal(containsInferenceInput(null), false);
});

test("create_collection is not retried after a 5xx (unknown outcome)", async () => {
  const { attempts, outcome } = await countAttempts("create_collection", { collection_name: "docs", vectors: { size: 4, distance: "Cosine" } });
  assert.equal(attempts, 1);
  assert.equal(outcome.retryable, false);
});
