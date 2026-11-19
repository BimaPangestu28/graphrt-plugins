import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const CLUSTER = "https://es.example.test";
const API_KEY = "contract-api-key-0001";

describeRestPluginContract(pluginDefinition, {
  environment: { ELASTICSEARCH_URL: `${CLUSTER}/`, ELASTICSEARCH_API_KEY: API_KEY },
  checkAuth: (call) => assert.equal(call.headers.authorization, `ApiKey ${API_KEY}`),
  operations: {
    get_cluster_info: {
      args: {},
      request: { method: "GET", url: `${CLUSTER}/`, query: "absent" },
      response: { body: { cluster_name: "docs", version: { number: "9.2.0" } } },
      expect: { data: { cluster_name: "docs", version: { number: "9.2.0" } } },
    },
    get_cluster_health: {
      args: { level: "indices" },
      request: { method: "GET", url: `${CLUSTER}/_cluster/health`, query: { level: "indices", expand_wildcards: "open,closed" } },
    },
    list_indices: {
      args: { health: "yellow", columns: ["index", "docs.count"], sort_by: ["docs.count:desc"], bytes: "mb" },
      request: { method: "GET", url: `${CLUSTER}/_cat/indices`, query: { health: "yellow", h: "index,docs.count", s: "docs.count:desc", bytes: "mb", format: "json", expand_wildcards: "open,closed" } },
      response: { body: [{ index: "docs", "docs.count": "3" }] },
      expect: { data: [{ index: "docs", "docs.count": "3" }] },
    },
    get_mapping: {
      args: { index: "logs-*,metrics-*" },
      request: { method: "GET", url: `${CLUSTER}/logs-*%2Cmetrics-*/_mapping`, query: "absent" },
    },
    search: {
      args: {
        index: "docs",
        query: { match: { title: "graph" } },
        size: 5,
        sort: [{ "@timestamp": "desc" }],
        source_fields: ["title"],
        aggs: { tags: { terms: { field: "tags" } } },
        search_timeout: "5s",
        routing: "user-1",
      },
      request: {
        method: "POST",
        url: `${CLUSTER}/docs/_search`,
        query: { routing: "user-1" },
        json: { query: { match: { title: "graph" } }, size: 5, sort: [{ "@timestamp": "desc" }], _source: ["title"], aggs: { tags: { terms: { field: "tags" } } }, timeout: "5s" },
      },
      response: { body: { hits: { total: { value: 1 }, hits: [{ _id: "1", _source: { title: "graph" } }] } } },
      expect: { data: { hits: { total: { value: 1 }, hits: [{ _id: "1", _source: { title: "graph" } }] } } },
    },
    count: {
      args: { index: "docs", query: { term: { status: "open" } } },
      request: { method: "POST", url: `${CLUSTER}/docs/_count`, query: "absent", json: { query: { term: { status: "open" } } } },
    },
    esql_query: {
      args: { query: "FROM docs | WHERE status == ? | LIMIT 5", params: ["open"] },
      request: { method: "POST", url: `${CLUSTER}/_query`, query: "absent", json: { query: "FROM docs | WHERE status == ? | LIMIT 5", params: ["open"] } },
    },
    get_document: {
      args: { index: "docs", doc_id: "a/1", source_includes: ["title", "tags"] },
      request: { method: "GET", url: `${CLUSTER}/docs/_doc/a%2F1`, query: { _source_includes: "title,tags" } },
    },
    multi_get: {
      args: { index: "docs", ids: ["1", "2"] },
      request: { method: "POST", url: `${CLUSTER}/docs/_mget`, query: "absent", json: { ids: ["1", "2"] } },
    },
    index_document: {
      args: { index: "docs", doc_id: "1", document: { title: "Hello" }, refresh: "wait_for" },
      request: { method: "PUT", url: `${CLUSTER}/docs/_doc/1`, query: { refresh: "wait_for" }, json: { title: "Hello" } },
    },
    create_document: {
      args: { index: "docs", document: { title: "New" } },
      request: { method: "POST", url: `${CLUSTER}/docs/_doc`, query: "absent", json: { title: "New" } },
    },
    update_document: {
      args: { index: "docs", doc_id: "1", doc: { status: "done" }, doc_as_upsert: true, retry_on_conflict: 3 },
      request: { method: "POST", url: `${CLUSTER}/docs/_update/1`, query: { retry_on_conflict: "3" }, json: { doc: { status: "done" }, doc_as_upsert: true } },
    },
    delete_document: {
      args: { index: "docs", doc_id: "1" },
      request: { method: "DELETE", url: `${CLUSTER}/docs/_doc/1`, query: "absent", body: "absent" },
    },
    delete_by_query: {
      args: { index: "docs", query: { term: { status: "spam" } }, conflicts: "proceed" },
      request: { method: "POST", url: `${CLUSTER}/docs/_delete_by_query`, query: { conflicts: "proceed" }, json: { query: { term: { status: "spam" } } } },
    },
    bulk: {
      args: { lines: [{ index: { _index: "docs", _id: "1" } }, { title: "A" }], refresh: "true" },
      request: { method: "POST", url: `${CLUSTER}/_bulk`, query: { refresh: "true" }, text: '{"index":{"_index":"docs","_id":"1"}}\n{"title":"A"}\n' },
    },
  },
});
