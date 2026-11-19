/**
 * qdrant plugin definition: the Qdrant vector database REST API (https://api.qdrant.tech/api-reference), for Qdrant
 * Cloud or a self-hosted server at QDRANT_URL. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Agent policy: reads (collections, query, scroll, retrieve, count, facets) are tools; creating collections,
 * upserting points and setting payload are tools only with QDRANT_TOOL_ALLOW_WRITES=1; deleting points and
 * collections is node only; queries with server-side inference inputs and create_collection are never retried;
 * api_request as a tool only reaches an allowlist of metadata GET paths (no snapshot
 * downloads, telemetry or cluster internals).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { routeInferenceQueries } from "./lib/inference-routing.mjs";
import { authorizeWithOptionalKey, QDRANT_API_KEY_ENV, QDRANT_URL_ENV, resolveOptionalApiKey, resolveQdrantBaseUrl, withNumericScrollCursor } from "./lib/qdrant-config.mjs";

const WRITE_OPT_IN = "optIn:QDRANT_TOOL_ALLOW_WRITES";
// GET paths agent tools may reach through api_request (normalized: lowercase, decoded, dot segments resolved).
const ID = "[^/]+";
const TOOL_API_PATHS = [
  "/",
  "/(healthz|livez|readyz)",
  "/(collections|aliases)",
  `/collections/${ID}`,
  `/collections/${ID}/(exists|aliases|optimizations|shards)`,
  `/collections/${ID}/points/${ID}`,
].map((pattern) => new RegExp(`^${pattern}$`));

const collectionParam = { in: "path", type: "string", required: true, description: "Collection name" };
const filterParam = {
  in: "body",
  type: "object",
  description: 'Qdrant filter, e.g. {"must": [{"key": "city", "match": {"value": "Bandung"}}], "must_not": [...], "should": [...]}',
};
const pointIdsParam = (description) => ({ in: "body", type: "array", maxItems: 10000, description: `${description} (unsigned integers or UUID strings)` });
const withPayloadParam = { in: "body", type: "boolean", default: true, description: "Return the payload of each point" };
const withVectorParam = { in: "body", type: "boolean", default: false, description: "Return the vectors of each point" };
const consistencyParam = { in: "query", type: "string", enum: ["majority", "quorum", "all"], description: "Read consistency across replicas (default: one replica)" };
const waitParam = { in: "query", type: "boolean", default: true, description: "Wait until the change is applied (false: return once queued)" };
const shardKeyParam = { in: "body", type: "string", description: "Shard key, for collections with custom sharding" };

// --- collections ------------------------------------------------------------------------------------

const collectionOperations = [
  {
    name: "list_collections",
    title: "List collections",
    description: "Names of all collections",
    path: "/collections",
    response: { dataPath: "result.collections" },
  },
  {
    name: "get_collection",
    title: "Get collection",
    description: "Collection info: status, point and indexed vector counts, vector config (size, distance), payload schema",
    path: "/collections/{collection_name}",
    params: { collection_name: collectionParam },
    response: { dataPath: "result" },
  },
  {
    name: "collection_exists",
    title: "Collection exists",
    description: "Whether a collection exists ({exists: true|false})",
    path: "/collections/{collection_name}/exists",
    params: { collection_name: collectionParam },
    response: { dataPath: "result" },
  },
  {
    name: "list_aliases",
    title: "List aliases",
    description: "Collection aliases ({alias_name, collection_name})",
    path: "/aliases",
    response: { dataPath: "result.aliases" },
  },
  {
    name: "create_collection",
    title: "Create collection",
    description: 'Create a collection, e.g. vectors {"size": 768, "distance": "Cosine"} or named vectors {"text": {...}}',
    method: "PUT",
    // A retry after a timeout cannot tell "created by the first attempt" from "already existed", so never retried.
    write: "unsafe",
    checkHint: "collection_exists with the collection name",
    toolPolicy: WRITE_OPT_IN,
    path: "/collections/{collection_name}",
    params: {
      collection_name: collectionParam,
      vectors: { in: "body", type: "object", required: true, description: 'Vector config: {"size": 768, "distance": "Cosine" | "Dot" | "Euclid" | "Manhattan"}, or named configs' },
      sparse_vectors: { in: "body", type: "object", description: 'Named sparse vector configs, e.g. {"bm25": {"modifier": "idf"}}' },
      on_disk_payload: { in: "body", type: "boolean", description: "Keep payload on disk" },
      shard_number: { in: "body", type: "integer", min: 1 },
      replication_factor: { in: "body", type: "integer", min: 1 },
    },
    response: { dataPath: "result" },
  },
  {
    name: "delete_collection",
    title: "Delete collection",
    description: "Delete a collection and all its points",
    method: "DELETE",
    write: "idempotent",
    nodeOnly: true,
    path: "/collections/{collection_name}",
    params: { collection_name: collectionParam },
    response: { dataPath: "result" },
  },
];

// --- reads --------------------------------------------------------------------------------------------

const queryParams = {
  collection_name: collectionParam,
  query: {
    in: "body",
    type: "object",
    description:
      'What to search for: {"nearest": [0.1, ...]} (vector), {"nearest": <point id>}, {"recommend": {"positive": [ids]}}, {"fusion": "rrf"} (with prefetch), {"order_by": "price"}, {"sample": "random"}',
  },
  using: { in: "body", type: "string", description: "Named vector to search (collections with named vectors)" },
  prefetch: { in: "body", type: "array", items: { type: "object" }, maxItems: 20, description: "Sub-queries for hybrid search / re-scoring, e.g. dense and sparse, fused by query {\"fusion\": \"rrf\"}" },
  filter: filterParam,
  score_threshold: { in: "body", type: "number", description: "Drop results scoring below this" },
  search_params: { in: "body", type: "object", wireName: "params", description: 'Search parameters, e.g. {"hnsw_ef": 128, "exact": false}' },
  with_payload: withPayloadParam,
  with_vector: withVectorParam,
  shard_key: shardKeyParam,
  consistency: consistencyParam,
};

const queryPoints = {
  name: "query_points",
  title: "Query points",
  description: "Universal search: nearest neighbours of a vector or point, recommend, hybrid (prefetch + fusion), order by payload; returns scored points",
  method: "POST",
  write: "idempotent",
  path: "/collections/{collection_name}/points/query",
  params: {
    ...queryParams,
    result_limit: { in: "body", type: "integer", min: 1, max: 1000, default: 10, wireName: "limit", description: "Maximum points to return" },
    result_offset: { in: "body", type: "integer", min: 0, wireName: "offset", description: "Skip this many results" },
  },
  response: { dataPath: "result.points" },
};

const queryPointsGroups = {
  name: "query_points_groups",
  title: "Query points in groups",
  description: "Like query_points, but grouped by a payload field (e.g. best chunks per document)",
  method: "POST",
  write: "idempotent",
  path: "/collections/{collection_name}/points/query/groups",
  params: {
    ...queryParams,
    group_by: { in: "body", type: "string", required: true, description: "Payload field to group by, e.g. document_id" },
    group_size: { in: "body", type: "integer", min: 1, max: 100, description: "Points per group (default 3)" },
    group_limit: { in: "body", type: "integer", min: 1, max: 1000, wireName: "limit", description: "Maximum groups (default 10)" },
  },
  response: { dataPath: "result.groups" },
};

// Unsafe twins: the same requests, used when the query embeds text/images server-side (billed inference), so a
// timed-out call is never retried. routeInferenceQueries picks the twin per call and hides it (lib/inference-routing.mjs).
const QUERY_INFERENCE_HINT = "nothing to undo (a query changes no data); your inference provider's usage page shows what was billed";
const inferenceTwin = (operation, checkHint = QUERY_INFERENCE_HINT) => ({
  ...operation,
  name: `${operation.name}_with_inference`,
  write: "unsafe",
  checkHint,
});

const pointReadOperations = [
  queryPoints,
  queryPointsGroups,
  inferenceTwin(queryPoints),
  inferenceTwin(queryPointsGroups),
  {
    name: "scroll_points",
    title: "Scroll points",
    description: "Page through points matching a filter (by id, or ordered by a payload field), with payload",
    method: "POST",
    write: "idempotent",
    path: "/collections/{collection_name}/points/scroll",
    params: {
      collection_name: collectionParam,
      filter: filterParam,
      order_by: { in: "body", type: "object", description: 'Order by an indexed payload field, e.g. {"key": "timestamp", "direction": "desc"} (no cursor paging then)' },
      with_payload: withPayloadParam,
      with_vector: withVectorParam,
      shard_key: shardKeyParam,
      consistency: consistencyParam,
    },
    response: { dataPath: "result.points", cursorPath: "result.next_page_offset", cursorParam: "offset", limitParam: "limit", maxLimit: 1000, defaultLimit: 10 },
  },
  {
    name: "get_points",
    title: "Retrieve points",
    description: "Points by ids with payload (and vectors if asked)",
    method: "POST",
    write: "idempotent",
    path: "/collections/{collection_name}/points",
    params: {
      collection_name: collectionParam,
      ids: { ...pointIdsParam("Point ids"), required: true },
      with_payload: withPayloadParam,
      with_vector: withVectorParam,
      shard_key: shardKeyParam,
      consistency: consistencyParam,
    },
    response: { dataPath: "result" },
  },
  {
    name: "get_point",
    title: "Get point",
    description: "One point by id with payload and vectors",
    path: "/collections/{collection_name}/points/{point_id}",
    params: { collection_name: collectionParam, point_id: { in: "path", type: "string", required: true, description: "Point id (integer or UUID)" }, consistency: consistencyParam },
    response: { dataPath: "result" },
  },
  {
    name: "count_points",
    title: "Count points",
    description: "Number of points matching a filter ({count})",
    method: "POST",
    write: "idempotent",
    path: "/collections/{collection_name}/points/count",
    params: {
      collection_name: collectionParam,
      filter: filterParam,
      exact: { in: "body", type: "boolean", default: true, description: "Exact count (false: faster estimate)" },
      shard_key: shardKeyParam,
      consistency: consistencyParam,
    },
    response: { dataPath: "result" },
  },
  {
    name: "facet_counts",
    title: "Facet counts",
    description: "Distinct values of an indexed payload field with their point counts (hits: [{value, count}])",
    method: "POST",
    write: "idempotent",
    path: "/collections/{collection_name}/facet",
    params: {
      collection_name: collectionParam,
      key: { in: "body", type: "string", required: true, description: "Payload field (must have a keyword/integer/bool index)" },
      filter: filterParam,
      facet_limit: { in: "body", type: "integer", min: 1, max: 1000, wireName: "limit", description: "Maximum values (default 10)" },
      exact: { in: "body", type: "boolean", description: "Exact counts (default false)" },
      consistency: consistencyParam,
    },
    response: { dataPath: "result.hits" },
  },
];

// --- writes -----------------------------------------------------------------------------------------------

const upsertPoints = {
    name: "upsert_points",
    title: "Upsert points",
    description: 'Insert or overwrite points by id: [{"id": 1 | "uuid", "vector": [...] | {"name": [...]}, "payload": {...}}]',
    method: "PUT",
    // Upserting the same points again writes the same data.
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    path: "/collections/{collection_name}/points",
    params: {
      collection_name: collectionParam,
      points: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 10000, description: "Points to upsert" },
      update_filter: { ...filterParam, description: "Only overwrite existing points matching this filter (new points are always inserted)" },
      shard_key: shardKeyParam,
      wait: waitParam,
    },
    response: { dataPath: "result" },
};

const pointWriteOperations = [
  upsertPoints,
  // Points whose vector is an inference document ({text, model}) are embedded server-side, billed per request.
  inferenceTwin(upsertPoints, "retrieve_points by id to see whether the points were written; your inference provider's usage page shows what was billed"),
  {
    name: "set_payload",
    title: "Set payload",
    description: "Merge payload fields into points chosen by ids or by a filter (other fields are kept)",
    method: "POST",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    path: "/collections/{collection_name}/points/payload",
    params: {
      collection_name: collectionParam,
      payload: { in: "body", type: "object", required: true, description: 'Fields to set, e.g. {"status": "reviewed"}' },
      points: pointIdsParam("Points to change"),
      filter: { ...filterParam, description: "Change every point matching this filter instead of ids" },
      key: { in: "body", type: "string", description: "Set the payload under this nested key, e.g. meta.review" },
      shard_key: shardKeyParam,
      wait: waitParam,
    },
    response: { dataPath: "result" },
  },
  {
    name: "delete_points",
    title: "Delete points",
    description: "Delete points by ids, or every point matching a filter",
    method: "POST",
    write: "idempotent",
    nodeOnly: true,
    path: "/collections/{collection_name}/points/delete",
    params: {
      collection_name: collectionParam,
      points: pointIdsParam("Points to delete"),
      filter: { ...filterParam, description: "Delete every point matching this filter instead of ids" },
      shard_key: shardKeyParam,
      wait: waitParam,
    },
    response: { dataPath: "result" },
  },
];

const restDefinition = defineRestPlugin({
  name: "qdrant",
  version: "0.1.0",
  description: "Qdrant vector database (Cloud or self-hosted): collections, query (vector, hybrid, recommend, groups), scroll, retrieve, count, facets; writes opt-in for agents, deletes node only",
  apiName: "Qdrant REST API",
  baseUrl: resolveQdrantBaseUrl,
  // QDRANT_API_KEY is optional (local servers run without one), so the header is only set when there is a key.
  auth: { type: "custom", env: QDRANT_API_KEY_ENV, authorize: authorizeWithOptionalKey },
  extraEnv: [QDRANT_URL_ENV, "QDRANT_TOOL_API_EXTRA_PATHS"],
  // Errors are {"status": {"error": "Not found: Collection `x` doesn't exist!"}, "time": 0.0001, "result": null}.
  errors: { messagePath: ["status.error", "message"] },
  apiRequest: { examplePath: "/collections/<collection_name>/optimizations" },
  operations: [...collectionOperations, ...pointReadOperations, ...pointWriteOperations],
});

const guardedDefinition = guardToolApiRequest(restDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "QDRANT_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read collection, alias and point metadata (no snapshots, telemetry or cluster internals); use a workflow node",
});

const routedDefinition = routeInferenceQueries(guardedDefinition, { query_points: "query_points_with_inference", query_points_groups: "query_points_groups_with_inference", upsert_points: "upsert_points_with_inference" });

export const pluginDefinition = { ...withNumericScrollCursor(routedDefinition, ["scroll_points"]), resolveAccessToken: resolveOptionalApiKey };
