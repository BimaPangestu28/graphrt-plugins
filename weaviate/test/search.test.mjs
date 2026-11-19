import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { buildCountQuery, buildGetQuery, toGraphqlLiteral } from "../lib/graphql-builder.mjs";
import { readProviderHeaders, resolveWeaviateUrl } from "../lib/weaviate-extras.mjs";
import { pluginDefinition } from "../definition.mjs";

const SERVER = "https://abc123.c0.europe-west3.gcp.weaviate.cloud";
const OBJECT_ID = "36ddd591-2dee-4e7e-a3cc-eb86d30a4303";
const baseEnvironment = { WEAVIATE_URL: SERVER, WEAVIATE_API_KEY: "wv-key-1" };
const isInvalid = (error) => error.kind === "invalid_input";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: { data: { Get: { Article: [] } } } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { ...baseEnvironment, ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("buildGetQuery: nearText with distance, filter, tenant and paging", () => {
  const { query } = buildGetQuery({
    collection: "Article",
    properties: ["title", "year"],
    near_text: ["graph databases"],
    distance: 0.3,
    where: { operator: "And", operands: [{ path: ["year"], operator: "GreaterThan", valueInt: 2000 }, { path: ["lang"], operator: "Equal", valueText: "id" }] },
    tenant: "tenantA",
    limit: 5,
    offset: 10,
  });
  assert.equal(
    query,
    '{ Get { Article(nearText: {concepts: ["graph databases"], distance: 0.3}, where: {operator: And, operands: [{path: ["year"], operator: GreaterThan, valueInt: 2000}, {path: ["lang"], operator: Equal, valueText: "id"}]}, tenant: "tenantA", limit: 5, offset: 10) { title year _additional { id distance creationTimeUnix lastUpdateTimeUnix } } } }',
  );
});

test("buildGetQuery: hybrid and bm25 ask for scores, plain listing for ids only, cursor with after", () => {
  assert.equal(
    buildGetQuery({ collection: "Article", properties: ["title"], hybrid_query: "vector db", alpha: 0.5, fusion_type: "rankedFusion", search_properties: ["title^2", "body"], limit: 3 }).query,
    '{ Get { Article(hybrid: {query: "vector db", alpha: 0.5, fusionType: rankedFusion, properties: ["title^2", "body"]}, limit: 3) { title _additional { id score explainScore creationTimeUnix lastUpdateTimeUnix } } } }',
  );
  assert.equal(buildGetQuery({ collection: "Article", bm25_query: "graph" }).query, '{ Get { Article(bm25: {query: "graph"}) { _additional { id score explainScore creationTimeUnix lastUpdateTimeUnix } } } }');
  assert.equal(buildGetQuery({ collection: "Article", after: OBJECT_ID, limit: 2, include_vector: true }).query, `{ Get { Article(limit: 2, after: "${OBJECT_ID}") { _additional { id creationTimeUnix lastUpdateTimeUnix vector } } } }`);
  assert.match(buildGetQuery({ collection: "Article", near_vector: [0.1, -0.2], target_vectors: ["title_vec"] }).query, /nearVector: \{vector: \[0\.1, -0\.2\], targetVectors: \["title_vec"\]\}/);
  assert.match(buildGetQuery({ collection: "Article", near_object: OBJECT_ID }).query, new RegExp(`nearObject: \\{id: "${OBJECT_ID}"\\}`));
});

test("injection attempts are refused or stay inside string literals", () => {
  const injectedText = '") { title } } Explore(x: "';
  assert.match(buildGetQuery({ collection: "Article", bm25_query: injectedText }).query, /bm25: \{query: "\\"\) \{ title \} \} Explore\(x: \\""\}/);
  assert.throws(() => buildGetQuery({ collection: "Article) { x } Foo(", near_text: ["a"] }), isInvalid);
  assert.throws(() => buildGetQuery({ collection: "article" }), isInvalid);
  assert.throws(() => buildGetQuery({ collection: "Article", properties: ["title _additional { generate(singleResult: {prompt: \"x\"}) { singleResult } }"] }), isInvalid);
  assert.throws(() => toGraphqlLiteral({ path: ["a"], operator: "Equal) { x }" }), isInvalid);
  assert.throws(() => toGraphqlLiteral({ "path: [] } x": 1 }), isInvalid);
  assert.throws(() => buildGetQuery({ collection: "Article", bm25_query: "a", search_properties: ["title^x"] }), isInvalid);
  assert.throws(() => buildGetQuery({ collection: "Article", near_object: "not-a-uuid" }), isInvalid);
});

test("one search mode at a time, and after only without a search", () => {
  assert.throws(() => buildGetQuery({ collection: "Article", near_text: ["a"], bm25_query: "b" }), (error) => isInvalid(error) && error.message.includes("one search"));
  assert.throws(() => buildGetQuery({ collection: "Article", near_text: ["a"], after: OBJECT_ID }), isInvalid);
});

test("toGraphqlLiteral nests deeply only up to the limit", () => {
  let filter = { path: ["a"], operator: "Equal", valueInt: 1 };
  for (let level = 0; level < 15; level += 1) filter = { operator: "And", operands: [filter] };
  assert.throws(() => toGraphqlLiteral(filter), isInvalid);
});

test("buildCountQuery counts with an optional filter", () => {
  assert.equal(buildCountQuery({ collection: "Article" }), "{ Aggregate { Article { meta { count } } } }");
  assert.equal(buildCountQuery({ collection: "Article", where: { path: ["year"], operator: "IsNull", valueBoolean: true } }), "{ Aggregate { Article(where: {path: [\"year\"], operator: IsNull, valueBoolean: true}) { meta { count } } } }");
});

test("search_objects posts the built query and returns the collection's objects", async () => {
  const hits = [{ title: "A", _additional: { id: OBJECT_ID, distance: 0.1 } }];
  const { result, calls } = await run("search_objects", { collection: "Article", properties: ["title"], near_text: ["a"] }, { responses: [{ body: { data: { Get: { Article: hits } } } }] });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${SERVER}/v1/graphql`);
  assert.equal(calls[0].headers.authorization, "Bearer wv-key-1");
  assert.match(calls[0].json.query, /^\{ Get \{ Article\(nearText:/);
  assert.deepEqual(result.data, hits);
});

test("count_objects returns the meta count", async () => {
  const { result } = await run("count_objects", { collection: "Article" }, { responses: [{ body: { data: { Aggregate: { Article: [{ meta: { count: 42 } }] } } } }] });
  assert.deepEqual(result.data, { count: 42 });
});

test("GraphQL errors in a 200 body become errors, with the API key redacted", async () => {
  const graphqlError = { body: { data: { Get: { Article: null } }, errors: [{ message: "no such class Artcle wv-key-1" }] } };
  await assert.rejects(run("search_objects", { collection: "Article" }, { responses: [graphqlError] }), (error) => error.message.includes("no such class") && !error.message.includes("wv-key-1"));
});

test("free searches are retried after a 5xx; near_text (paid embedding) is not", async () => {
  const serverError = { status: 503, body: { error: [{ message: "unavailable" }] } };
  const ok = { body: { data: { Get: { Article: [] } } } };
  const bm25 = await run("search_objects", { collection: "Article", bm25_query: "a" }, { responses: [serverError, ok] });
  assert.equal(bm25.calls.length, 2);
  const recordingFetch = createRecordingFetch([serverError, ok]);
  const runner = createOperationRunner(pluginDefinition, baseEnvironment, { fetchImpl: recordingFetch });
  await assert.rejects(runner("search_objects", { collection: "Article", near_text: ["a"] }, { source: "tool" }), (error) => error.retryable === false);
  assert.equal(recordingFetch.calls.length, 1);
});

test("REST errors map with Weaviate's message", async () => {
  await assert.rejects(run("get_object", { collection: "Article", object_id: OBJECT_ID }, { responses: [{ status: 404, body: { error: [{ message: "object not found" }] } }] }), (error) => error.kind === "not_found");
  await assert.rejects(run("get_meta", {}, { responses: [{ status: 401, body: { code: 401, message: "anonymous access not enabled" } }] }), (error) => error.kind === "auth_error" && error.message.includes("anonymous access not enabled"));
});

test("provider headers are sent and redacted; bad entries are refused", async () => {
  const environment = { WEAVIATE_PROVIDER_HEADERS: '{"X-OpenAI-Api-Key": "sk-provider-1"}' };
  const { calls } = await run("get_meta", {}, { environment, responses: [{ body: { echoed: "sk-provider-1" } }] });
  assert.equal(calls[0].headers["x-openai-api-key"], "sk-provider-1");
  const { result } = await run("get_meta", {}, { environment, responses: [{ body: { echoed: "sk-provider-1" } }] });
  assert.equal(JSON.stringify(result.data).includes("sk-provider-1"), false);
  assert.throws(() => readProviderHeaders({ WEAVIATE_PROVIDER_HEADERS: '{"Authorization": "x"}' }), isInvalid);
  assert.throws(() => readProviderHeaders({ WEAVIATE_PROVIDER_HEADERS: '{"X-A": "a\\r\\nX-B: b"}' }), isInvalid);
  assert.throws(() => readProviderHeaders({ WEAVIATE_PROVIDER_HEADERS: "not json" }), isInvalid);
});

test("without an API key no Authorization header is sent (anonymous local Weaviate)", async () => {
  const { calls } = await run("get_meta", {}, { environment: { WEAVIATE_URL: "http://localhost:8080", WEAVIATE_API_KEY: "" } });
  assert.equal(calls[0].url, "http://localhost:8080/v1/meta");
  assert.equal(calls[0].headers.authorization, undefined);
});

test("WEAVIATE_URL is validated: https or localhost http, bare host names get https", async () => {
  assert.equal(resolveWeaviateUrl({}), "http://localhost:8080");
  assert.equal(resolveWeaviateUrl({ WEAVIATE_URL: "abc.weaviate.cloud" }), "https://abc.weaviate.cloud");
  assert.throws(() => resolveWeaviateUrl({ WEAVIATE_URL: "https://u:p@abc.weaviate.cloud" }), /credentials/);
  await assert.rejects(run("get_meta", {}, { environment: { WEAVIATE_URL: "http://10.0.0.2:8080" } }), isInvalid);
});

test("agent policy: writes and raw GraphQL need opt-ins, delete is node only", async () => {
  await assert.rejects(run("create_object", { collection: "Article", properties: {} }), (error) => error.kind === "permission_denied" && error.message.includes("WEAVIATE_TOOL_ALLOW_WRITES"));
  await assert.rejects(run("graphql_query", { query: "{ Get { Article { title } } }" }), (error) => error.kind === "permission_denied" && error.message.includes("WEAVIATE_TOOL_ALLOW_RAW_GRAPHQL"));
  const { calls } = await run("update_object", { collection: "Article", object_id: OBJECT_ID, properties: { a: 1 } }, { environment: { WEAVIATE_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(calls[0].method, "PATCH");
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("delete_object"), false);
  assert.equal(toolNames.includes("search_objects"), true);
});

test("limit, offset and autocut must be non-negative integers in the GraphQL document", () => {
  for (const field of ["limit", "offset", "autocut"]) {
    for (const badValue of ["3) { x }", 2.5, -1, Number.NaN, "5", { a: 1 }]) {
      assert.throws(() => buildGetQuery({ collection: "Article", [field]: badValue }), isInvalid, `${field} ${JSON.stringify(badValue)}`);
    }
  }
  assert.equal(buildGetQuery({ collection: "Article", bm25_query: "a", limit: 0, offset: 3, autocut: 1 }).query.includes("limit: 0, offset: 3, autocut: 1"), true);
});

test("update_object is an unsafe write (the vectorizer may bill), so a 5xx is not retried", async () => {
  const update = pluginDefinition.restSpec.operations.find((operation) => operation.name === "update_object");
  assert.equal(update.write, "unsafe");
  const failure = { status: 503, body: { error: [{ message: "unavailable" }] } };
  const { calls } = await run("get_meta", {}, { source: "node", responses: [{ body: {} }] });
  assert.equal(calls.length, 1);
  const recordingFetch = createRecordingFetch([failure, failure, failure]);
  const runner = createOperationRunner(pluginDefinition, baseEnvironment, { fetchImpl: recordingFetch });
  await assert.rejects(
    runner("update_object", { collection: "Article", object_id: OBJECT_ID, properties: { a: 1 } }, { source: "node" }),
    (error) => error.retryable === false && error.message.includes("get_object"),
  );
  assert.equal(recordingFetch.calls.length, 1);
});

test("api_request as a tool reaches only an allowlist of read paths (no RBAC, users, backups)", async () => {
  const allowed = ["/v1/meta", "/v1/schema", "/v1/schema/Article", "/v1/schema/Article/shards", "/v1/schema/Article/tenants", "/v1/nodes", "/v1/objects?class=Article", `/v1/objects/Article/${OBJECT_ID}`, "/v1/.well-known/ready"];
  for (const path of allowed) {
    const { calls } = await run("api_request", { method: "GET", path }, { responses: [{ body: {} }] });
    assert.equal(calls.length, 1, path);
  }
  const refused = ["/v1/authz/roles", "/v1/authz/users/admin/roles", "/v1/users/own-info", "/v1/users/db", "/v1/users/db/alice", "/v1/backups/s3", "/v1/backups/s3/b1", "/v1/replication/replicate", "/v1/cluster/statistics", "/v1/schema/../authz/roles", "/v1/%61uthz/roles", "/v1/Users/db"];
  for (const path of refused) {
    await assert.rejects(run("api_request", { method: "GET", path }), (error) => error.kind === "permission_denied", path);
  }
  const node = await run("api_request", { method: "GET", path: "/v1/users/db" }, { source: "node", responses: [{ body: [] }] });
  assert.equal(node.calls.length, 1);
});
