import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { cosineSimilarity, rankDocuments } from "../lib/similarity.mjs";
import { resolveBatchSize, resolveDefaultModel, resolveEmbeddingsBaseUrl } from "../lib/providers.mjs";
import { pluginDefinition } from "../definition.mjs";

const API_KEY = "embed-test-key-0001";

function createRunner(environment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { EMBEDDINGS_API_KEY: API_KEY, ...environment }, { fetchImpl: recordingFetch });
  return { run, calls: recordingFetch.calls };
}

const embeddingResponse = (vectors) => ({ body: { object: "list", data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })), model: "m" } });

// --- providers ------------------------------------------------------------------------------------

test("each provider has its OpenAI-compatible base URL", () => {
  assert.equal(resolveEmbeddingsBaseUrl({}), "https://api.openai.com/v1");
  assert.equal(resolveEmbeddingsBaseUrl({ EMBEDDINGS_PROVIDER: "mistral" }), "https://api.mistral.ai/v1");
  assert.equal(resolveEmbeddingsBaseUrl({ EMBEDDINGS_PROVIDER: "gemini" }), "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(resolveEmbeddingsBaseUrl({ EMBEDDINGS_PROVIDER: "voyage" }), "https://api.voyageai.com/v1");
  assert.equal(resolveEmbeddingsBaseUrl({ EMBEDDINGS_PROVIDER: "ollama" }), "http://127.0.0.1:11434/v1");
  assert.equal(resolveEmbeddingsBaseUrl({ EMBEDDINGS_PROVIDER: "custom", EMBEDDINGS_BASE_URL: "https://llm.example.com/v1/" }), "https://llm.example.com/v1");
  assert.equal(resolveEmbeddingsBaseUrl({ EMBEDDINGS_PROVIDER: "OpenAI" }), "https://api.openai.com/v1");
});

test("unknown providers and custom without a base URL are refused", () => {
  assert.throws(() => resolveEmbeddingsBaseUrl({ EMBEDDINGS_PROVIDER: "acme" }), /EMBEDDINGS_PROVIDER/);
  assert.throws(() => resolveEmbeddingsBaseUrl({ EMBEDDINGS_PROVIDER: "custom" }), /EMBEDDINGS_BASE_URL/);
});

test("the default model comes from EMBEDDINGS_MODEL, else the provider; custom has none", () => {
  assert.equal(resolveDefaultModel({}), "text-embedding-3-small");
  assert.equal(resolveDefaultModel({ EMBEDDINGS_PROVIDER: "voyage" }), "voyage-4");
  assert.equal(resolveDefaultModel({ EMBEDDINGS_PROVIDER: "gemini", EMBEDDINGS_MODEL: "gemini-embedding-2" }), "gemini-embedding-2");
  assert.equal(resolveDefaultModel({ EMBEDDINGS_PROVIDER: "custom" }), undefined);
});

test("embed_texts fills in the provider's default model", async () => {
  const { run, calls } = createRunner({ EMBEDDINGS_PROVIDER: "mistral" }, [embeddingResponse([[1, 0]])]);
  await run("embed_texts", { input: ["hello"] }, { source: "tool" });
  assert.equal(calls[0].url, "https://api.mistral.ai/v1/embeddings");
  assert.deepEqual(calls[0].json, { input: ["hello"], model: "mistral-embed" });
  assert.equal(calls[0].headers.authorization, `Bearer ${API_KEY}`);
});

test("embed_texts with a custom provider and no model is refused before any request", async () => {
  const { run, calls } = createRunner({ EMBEDDINGS_PROVIDER: "custom", EMBEDDINGS_BASE_URL: "https://llm.example.com/v1" }, []);
  await assert.rejects(run("embed_texts", { input: ["x"] }, { source: "tool" }), (error) => error.kind === "invalid_input" && /model/.test(error.message));
  assert.equal(calls.length, 0);
});

// --- similarity -------------------------------------------------------------------------------------

test("cosineSimilarity is 1 for the same direction, 0 for orthogonal and -1 for opposite", () => {
  assert.equal(cosineSimilarity([1, 2], [2, 4]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 3]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test("cosineSimilarity refuses vectors of different lengths and zero vectors", () => {
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), (error) => error.kind === "api_error");
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("rankDocuments sorts by score and keeps the original index", () => {
  const ranked = rankDocuments({ queryVector: [1, 0], documentVectors: [[0, 1], [1, 0.1], [1, 1]], documents: ["a", "b", "c"], topK: 2 });
  assert.deepEqual(ranked.map((match) => [match.index, match.document]), [[1, "b"], [2, "c"]]);
  assert.ok(ranked[0].score > ranked[1].score);
});

test("rank_by_similarity embeds the query with the documents in one call and returns the top matches", async () => {
  const { run, calls } = createRunner({}, [embeddingResponse([[1, 0], [0, 1], [0.9, 0.1], [0.5, 0.5]])]);
  const { data } = await run("rank_by_similarity", { query: "refund policy", documents: ["shipping", "refunds", "returns"], top_k: 2 }, { source: "tool" });
  assert.deepEqual(calls[0].json, { input: ["refund policy", "shipping", "refunds", "returns"], model: "text-embedding-3-small" });
  assert.deepEqual(data.matches.map((match) => match.document), ["refunds", "returns"]);
  assert.equal(data.model, "m");
  assert.equal(JSON.stringify(data).includes("embedding"), false, "vectors are not returned");
});

test("rank_by_similarity uses the response index, not the array order", async () => {
  const shuffled = { body: { data: [{ index: 2, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] } };
  const { run } = createRunner({}, [shuffled]);
  const { data } = await run("rank_by_similarity", { query: "q", documents: ["near", "far"], top_k: 1 }, { source: "tool" });
  assert.equal(data.matches[0].document, "far");
});

test("rank_by_similarity fails clearly when the API returns too few vectors", async () => {
  const { run } = createRunner({}, [embeddingResponse([[1, 0]])]);
  await assert.rejects(run("rank_by_similarity", { query: "q", documents: ["a"] }, { source: "tool" }), (error) => error.kind === "api_error" && /2 vectors/.test(error.message));
});

test("rank_by_similarity requires a query and documents and caps the list", async () => {
  const { run, calls } = createRunner({}, []);
  await assert.rejects(run("rank_by_similarity", { documents: ["a"] }, { source: "tool" }), (error) => error.kind === "invalid_input");
  await assert.rejects(run("rank_by_similarity", { query: "q", documents: Array.from({ length: 1000 }, () => "d") }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 0);
});

test("rank_by_similarity maps API errors and redacts the key", async () => {
  const { run } = createRunner({}, [{ status: 401, body: { error: { message: `bad key ${API_KEY}` } } }]);
  await assert.rejects(run("rank_by_similarity", { query: "q", documents: ["a"] }, { source: "tool" }), (error) => error.kind === "auth_error" && !error.message.includes(API_KEY));
});

test("both operations are agent tools and the manifest lists the provider env", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name).sort(), ["embed_texts", "rank_by_similarity"]);
  for (const envName of ["EMBEDDINGS_API_KEY", "EMBEDDINGS_PROVIDER", "EMBEDDINGS_BASE_URL", "EMBEDDINGS_MODEL"]) assert.ok(manifest.permissions.env.includes(envName), envName);
});

test("embed_texts and rank_by_similarity are never retried after a 5xx (they may have been billed)", async () => {
  for (const [operationName, args] of [["embed_texts", { input: ["a"] }], ["rank_by_similarity", { query: "q", documents: ["a"] }]]) {
    const { run, calls } = createRunner({}, [{ status: 500, headers: { "retry-after": "0" }, body: {} }, embeddingResponse([[1, 0], [1, 0]])]);
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /billed/.test(error.message), operationName);
    assert.equal(calls.length, 1, operationName);
  }
});

test("each provider has a per-request batch size (Gemini 100)", () => {
  assert.equal(resolveBatchSize({ EMBEDDINGS_PROVIDER: "gemini" }), 100);
  assert.equal(resolveBatchSize({ EMBEDDINGS_PROVIDER: "voyage" }), 1000);
  assert.equal(resolveBatchSize({}), 1000);
  assert.equal(resolveBatchSize({ EMBEDDINGS_PROVIDER: "custom", EMBEDDINGS_BATCH_SIZE: "16" }), 16);
  assert.equal(resolveBatchSize({ EMBEDDINGS_BATCH_SIZE: "nope" }), 1000);
});

test("rank_by_similarity splits the texts into provider-sized requests and keeps the order", async () => {
  const documents = Array.from({ length: 150 }, (unused, index) => `doc ${index}`);
  const vectorFor = (text) => (text === "doc 120" || text === "q" ? [1, 0] : [0, 1]);
  const chunkResponses = [documents.slice(0, 99), documents.slice(99)].map((chunk, chunkIndex) => embeddingResponse((chunkIndex === 0 ? ["q", ...chunk] : chunk).map(vectorFor)));
  const { run, calls } = createRunner({ EMBEDDINGS_PROVIDER: "gemini" }, chunkResponses);
  const { data } = await run("rank_by_similarity", { query: "q", documents, top_k: 1 }, { source: "tool" });
  assert.deepEqual(calls.map((call) => call.json.input.length), [100, 51]);
  assert.equal(data.matches[0].document, "doc 120");
  assert.equal(data.matches[0].index, 120);
});
