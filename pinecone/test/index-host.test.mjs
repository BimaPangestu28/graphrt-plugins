import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { resolveIndexHostUrl } from "../lib/index-host.mjs";
import { describeSearchOutcome } from "../lib/search-outcome.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { pluginDefinition } from "../definition.mjs";

const INDEX_HOST = "docs-example-a1b2c3d.svc.aped-4627-b74a.pinecone.io";

async function run(operationName, args, { environment = {}, source = "tool", responses = [{ body: {} }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { PINECONE_API_KEY: "pc-test", ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("resolveIndexHostUrl accepts Pinecone hosts with or without https://, and Pinecone Local on localhost", () => {
  assert.equal(resolveIndexHostUrl(INDEX_HOST), `https://${INDEX_HOST}`);
  assert.equal(resolveIndexHostUrl(`https://${INDEX_HOST}/`), `https://${INDEX_HOST}`);
  assert.equal(resolveIndexHostUrl(`  ${INDEX_HOST.toUpperCase()}  `), `https://${INDEX_HOST.toLowerCase()}`);
  assert.equal(resolveIndexHostUrl("my-index-x.svc.private.pinecone.io"), "https://my-index-x.svc.private.pinecone.io");
  assert.equal(resolveIndexHostUrl("http://localhost:5081"), "http://localhost:5081");
  assert.equal(resolveIndexHostUrl("http://127.0.0.1:5081"), "http://127.0.0.1:5081");
});

test("resolveIndexHostUrl refuses hosts that are not Pinecone's, plain http, paths, credentials and a missing host", () => {
  for (const badHost of [
    "evil.example.com",
    "pinecone.io.evil.example.com",
    "evilpinecone.io",
    `http://${INDEX_HOST}`,
    `https://${INDEX_HOST}/query`,
    `https://user:pass@${INDEX_HOST}`,
    `https://${INDEX_HOST}?x=1`,
    "http://localhost.evil.example.com",
    "",
    undefined,
  ]) {
    assert.throws(() => resolveIndexHostUrl(badHost), /PINECONE_INDEX_HOST|index_host/, String(badHost));
  }
});

test("data-plane calls go to PINECONE_INDEX_HOST, control-plane calls to api.pinecone.io", async () => {
  const { calls } = await run("describe_index_stats", {}, { environment: { PINECONE_INDEX_HOST: INDEX_HOST } });
  assert.equal(calls[0].url, `https://${INDEX_HOST}/describe_index_stats`);
  assert.equal(calls[0].headers["api-key"], "pc-test");
  assert.equal(calls[0].headers["x-pinecone-api-version"], "2026-07");
  const control = await run("list_indexes", {});
  assert.equal(control.calls[0].url, "https://api.pinecone.io/indexes");
});

test("an index_host argument overrides the env, is validated, and never reaches the request", async () => {
  const otherHost = "other-index-zz9.svc.us-east1-gcp.pinecone.io";
  const { calls } = await run("query_vectors", { index_host: otherHost, top_k: 3, vector: [0.1, 0.2] }, { environment: { PINECONE_INDEX_HOST: INDEX_HOST } });
  assert.equal(calls[0].url, `https://${otherHost}/query`);
  assert.equal(JSON.parse(calls[0].body).index_host, undefined);
  await assert.rejects(run("query_vectors", { index_host: "attacker.example.com", top_k: 3, vector: [0.1] }), (error) => error.kind === "invalid_input" && /pinecone\.io/.test(error.message));
});

test("a data-plane call without any index host is a clean invalid_input error before any request", async () => {
  const recordingFetch = createRecordingFetch([]);
  const runner = createOperationRunner(pluginDefinition, { PINECONE_API_KEY: "pc-test" }, { fetchImpl: recordingFetch });
  await assert.rejects(runner("fetch_vectors", { ids: ["a"] }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("PINECONE_INDEX_HOST"));
  assert.equal(recordingFetch.calls.length, 0);
});

test("every data-plane operation offers index_host; control-plane operations do not", () => {
  const byName = new Map(pluginDefinition.operations.map((operation) => [operation.name, operation]));
  for (const name of ["query_vectors", "upsert_vectors", "delete_vectors", "search_documents", "list_namespaces"]) {
    assert.equal(byName.get(name).parameters.properties.index_host.type, "string", name);
  }
  for (const name of ["list_indexes", "describe_index", "delete_index", "api_request"]) {
    assert.equal(byName.get(name).parameters.properties.index_host, undefined, name);
  }
});

test("tool writes need PINECONE_TOOL_ALLOW_WRITES=1; deletes are not tools at all", async () => {
  const environment = { PINECONE_INDEX_HOST: INDEX_HOST };
  const vectors = [{ id: "a", values: [0.1, 0.2] }];
  await assert.rejects(run("upsert_vectors", { vectors }, { environment }), (error) => error.kind === "permission_denied" && error.message.includes("PINECONE_TOOL_ALLOW_WRITES"));
  const allowed = await run("upsert_vectors", { vectors }, { environment: { ...environment, PINECONE_TOOL_ALLOW_WRITES: "1" }, responses: [{ body: { upsertedCount: 1 } }] });
  assert.equal(allowed.calls.length, 1);
  for (const name of ["delete_vectors", "delete_documents", "delete_namespace", "delete_index"]) {
    await assert.rejects(run(name, { ids: ["a"], namespace: "n", index_name: "i" }, { environment: { ...environment, PINECONE_TOOL_ALLOW_WRITES: "1" } }), (error) => error.kind === "invalid_input" && error.message.includes("Unknown operation"), name);
  }
});

test("tool api_request only reaches index, collection and backup metadata", async () => {
  await assert.rejects(run("api_request", { path: "/admin/api-keys" }), (error) => error.kind === "permission_denied");
  await assert.rejects(run("api_request", { path: "/admin/projects" }), (error) => error.kind === "permission_denied");
  const { calls } = await run("api_request", { path: "/indexes/docs-example/backups" });
  assert.equal(calls[0].url, "https://api.pinecone.io/indexes/docs-example/backups");
});

test("Pinecone's {error: {code, message}} and text/plain 401 map to clean errors", async () => {
  await assert.rejects(
    run("describe_index", { index_name: "missing" }, { responses: [{ status: 404, body: { status: 404, error: { code: "NOT_FOUND", message: "Resource missing not found" } } }] }),
    (error) => error.kind === "not_found" && error.message.includes("Resource missing not found"),
  );
  await assert.rejects(run("list_indexes", {}, { responses: [{ status: 401, body: "Invalid API Key" }] }), (error) => error.kind === "auth_error");
});

test("an index_host argument may not be localhost; Pinecone Local is only reachable through PINECONE_INDEX_HOST", async () => {
  for (const localHost of ["http://localhost:5081", "http://127.0.0.1:5081", "http://[::1]:5081"]) {
    for (const source of ["tool", "node"]) {
      await assert.rejects(
        run("query_vectors", { index_host: localHost, top_k: 3, vector: [0.1] }, { source, environment: { PINECONE_INDEX_HOST: INDEX_HOST } }),
        (error) => error.kind === "invalid_input" && /pinecone\.io/.test(error.message),
        `${source} ${localHost}`,
      );
    }
  }
  const { calls } = await run("query_vectors", { top_k: 3, vector: [0.1] }, { environment: { PINECONE_INDEX_HOST: "http://localhost:5081" } });
  assert.equal(calls[0].url, "http://localhost:5081/query");
});

test("describeSearchOutcome rewords the write note of timeouts and network errors, keeps other errors as they are", () => {
  const timeout = new PluginError("Request timed out after 30000 ms (outcome unknown: the write may have been applied; check before retrying)", { kind: "timeout", retryable: false });
  const reworded = describeSearchOutcome(timeout);
  assert.equal(reworded.kind, "timeout");
  assert.equal(reworded.retryable, false);
  assert.match(reworded.message, /^Request timed out after 30000 ms \(outcome unknown: the search may have been billed; not retried/);
  const authError = new PluginError("API error 401: Invalid API key", { kind: "auth_error" });
  assert.equal(describeSearchOutcome(authError), authError);
});

test("billed searches (embedding, reranking) are never retried after a 5xx and say how to check", async () => {
  const failures = [{ status: 503, body: { error: { message: "unavailable" } } }, { status: 503, body: {} }, { status: 503, body: {} }];
  const cases = [
    ["search_documents", { namespace: "n", top_k: 3, score_by: [{ type: "embed", fields: ["content"], query: "ml" }] }],
    ["search_records", { namespace: "n", top_k: 3, query_text: "ml" }],
  ];
  for (const [operationName, args] of cases) {
    const recordingFetch = createRecordingFetch(failures);
    const runner = createOperationRunner(pluginDefinition, { PINECONE_API_KEY: "pc-test", PINECONE_INDEX_HOST: INDEX_HOST }, { fetchImpl: recordingFetch });
    await assert.rejects(
      runner(operationName, args, { source: "tool" }),
      (error) =>
        error.retryable === false &&
        error.kind === "api_error" &&
        /usage/.test(error.message) &&
        /outcome unknown: the search may have been billed; not retried/.test(error.message) &&
        !/write may have been applied/.test(error.message),
      operationName,
    );
    assert.equal(recordingFetch.calls.length, 1, operationName);
  }
});
