/**
 * elasticsearch plugin definition: search, count, ES|QL, documents and index metadata through the Elasticsearch REST
 * API (https://www.elastic.co/docs/api/doc/elasticsearch/). Works with self-managed clusters (8.x/9.x), Elastic Cloud
 * and Serverless. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * The cluster is ELASTICSEARCH_URL (default http://localhost:9200; plain http only on localhost). Auth is
 * ELASTICSEARCH_API_KEY (`Authorization: ApiKey`), else ELASTICSEARCH_USERNAME + ELASTICSEARCH_PASSWORD (Basic).
 *
 * Agent policy: reads are tools (search and count use POST bodies, which Elasticsearch accepts, so they are
 * "idempotent" reads; Node's fetch cannot send GET bodies). ES|QL needs ELASTICSEARCH_TOOL_ALLOW_ESQL=1, and its
 * FROM/TS/JOIN sources are then checked like index arguments. Indexing and updating documents need
 * ELASTICSEARCH_TOOL_ALLOW_WRITES=1; deletes, delete-by-query and _bulk are node only. Tools cannot name dot
 * (system/hidden) indices (also inside comma lists, behind `cluster:` or via expand_wildcards hidden/all), and
 * api_request as a tool only reaches an allowlist of read paths (no _security, _nodes, _snapshot, ...).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { API_KEY_ENV, authorizeElasticsearch, PASSWORD_ENV, resolveClusterUrl, restrictToolIndexNames, URL_ENV, USERNAME_ENV } from "./lib/elasticsearch-extras.mjs";
import { ESQL_OPT_IN_ENV, restrictToolApiRequestIndices, restrictToolEsql } from "./lib/tool-index-policy.mjs";

const WRITE_OPT_IN = "optIn:ELASTICSEARCH_TOOL_ALLOW_WRITES";
const MAX_RESULT_WINDOW = 10000;

const indexParam = {
  in: "path",
  type: "string",
  required: true,
  minLength: 1,
  description: 'Index, data stream or alias; comma-separated and wildcards allowed for reads, e.g. "logs-*,metrics-*"',
};
const singleIndexParam = { in: "path", type: "string", required: true, minLength: 1, description: "Index, data stream or alias to write to" };
const docIdParam = { in: "path", type: "string", required: true, minLength: 1, description: "Document _id" };
const queryParam = { in: "body", type: "object", description: 'Query DSL, e.g. {"match": {"title": "graph"}} or {"bool": {"filter": [...]}} (default match_all)' };
const routingParam = { in: "query", type: "string", description: "Custom routing value (only when the index uses routing)" };
const refreshParam = { in: "query", type: "string", enum: ["true", "false", "wait_for"], description: "Make the change visible to search: true, wait_for or false (default)" };

// --- cluster and index metadata --------------------------------------------------------------------

const metadataOperations = [
  {
    name: "get_cluster_info",
    title: "Cluster info",
    description: "Cluster name, uuid and version (version.number, build flavor) of the connected cluster",
    path: "/",
  },
  {
    name: "get_cluster_health",
    title: "Cluster health",
    description: "Cluster health: status (green/yellow/red), node counts, active/unassigned shards",
    path: "/_cluster/health",
    params: { level: { in: "query", type: "string", enum: ["cluster", "indices", "shards"], description: "Detail level (default cluster)" } },
    // Health defaults to expand_wildcards=all, so level=indices would list hidden and system index names.
    constants: { query: { expand_wildcards: "open,closed" } },
  },
  {
    name: "list_indices",
    title: "List indices",
    description: "Indices with health, status, document count and size (_cat/indices as JSON); hidden and system indices are not listed",
    path: "/_cat/indices",
    params: {
      health: { in: "query", type: "string", enum: ["green", "yellow", "red"], description: "Only indices with this health" },
      columns: { in: "query", type: "array", items: { type: "string" }, wireName: "h", description: "Columns, e.g. index, health, docs.count, store.size (default all)" },
      sort_by: { in: "query", type: "array", items: { type: "string" }, wireName: "s", description: 'Sort columns, e.g. ["index"] or ["docs.count:desc"]' },
      bytes: { in: "query", type: "string", enum: ["b", "kb", "mb", "gb"], description: "Unit for sizes (default human readable)" },
    },
    // _cat/indices defaults to expand_wildcards=all, which would list hidden and system indices.
    constants: { query: { format: "json", expand_wildcards: "open,closed" } },
  },
  {
    name: "get_mapping",
    title: "Get mapping",
    description: "Field mappings (types) of an index, keyed by index name",
    path: "/{index}/_mapping",
    params: { index: indexParam },
  },
];

// --- search -----------------------------------------------------------------------------------------

const searchOperations = [
  {
    name: "search",
    title: "Search",
    description: "Search documents with the Query DSL; hits are in hits.hits[]._source, totals in hits.total, aggregations in aggregations",
    method: "POST",
    path: "/{index}/_search",
    // A search changes nothing, so it may be retried.
    write: "idempotent",
    params: {
      index: indexParam,
      query: queryParam,
      size: { in: "body", type: "integer", min: 0, max: MAX_RESULT_WINDOW, default: 10, description: "Hits to return (0 for aggregations only)" },
      from: { in: "body", type: "integer", min: 0, max: MAX_RESULT_WINDOW, description: "Offset (from + size at most 10000; use search_after beyond)" },
      sort: { in: "body", type: "array", items: {}, description: 'Sort, e.g. [{"@timestamp": "desc"}, "_score"]' },
      search_after: { in: "body", type: "array", items: {}, description: "The sort values of the last hit of the previous page" },
      source_fields: { in: "body", type: "array", items: { type: "string" }, wireName: "_source", description: 'Only these _source fields, e.g. ["title", "author.*"]' },
      fields: { in: "body", type: "array", items: { type: "string" }, description: "Fields to return from mappings (fields[] in each hit)" },
      aggs: { in: "body", type: "object", description: 'Aggregations, e.g. {"by_tag": {"terms": {"field": "tags"}}}' },
      highlight: { in: "body", type: "object", description: 'Highlighting, e.g. {"fields": {"body": {}}}' },
      knn: { in: "body", type: "object", description: 'Approximate kNN, e.g. {"field": "embedding", "query_vector": [...], "k": 10, "num_candidates": 100}' },
      track_total_hits: { in: "body", type: "boolean", description: "Count all hits exactly (default: up to 10000)" },
      search_timeout: { in: "body", type: "string", wireName: "timeout", description: 'Search time limit, e.g. "10s"' },
      routing: routingParam,
    },
  },
  {
    name: "count",
    title: "Count",
    description: "Number of documents matching a query (count)",
    method: "POST",
    path: "/{index}/_count",
    write: "idempotent",
    params: { index: indexParam, query: queryParam, routing: routingParam },
  },
  {
    name: "esql_query",
    title: "ES|QL query",
    description:
      'Run an ES|QL query (read-only language), e.g. "FROM logs-* | WHERE status >= 500 | STATS c = COUNT(*) BY host | LIMIT 10"; columns and values are returned',
    method: "POST",
    path: "/_query",
    write: "idempotent",
    // ES|QL names its sources inside the query text, so agents need an opt-in and a source check (tool-index-policy).
    toolPolicy: `optIn:${ESQL_OPT_IN_ENV}`,
    params: {
      query: { in: "body", type: "string", required: true, minLength: 1, description: "ES|QL query; use ? placeholders with params for values" },
      params: { in: "body", type: "array", items: {}, description: 'Values for ? placeholders, e.g. ["error", 500]' },
      filter: { in: "body", type: "object", description: "Query DSL filter applied before the ES|QL query" },
      columnar: { in: "body", type: "boolean", description: "Return values column by column" },
    },
  },
];

// --- documents --------------------------------------------------------------------------------------

const documentOperations = [
  {
    name: "get_document",
    title: "Get document",
    description: "One document by _id; the document is in _source (found: false when missing returns not_found)",
    path: "/{index}/_doc/{doc_id}",
    params: {
      index: singleIndexParam,
      doc_id: docIdParam,
      source_includes: { in: "query", type: "array", items: { type: "string" }, wireName: "_source_includes", description: "Only these _source fields" },
      routing: routingParam,
    },
  },
  {
    name: "multi_get",
    title: "Get documents",
    description: "Several documents of one index by _id (docs[] with found and _source)",
    method: "POST",
    path: "/{index}/_mget",
    write: "idempotent",
    params: {
      index: singleIndexParam,
      ids: { in: "body", type: "array", items: { type: "string" }, required: true, maxItems: 1000, description: "Document ids" },
      source_includes: { in: "query", type: "array", items: { type: "string" }, wireName: "_source_includes", description: "Only these _source fields" },
    },
  },
  {
    name: "index_document",
    title: "Index document",
    description: "Create or replace the document with this _id (result: created or updated)",
    method: "PUT",
    path: "/{index}/_doc/{doc_id}",
    // Writing the same document again leaves the same content (only _version grows).
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    bodyMode: "raw",
    params: {
      index: singleIndexParam,
      doc_id: docIdParam,
      document: { in: "body", type: "object", required: true, description: 'The whole document, e.g. {"title": "Hello", "tags": ["a"]}' },
      refresh: refreshParam,
      routing: routingParam,
    },
  },
  {
    name: "create_document",
    title: "Create document",
    description: "Add a document with a generated _id (returned as _id)",
    method: "POST",
    path: "/{index}/_doc",
    write: "unsafe",
    checkHint: "search the index for the document before adding it again",
    toolPolicy: WRITE_OPT_IN,
    bodyMode: "raw",
    params: {
      index: singleIndexParam,
      document: { in: "body", type: "object", required: true, description: "The whole document" },
      refresh: refreshParam,
      routing: routingParam,
    },
  },
  {
    name: "update_document",
    title: "Update document",
    description: "Merge fields into a document (partial update; no scripts); doc_as_upsert creates it when missing",
    method: "POST",
    path: "/{index}/_update/{doc_id}",
    write: "unsafe",
    checkHint: "get_document and compare its fields",
    toolPolicy: WRITE_OPT_IN,
    params: {
      index: singleIndexParam,
      doc_id: docIdParam,
      doc: { in: "body", type: "object", required: true, description: 'Fields to merge, e.g. {"status": "done"}' },
      doc_as_upsert: { in: "body", type: "boolean", description: "Create the document from doc when it does not exist" },
      refresh: refreshParam,
      retry_on_conflict: { in: "query", type: "integer", min: 0, max: 10, description: "Retries on version conflicts" },
      routing: routingParam,
    },
  },
  {
    name: "delete_document",
    title: "Delete document",
    description: "Delete one document by _id",
    method: "DELETE",
    path: "/{index}/_doc/{doc_id}",
    write: "idempotent",
    nodeOnly: true,
    params: { index: singleIndexParam, doc_id: docIdParam, refresh: refreshParam, routing: routingParam },
  },
  {
    name: "delete_by_query",
    title: "Delete by query",
    description: "Delete every document matching a query (deleted, failures)",
    method: "POST",
    path: "/{index}/_delete_by_query",
    write: "unsafe",
    checkHint: "count the matching documents",
    nodeOnly: true,
    params: {
      index: indexParam,
      query: { in: "body", type: "object", required: true, description: "Query DSL selecting the documents to delete" },
      refresh: { in: "query", type: "boolean", description: "Refresh the affected shards afterwards" },
      conflicts: { in: "query", type: "string", enum: ["abort", "proceed"], description: "On version conflicts: abort (default) or proceed" },
    },
  },
  {
    name: "bulk",
    title: "Bulk",
    description:
      'Many index/create/update/delete actions in one request; lines alternate action and source, e.g. [{"index": {"_index": "docs", "_id": "1"}}, {"title": "A"}]; check errors and items[]',
    method: "POST",
    path: "/_bulk",
    write: "unsafe",
    checkHint: "get or search the affected documents",
    nodeOnly: true,
    bodyMode: "text",
    contentType: "application/x-ndjson",
    timeoutMs: 110000,
    params: {
      lines: { in: "body", type: "array", items: { type: "object" }, required: true, description: "NDJSON lines (action, then source for index/create/update)" },
      refresh: refreshParam,
    },
  },
];

const ID = "[^/]+";
const INDEX = "[^/_.][^/]*";
// GET paths agent tools may reach through api_request (normalized: lowercase, decoded, dot segments resolved).
const TOOL_API_PATHS = [
  "",
  "/_cluster/health",
  `/_cluster/health/${INDEX}`,
  `/_cat/(indices|aliases|count|health|allocation)`,
  `/_cat/(indices|aliases|count)/${INDEX}`,
  "/_(mapping|alias|aliases|settings)",
  `/_resolve/index/${INDEX}`,
  `/${INDEX}`,
  `/${INDEX}/_(mapping|settings|alias|count|search|stats|field_caps)`,
  `/${INDEX}/_(doc|source)/${ID}`,
].map((pattern) => new RegExp(`^${pattern}/?$`));

const restDefinition = defineRestPlugin({
  name: "elasticsearch",
  version: "0.1.0",
  description:
    "Elasticsearch: search, count and ES|QL, get and multi-get documents, index metadata; index/update need an opt-in for agents, deletes and bulk are node only",
  apiName: "Elasticsearch REST API",
  baseUrl: resolveClusterUrl,
  auth: { type: "custom", authorize: authorizeElasticsearch },
  extraEnv: [URL_ENV, API_KEY_ENV, USERNAME_ENV, PASSWORD_ENV, "ELASTICSEARCH_TOOL_API_EXTRA_PATHS"],
  limits: { timeout_ms: 120000 },
  // Errors are {"error": {"root_cause": [...], "type": "index_not_found_exception", "reason": "no such index [x]"}, "status": 404};
  // a few APIs answer {"error": "..."}.
  errors: {
    messagePath: ["error.reason", "error.root_cause.0.reason", "error.caused_by.reason", "error"],
    codePath: "error.type",
    kindByCode: {
      index_not_found_exception: "not_found",
      resource_not_found_exception: "not_found",
      parsing_exception: "invalid_input",
      verification_exception: "invalid_input",
      x_content_parse_exception: "invalid_input",
      illegal_argument_exception: "invalid_input",
      es_rejected_execution_exception: "rate_limited",
      circuit_breaking_exception: "rate_limited",
    },
  },
  apiRequest: { examplePath: "/<index>/_settings" },
  operations: [...metadataOperations, ...searchOperations, ...documentOperations],
});

const guardedDefinition = guardToolApiRequest(restDefinition, {
  allowedPaths: TOOL_API_PATHS,
  blockedPaths: [/(^|\/)\./],
  extraAllowedPathsEnv: "ELASTICSEARCH_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read cluster health, _cat lists, mappings, settings, documents and searches of non-system indices; use a workflow node",
});

export const pluginDefinition = restrictToolEsql(restrictToolApiRequestIndices(restrictToolIndexNames(guardedDefinition)));
