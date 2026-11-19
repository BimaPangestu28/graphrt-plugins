/**
 * pinecone plugin definition: Pinecone vector database API version 2026-07 (https://docs.pinecone.io/reference/api).
 * The control plane (indexes) is api.pinecone.io; every index has its own data-plane host for vectors, namespaces and
 * documents, taken from PINECONE_INDEX_HOST or a per-call `index_host`, and only accepted under .pinecone.io (or
 * Pinecone Local on localhost) because the API key is sent there. Built with the declarative REST layer
 * (docs/declarative-plugins.md).
 *
 * Agent policy: reads, queries and searches are tools; upserts and updates are tools only with
 * PINECONE_TOOL_ALLOW_WRITES=1; deleting vectors, documents, namespaces and indexes is node only; api_request as a tool
 * only reaches index, collection and backup metadata on the control plane.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { addIndexHostArgument, INDEX_HOST_ENV, resolveIndexHostUrl } from "./lib/index-host.mjs";
import { rewordSearchOutcome } from "./lib/search-outcome.mjs";

const API_VERSION = "2026-07";
const WRITE_OPT_IN = "optIn:PINECONE_TOOL_ALLOW_WRITES";
const indexHostBaseUrl = (environment) => resolveIndexHostUrl(environment[INDEX_HOST_ENV]);
// GET paths agent tools may reach through api_request (normalized: lowercase, decoded, dot segments resolved).
const ID = "[^/]+";
const TOOL_API_PATHS = ["/indexes", `/indexes/${ID}`, `/indexes/${ID}/backups`, "/collections", `/collections/${ID}`, "/backups", `/backups/${ID}`, "/restore-jobs", `/restore-jobs/${ID}`].map(
  (pattern) => new RegExp(`^${pattern}$`),
);

const namespaceParam = { in: "body", type: "string", description: 'Namespace (default: the "" default namespace)' };
const namespacePathParam = { in: "path", type: "string", required: true, description: "Namespace name" };
const filterParam = { in: "body", type: "object", description: 'Metadata filter, e.g. {"genre": {"$eq": "drama"}, "year": {"$gte": 2020}}' };
const vectorIdsParam = (description) => ({ in: "body", type: "array", items: { type: "string" }, maxItems: 1000, description });
const sparseVectorParam = { in: "body", type: "object", description: "Sparse vector {indices: [int], values: [number]}" };
const nextTokenPages = (cursorParam, maxLimit) => ({ cursorPath: "pagination.next", cursorParam, limitParam: "limit", maxLimit });

// --- control plane: indexes -----------------------------------------------------------------------

const indexOperations = [
  {
    name: "list_indexes",
    title: "List indexes",
    description: "Indexes in the project with their host (use it as index_host), dimension or schema, status and deployment",
    path: "/indexes",
    response: { dataPath: "indexes" },
  },
  {
    name: "describe_index",
    title: "Describe index",
    description: "One index: host (for index_host), status, schema/dimension and metric, deployment, deletion protection",
    path: "/indexes/{index_name}",
    params: { index_name: { in: "path", type: "string", required: true, description: "Index name" } },
  },
  {
    name: "delete_index",
    title: "Delete index",
    description: "Delete an index and all its data (refused while deletion protection is enabled)",
    method: "DELETE",
    path: "/indexes/{index_name}",
    write: "idempotent",
    nodeOnly: true,
    params: { index_name: { in: "path", type: "string", required: true, description: "Index name" } },
  },
];

// --- data plane: stats, namespaces, vectors ------------------------------------------------------------

const namespaceOperations = [
  {
    name: "describe_index_stats",
    title: "Describe index stats",
    description: "Vector count per namespace, dimension and fullness of the index",
    method: "POST",
    write: "idempotent",
    baseUrl: indexHostBaseUrl,
    path: "/describe_index_stats",
    params: { filter: { ...filterParam, description: "Only count vectors matching this metadata filter (pod-based indexes only)" } },
  },
  {
    name: "list_namespaces",
    title: "List namespaces",
    description: "Namespaces of the index with their record counts",
    baseUrl: indexHostBaseUrl,
    path: "/namespaces",
    params: { prefix: { in: "query", type: "string", description: "Only namespaces starting with this prefix" } },
    response: { dataPath: "namespaces", ...nextTokenPages("paginationToken", 100) },
  },
  {
    name: "delete_namespace",
    title: "Delete namespace",
    description: "Delete a namespace and every record in it",
    method: "DELETE",
    write: "idempotent",
    nodeOnly: true,
    baseUrl: indexHostBaseUrl,
    path: "/namespaces/{namespace}",
    params: { namespace: namespacePathParam },
  },
];

const vectorReadOperations = [
  {
    name: "query_vectors",
    title: "Query vectors",
    description: "Nearest neighbours of a query vector (or of a stored vector by vector_id), with scores and optional metadata",
    method: "POST",
    write: "idempotent",
    baseUrl: indexHostBaseUrl,
    path: "/query",
    params: {
      top_k: { in: "body", type: "integer", required: true, min: 1, max: 10000, wireName: "topK", description: "Number of matches" },
      vector: { in: "body", type: "array", items: { type: "number" }, maxItems: 20000, description: "Query vector (same dimension as the index); or use vector_id" },
      vector_id: { in: "body", type: "string", wireName: "id", description: "Use this stored vector as the query instead of `vector`" },
      sparse_vector: { ...sparseVectorParam, wireName: "sparseVector" },
      namespace: namespaceParam,
      filter: filterParam,
      include_metadata: { in: "body", type: "boolean", default: true, wireName: "includeMetadata" },
      include_values: { in: "body", type: "boolean", default: false, wireName: "includeValues" },
    },
  },
  {
    name: "fetch_vectors",
    title: "Fetch vectors",
    description: "Vectors by id with values and metadata (`vectors` is a map from id to vector)",
    baseUrl: indexHostBaseUrl,
    path: "/vectors/fetch",
    params: {
      ids: { in: "query", type: "array", items: { type: "string" }, required: true, maxItems: 1000, style: "repeat", description: "Vector ids" },
      namespace: { in: "query", type: "string", description: "Namespace (default namespace when omitted)" },
    },
  },
  {
    name: "fetch_vectors_by_metadata",
    title: "Fetch vectors by metadata",
    description: "Vectors whose metadata matches a filter, page by page (`vectors` is a map from id to vector)",
    method: "POST",
    write: "idempotent",
    baseUrl: indexHostBaseUrl,
    path: "/vectors/fetch_by_metadata",
    params: { filter: { ...filterParam, required: true }, namespace: namespaceParam },
    response: nextTokenPages("paginationToken", 10000),
  },
  {
    name: "list_vector_ids",
    title: "List vector ids",
    description: "Vector ids in a namespace (serverless indexes), optionally by id prefix, page by page",
    baseUrl: indexHostBaseUrl,
    path: "/vectors/list",
    params: {
      prefix: { in: "query", type: "string", description: 'Only ids starting with this, e.g. "doc1#"' },
      namespace: { in: "query", type: "string", description: "Namespace (default namespace when omitted)" },
    },
    response: { dataPath: "vectors", ...nextTokenPages("paginationToken", 100) },
  },
];

const vectorWriteOperations = [
  {
    name: "upsert_vectors",
    title: "Upsert vectors",
    description: "Insert or overwrite up to 1000 vectors by id ({id, values, sparseValues?, metadata?})",
    method: "POST",
    // Repeating an upsert of the same vectors writes the same data again.
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    baseUrl: indexHostBaseUrl,
    path: "/vectors/upsert",
    params: {
      vectors: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 1000, description: 'e.g. [{"id": "a", "values": [0.1, 0.2], "metadata": {"genre": "drama"}}]' },
      namespace: namespaceParam,
    },
  },
  {
    name: "update_vectors",
    title: "Update vectors",
    description: "Update one vector by vector_id (values, sparse values, merge metadata), or set metadata on every vector matching a filter",
    method: "POST",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    baseUrl: indexHostBaseUrl,
    path: "/vectors/update",
    params: {
      vector_id: { in: "body", type: "string", wireName: "id", description: "Vector to update (or use filter)" },
      values: { in: "body", type: "array", items: { type: "number" }, maxItems: 20000, description: "New dense values (with vector_id only)" },
      sparse_values: { ...sparseVectorParam, wireName: "sparseValues" },
      set_metadata: { in: "body", type: "object", wireName: "setMetadata", description: "Metadata fields to set (merged into existing metadata)" },
      filter: { ...filterParam, description: "Update every vector matching this filter instead of one id (set_metadata only)" },
      dry_run: { in: "body", type: "boolean", wireName: "dryRun", description: "With filter: only return how many vectors would change" },
      namespace: namespaceParam,
    },
  },
  {
    name: "delete_vectors",
    title: "Delete vectors",
    description: "Delete vectors by ids, by metadata filter, or all vectors of a namespace (delete_all)",
    method: "POST",
    write: "idempotent",
    nodeOnly: true,
    baseUrl: indexHostBaseUrl,
    path: "/vectors/delete",
    params: {
      ids: vectorIdsParam("Vector ids to delete"),
      filter: { ...filterParam, description: "Delete every vector matching this filter" },
      delete_all: { in: "body", type: "boolean", wireName: "deleteAll", description: "Delete every vector in the namespace" },
      namespace: namespaceParam,
    },
  },
];

// --- data plane: documents (document indexes) and legacy integrated records ---------------------------------

const documentOperations = [
  {
    name: "search_documents",
    title: "Search documents",
    description: "Search a document index: score_by clauses (dense_vector, sparse_vector, text, query_string, embed, sparse_embed), top_k matches with _score and fields",
    method: "POST",
    // embed/sparse_embed clauses are billed embedding calls on every request, retries included: never retried.
    write: "unsafe",
    checkHint: "nothing to undo (a search changes no data); the usage dashboard shows the embedding tokens billed",
    baseUrl: indexHostBaseUrl,
    path: "/namespaces/{namespace}/documents/search",
    params: {
      namespace: namespacePathParam,
      score_by: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 100, description: 'e.g. [{"type": "embed", "fields": ["content"], "query": "what is ML?"}] or [{"type": "dense_vector", "field": "embedding", "values": [...]}]' },
      top_k: { in: "body", type: "integer", required: true, min: 1, max: 10000 },
      include_fields: { in: "body", type: "array", items: { type: "string" }, description: 'Fields to return (["*"] for all; none by default)' },
      filter: filterParam,
    },
  },
  {
    name: "fetch_documents",
    title: "Fetch documents",
    description: "Documents by ids, or by metadata filter page by page (`documents` is a map from _id to document)",
    method: "POST",
    write: "idempotent",
    baseUrl: indexHostBaseUrl,
    path: "/namespaces/{namespace}/documents/fetch",
    params: {
      namespace: namespacePathParam,
      ids: vectorIdsParam("Document ids (or use filter)"),
      filter: { ...filterParam, description: "Fetch documents matching this filter instead of ids" },
      include_fields: { in: "body", type: "array", items: { type: "string" }, description: "Fields to return (all by default)" },
    },
    response: nextTokenPages("pagination_token", 10000),
  },
  {
    name: "list_documents",
    title: "List documents",
    description: "Document ids in a namespace, optionally by id prefix, page by page",
    method: "POST",
    write: "idempotent",
    baseUrl: indexHostBaseUrl,
    path: "/namespaces/{namespace}/documents/list",
    params: { namespace: namespacePathParam, prefix: { in: "body", type: "string", description: "Only ids starting with this" } },
    response: { dataPath: "documents", ...nextTokenPages("pagination_token", 100) },
  },
  {
    name: "upsert_documents",
    title: "Upsert documents",
    description: "Insert or overwrite documents by _id (at most 96 per call when the index embeds text; embedding is billed per call)",
    method: "POST",
    // Embedding is metered on every request, retries included, so a timed-out call is never retried automatically.
    write: "unsafe",
    checkHint: "fetch_documents with the _ids, and the usage dashboard for embedding tokens",
    toolPolicy: WRITE_OPT_IN,
    baseUrl: indexHostBaseUrl,
    path: "/namespaces/{namespace}/documents/upsert",
    params: {
      namespace: namespacePathParam,
      documents: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 1000, description: 'e.g. [{"_id": "doc-1", "content": "text to embed", "category": "news"}]' },
    },
  },
  {
    name: "update_documents",
    title: "Update documents",
    description: "Patch documents by _id (documents), or set/remove metadata fields on every document matching a filter",
    method: "POST",
    write: "unsafe",
    checkHint: "fetch_documents with the _ids or the filter",
    toolPolicy: WRITE_OPT_IN,
    baseUrl: indexHostBaseUrl,
    path: "/namespaces/{namespace}/documents/update",
    params: {
      namespace: namespacePathParam,
      documents: { in: "body", type: "array", items: { type: "object" }, maxItems: 1000, description: 'Partial documents, e.g. [{"_id": "doc-1", "category": "archive"}]' },
      filter: { ...filterParam, description: "Patch every document matching this filter (with set_fields / remove_fields)" },
      set_fields: { in: "body", type: "object", description: "Metadata fields to set on filtered documents" },
      remove_fields: { in: "body", type: "array", items: { type: "string" }, description: "Metadata fields to remove from filtered documents" },
    },
  },
  {
    name: "delete_documents",
    title: "Delete documents",
    description: "Delete documents by ids, by metadata filter, or all documents of a namespace (delete_all)",
    method: "POST",
    write: "idempotent",
    nodeOnly: true,
    baseUrl: indexHostBaseUrl,
    path: "/namespaces/{namespace}/documents/delete",
    params: {
      namespace: namespacePathParam,
      ids: vectorIdsParam("Document ids to delete"),
      filter: { ...filterParam, description: "Delete every document matching this filter" },
      delete_all: { in: "body", type: "boolean", description: "Delete every document in the namespace" },
    },
  },
  {
    name: "search_records",
    title: "Search records (integrated index)",
    description: "Text search on a legacy integrated-embedding index: Pinecone embeds query_text, optional reranking; result.hits with _id, _score, fields",
    method: "POST",
    // query_text embedding and rerank are billed on every request, retries included: never retried.
    write: "unsafe",
    checkHint: "nothing to undo (a search changes no data); the usage dashboard shows the embedding and rerank units billed",
    baseUrl: indexHostBaseUrl,
    path: "/records/namespaces/{namespace}/search",
    params: {
      namespace: namespacePathParam,
      query_text: { in: "body", type: "string", minLength: 1, wireName: "query.inputs.text", description: "Text to search for (or use query_vector / query_record_id)" },
      query_vector: { in: "body", type: "array", items: { type: "number" }, wireName: "query.vector.values", description: "Dense query vector instead of text" },
      query_record_id: { in: "body", type: "string", wireName: "query.id", description: "Use this stored record as the query" },
      top_k: { in: "body", type: "integer", required: true, min: 1, max: 10000, wireName: "query.top_k" },
      filter: { ...filterParam, wireName: "query.filter" },
      fields: { in: "body", type: "array", items: { type: "string" }, description: "Fields to return on each hit" },
      rerank: { in: "body", type: "object", description: 'e.g. {"model": "bge-reranker-v2-m3", "rank_fields": ["chunk_text"], "top_n": 5}' },
    },
  },
];

const DATA_PLANE_OPERATIONS = [...namespaceOperations, ...vectorReadOperations, ...vectorWriteOperations, ...documentOperations];

const restDefinition = defineRestPlugin({
  name: "pinecone",
  version: "0.1.0",
  description: "Pinecone vector database (API 2026-07): indexes, stats, namespaces, query/fetch/list vectors, document search; upserts opt-in for agents, deletes node only",
  apiName: "Pinecone control plane API",
  baseUrl: "https://api.pinecone.io",
  auth: { type: "header", header: "Api-Key", env: "PINECONE_API_KEY" },
  defaultHeaders: { "x-pinecone-api-version": API_VERSION },
  extraEnv: [INDEX_HOST_ENV, "PINECONE_TOOL_API_EXTRA_PATHS"],
  // Control plane: {"status": 404, "error": {"code": "NOT_FOUND", "message": "..."}}; data plane: {"code": 5, "message": "..."};
  // 401 is text/plain.
  errors: {
    messagePath: ["error.message", "message"],
    codePath: "error.code",
    kindByCode: {
      UNAUTHENTICATED: "auth_error",
      PERMISSION_DENIED: "permission_denied",
      FORBIDDEN: "permission_denied",
      NOT_FOUND: "not_found",
      INVALID_ARGUMENT: "invalid_input",
      RESOURCE_EXHAUSTED: "rate_limited",
    },
  },
  apiRequest: { examplePath: "/indexes/<index_name>/backups" },
  operations: [...indexOperations, ...DATA_PLANE_OPERATIONS],
});

const guardedDefinition = guardToolApiRequest(restDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "PINECONE_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read index, collection and backup metadata; use a workflow node",
});

const hostedDefinition = addIndexHostArgument(
  guardedDefinition,
  DATA_PLANE_OPERATIONS.map((operation) => operation.name),
);

// Billed searches are never retried; their unknown-outcome note speaks of billing, not of a write (lib/search-outcome.mjs).
export const pluginDefinition = rewordSearchOutcome(hostedDefinition, ["search_documents", "search_records"]);
