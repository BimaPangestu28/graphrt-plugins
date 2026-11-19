import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { isRestrictedIndexName, resolveClusterUrl } from "../lib/elasticsearch-extras.mjs";
import { pluginDefinition } from "../definition.mjs";

const CLUSTER = "https://es.example.test";

async function run(operationName, args, { source = "tool", environment = { ELASTICSEARCH_API_KEY: "key-1" }, responses = [{ body: {} }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { ELASTICSEARCH_URL: CLUSTER, ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const refusedFor = (kind) => (error) => error.kind === kind;

test("ELASTICSEARCH_URL must be https (http only on localhost) without credentials or query", () => {
  assert.equal(resolveClusterUrl({}), "http://localhost:9200");
  assert.equal(resolveClusterUrl({ ELASTICSEARCH_URL: "https://x.es.io:9243/prefix/" }), "https://x.es.io:9243/prefix");
  assert.throws(() => resolveClusterUrl({ ELASTICSEARCH_URL: "https://elastic:pw@x.es.io" }), /credentials/);
  assert.throws(() => resolveClusterUrl({ ELASTICSEARCH_URL: "https://x.es.io/?a=1" }), /query/);
});

test("a remote http cluster URL is refused before any request", async () => {
  await assert.rejects(run("get_cluster_info", {}, { environment: { ELASTICSEARCH_URL: "http://10.0.0.5:9200" } }), refusedFor("invalid_input"));
});

test("basic auth from username and password when no API key is set; nothing without credentials", async () => {
  const { calls } = await run("get_cluster_info", {}, { environment: { ELASTICSEARCH_USERNAME: "elastic", ELASTICSEARCH_PASSWORD: "pw-1" } });
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("elastic:pw-1").toString("base64")}`);
  const anonymous = await run("get_cluster_info", {}, { environment: {} });
  assert.equal(anonymous.calls[0].headers.authorization, undefined);
  await assert.rejects(run("get_cluster_info", {}, { environment: { ELASTICSEARCH_USERNAME: "elastic" } }), refusedFor("auth_error"));
});

test("the API key and password are redacted from errors and data", async () => {
  const echo = { status: 400, body: { error: { type: "illegal_argument_exception", reason: "bad key key-1" } } };
  await assert.rejects(run("get_cluster_info", {}, { responses: [echo] }), (error) => error.kind === "invalid_input" && !error.message.includes("key-1"));
  const { result } = await run("get_cluster_info", {}, { environment: { ELASTICSEARCH_USERNAME: "u", ELASTICSEARCH_PASSWORD: "pw-secret" }, responses: [{ body: { echo: "pw-secret" } }] });
  assert.equal(JSON.stringify(result.data).includes("pw-secret"), false);
});

test("Elasticsearch error bodies map to kinds with the reason and type", async () => {
  const missing = { status: 404, body: { error: { root_cause: [], type: "index_not_found_exception", reason: "no such index [nope]" }, status: 404 } };
  await assert.rejects(run("get_mapping", { index: "nope" }, { responses: [missing] }), (error) => error.kind === "not_found" && error.message.includes("no such index [nope] (index_not_found_exception)"));
  const forbidden = { status: 403, body: { error: { type: "security_exception", reason: "action [indices:data/read/search] is unauthorized" } } };
  await assert.rejects(run("search", { index: "docs" }, { responses: [forbidden] }), refusedFor("permission_denied"));
});

test("isRestrictedIndexName: dot and underscore names (also remote), but not exclusions or _all", () => {
  for (const name of [".security-7", " .kibana", "remote:.tasks", "_security", "_nodes"]) assert.equal(isRestrictedIndexName(name), true, name);
  for (const name of ["logs-*", "_all", "-.old", "remote:logs", "*"]) assert.equal(isRestrictedIndexName(name), false, name);
});

test("isRestrictedIndexName: parses cluster: prefix and ::selector before the dot check", () => {
  const refused = [".security-7::data", ".security::failures", "remote:.security::failures", "remote:.kibana::data", "_security::data", "logs::unknown", "logs::*", "logs::", "remote:", ":.security"];
  for (const name of refused) assert.equal(isRestrictedIndexName(name), true, name);
  for (const name of ["logs::data", "logs-*::failures", "remote:logs::data", "remote:logs-*", "-.old::data"]) assert.equal(isRestrictedIndexName(name), false, name);
});

test("isRestrictedIndexName: date-math names are refused, raw or percent-encoded", () => {
  for (const name of ["<.security-7{now}>", "<logs-{now/d}>", "%3C.security-7%7Bnow%7D%3E", "%253Clogs-%7Bnow%7D%253E", "remote:<.security{now}>", " <x>"]) {
    assert.equal(isRestrictedIndexName(name), true, name);
  }
});

test("tools cannot reach system indices through selectors or date math in index arguments", async () => {
  for (const [operationName, args] of [
    ["search", { index: ".security-7::data" }],
    ["search", { index: "logs,<.security-7{now}>" }],
    ["count", { index: "remote:.security::failures" }],
    ["get_mapping", { index: ".kibana::data" }],
    ["multi_get", { index: "<.security{now}>", ids: ["1"] }],
    ["search", { index: "logs::bogus" }],
  ]) {
    await assert.rejects(run(operationName, args), refusedFor("permission_denied"), `${operationName} ${JSON.stringify(args)}`);
  }
  const { calls } = await run("search", { index: "logs-*::failures" });
  assert.equal(calls.length, 1);
});

test("api_request as a tool refuses selectors on system indices, unknown selectors and date math", async () => {
  const refused = [
    "/.security-7::data/_search",
    "/remote:.security::failures/_search",
    "/logs::bogus/_search",
    "/%3C.security-7%7Bnow%7D%3E/_search",
    "/%253C.security%7Bnow%7D%253E/_search",
    "/<logs-{now}>/_search",
    "/_cat/indices/<.security{now}>",
    "/_cat/indices/.security::data",
    "/logs/_doc/<x>/../../.security-7::data/_search",
  ];
  for (const path of refused) await assert.rejects(run("api_request", { method: "GET", path }), refusedFor("permission_denied"), path);
  const { calls } = await run("api_request", { method: "GET", path: "/logs::failures/_search" });
  assert.equal(calls.length, 1);
});

test("api_request as a tool cannot list shards, and listing endpoints are limited to open and closed indices", async () => {
  for (const path of ["/_cat/shards", "/_cat/shards/logs"]) await assert.rejects(run("api_request", { method: "GET", path }), refusedFor("permission_denied"), path);
  for (const path of ["/_cat/indices", "/_cat/aliases", "/_cat/indices/logs-*", "/_alias", "/_aliases", "/_mapping", "/_settings", "/logs-*/_mapping", "/logs-*/_search"]) {
    const { calls } = await run("api_request", { method: "GET", path });
    assert.equal(new URL(calls[0].url).searchParams.get("expand_wildcards"), "open,closed", path);
  }
  const doc = await run("api_request", { method: "GET", path: "/logs/_doc/1" });
  assert.equal(new URL(doc.calls[0].url).searchParams.has("expand_wildcards"), false);
  const explicit = await run("api_request", { method: "GET", path: "/_cat/indices", query: { expand_wildcards: "open" } });
  assert.equal(new URL(explicit.calls[0].url).searchParams.get("expand_wildcards"), "open");
  const node = await run("api_request", { method: "GET", path: "/_cat/shards" }, { source: "node" });
  assert.equal(new URL(node.calls[0].url).searchParams.has("expand_wildcards"), false);
});

test("with the ES|QL opt-in, tools cannot use selectors on system indices or date math", async () => {
  const environment = { ELASTICSEARCH_API_KEY: "k", ELASTICSEARCH_TOOL_ALLOW_ESQL: "1" };
  for (const query of ["FROM .security-7::data | LIMIT 1", "FROM <.security-7{now}> | LIMIT 1", 'FROM "<.security{now}>" | LIMIT 1', "FROM logs, <logs-{now/d}> | LIMIT 1", "FROM logs::bogus | LIMIT 1"]) {
    await assert.rejects(run("esql_query", { query }, { environment }), refusedFor("permission_denied"), query);
  }
  const { calls } = await run("esql_query", { query: "FROM logs::failures | LIMIT 1" }, { environment });
  assert.equal(calls.length, 1);
});

test("tools cannot search, read or map system indices; workflow nodes can", async () => {
  await assert.rejects(run("search", { index: "logs-*,.security*" }), refusedFor("permission_denied"));
  await assert.rejects(run("get_document", { index: ".kibana", doc_id: "x" }), refusedFor("permission_denied"));
  await assert.rejects(run("get_mapping", { index: "_nodes" }), refusedFor("permission_denied"));
  const { calls } = await run("search", { index: ".security" }, { source: "node" });
  assert.equal(calls[0].url, `${CLUSTER}/.security/_search`);
});

test("document writes need ELASTICSEARCH_TOOL_ALLOW_WRITES=1 for tools", async () => {
  const args = { index: "docs", doc_id: "1", document: { a: 1 } };
  await assert.rejects(run("index_document", args), (error) => error.kind === "permission_denied" && error.message.includes("ELASTICSEARCH_TOOL_ALLOW_WRITES"));
  const { calls } = await run("index_document", args, { environment: { ELASTICSEARCH_API_KEY: "k", ELASTICSEARCH_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(calls[0].method, "PUT");
});

test("deletes, delete-by-query and bulk are not agent tools", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const name of ["delete_document", "delete_by_query", "bulk"]) assert.equal(toolNames.includes(name), false, name);
  assert.equal(toolNames.includes("search"), true);
});

test("api_request as a tool reaches only allowlisted read paths", async () => {
  for (const path of ["/", "/_cluster/health", "/_cat/indices", "/docs/_mapping", "/docs/_doc/1", "/docs/_search?q=title:a"]) {
    const { calls } = await run("api_request", { method: "GET", path });
    assert.equal(calls.length, 1, path);
  }
  for (const path of ["/_security/user", "/_nodes", "/_nodes/settings", "/_snapshot", "/.security/_search", "/docs/../_security/api_key", "/_cluster/settings", "/%5Fsecurity/user"]) {
    await assert.rejects(run("api_request", { method: "GET", path }), refusedFor("permission_denied"), path);
  }
});

test("api_request as a tool checks every comma-separated index name in a path segment", async () => {
  for (const path of ["/logs,.security-7/_search", "/logs,remote:.kibana/_mapping", "/docs,_security/_search", "/_cat/indices/logs,.tasks", "/remote:.security/_search", "/logs%2C.security/_search"]) {
    await assert.rejects(run("api_request", { method: "GET", path }), refusedFor("permission_denied"), path);
  }
  for (const path of ["/logs,metrics-*/_search", "/logs,-.old/_count", "/_cat/indices/logs,metrics"]) {
    const { calls } = await run("api_request", { method: "GET", path });
    assert.equal(calls.length, 1, path);
  }
});

test("tools may only use expand_wildcards open/closed in api_request", async () => {
  const refused = [
    ["/_cat/indices", { expand_wildcards: "all" }],
    ["/_cat/indices", { expand_wildcards: "open,hidden" }],
    ["/_cat/indices", { expand_wildcards: ["open", "hidden"] }],
    ["/_cat/indices?expand_wildcards=all", undefined],
    ["/logs-*/_search?expand_wildcards=%61ll", undefined],
    ["/logs-*/_search?q=a&expand%5Fwildcards=hidden", undefined],
  ];
  for (const [path, query] of refused) {
    await assert.rejects(run("api_request", { method: "GET", path, query }), refusedFor("permission_denied"), `${path} ${JSON.stringify(query)}`);
  }
  const { calls } = await run("api_request", { method: "GET", path: "/_cat/indices", query: { expand_wildcards: "open,closed" } });
  assert.equal(calls.length, 1);
  const node = await run("api_request", { method: "GET", path: "/_cat/indices", query: { expand_wildcards: "all" } }, { source: "node" });
  assert.equal(node.calls.length, 1);
});

test("search has no expand_wildcards parameter, so tools cannot widen it to hidden indices", () => {
  const search = buildManifest(pluginDefinition).tools.find((tool) => tool.name === "search");
  assert.equal(JSON.stringify(search).includes("expand_wildcards"), false);
});

test("esql_query is refused for tools unless ELASTICSEARCH_TOOL_ALLOW_ESQL=1; nodes always run it", async () => {
  const args = { query: "FROM logs-* | LIMIT 1" };
  await assert.rejects(run("esql_query", args), (error) => error.kind === "permission_denied" && error.message.includes("ELASTICSEARCH_TOOL_ALLOW_ESQL"));
  const { calls } = await run("esql_query", args, { environment: { ELASTICSEARCH_API_KEY: "k", ELASTICSEARCH_TOOL_ALLOW_ESQL: "1" } });
  assert.equal(calls.length, 1);
  const node = await run("esql_query", { query: "FROM .security-7 | LIMIT 1" }, { source: "node" });
  assert.equal(node.calls.length, 1);
});

test("with the ES|QL opt-in, tools cannot read system or underscore indices", async () => {
  const environment = { ELASTICSEARCH_API_KEY: "k", ELASTICSEARCH_TOOL_ALLOW_ESQL: "1" };
  const refused = [
    "FROM .security-7 | LIMIT 1",
    "from logs-*, .kibana | LIMIT 1",
    'FROM "logs",".tasks" | LIMIT 1',
    "FROM remote:.security | LIMIT 1",
    "FROM _security | LIMIT 1",
    "FROM logs /* c */ , .security | LIMIT 1",
    "FROM\u001c.security | LIMIT 1",
    "FROM logs, .security | LIMIT 1",
    "TS .monitoring-es | LIMIT 1",
    "FROM logs | LOOKUP JOIN .security ON id",
    "ROW a = 1 | LOOKUP JOIN `.security` ON a",
    'FROM """.security""" | LIMIT 1',
  ];
  for (const query of refused) await assert.rejects(run("esql_query", { query }, { environment }), refusedFor("permission_denied"), JSON.stringify(query));
  const allowed = ['FROM logs-*, metrics-* METADATA _index | WHERE host.name == "a" | LIMIT 5', "FROM logs | STATS c = COUNT(*) BY status", "FROM logs, -.old | LIMIT 1"];
  for (const query of allowed) {
    const { calls } = await run("esql_query", { query }, { environment });
    assert.equal(calls.length, 1, query);
  }
});
