/**
 * chroma plugin definition: the Chroma HTTP API v2 (https://docs.trychroma.com/reference, OpenAPI at
 * https://api.trychroma.com/openapi.json) for a local or self-hosted server or Chroma Cloud. Collection and record
 * operations are scoped to the database named by CHROMA_TENANT / CHROMA_DATABASE. Built with the declarative REST
 * layer (docs/declarative-plugins.md).
 *
 * Collections are addressed by name for get/delete and by id (UUID, from get_collection) for record operations, as in
 * the server's routes.
 *
 * Agent policy: reads (collections, count, get, query, search) are tools; creating collections and adding, upserting
 * or updating records are tools only with CHROMA_TOOL_ALLOW_WRITES=1; deleting records and collections is node only;
 * api_request as a tool only reaches collection metadata of the configured database.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import {
  authorizeWithOptionalToken,
  CHROMA_AUTH_HEADER_ENV,
  CHROMA_DATABASE_ENV,
  CHROMA_TENANT_ENV,
  CHROMA_TOKEN_ENV,
  CHROMA_URL_ENV,
  resolveChromaDatabaseUrl,
  resolveChromaRootUrl,
  resolveOptionalToken,
} from "./lib/chroma-config.mjs";

const WRITE_OPT_IN = "optIn:CHROMA_TOOL_ALLOW_WRITES";
const INCLUDE_VALUES = ["documents", "embeddings", "metadatas", "distances", "uris"];
// GET paths (relative to the database URL) agent tools may reach through api_request.
const ID = "[^/]+";
const TOOL_API_PATHS = ["/", "/collections", "/collections_count", `/collections/${ID}`, `/collections/${ID}/(count|indexing_status)`, `/collections/by-id/${ID}`].map(
  (pattern) => new RegExp(`^${pattern}$`),
);

const collectionNameParam = { in: "path", type: "string", required: true, description: "Collection name" };
const collectionIdParam = { in: "path", type: "string", required: true, description: "Collection id (UUID, `id` from get_collection or list_collections)" };
const whereParam = { in: "body", type: "object", description: 'Metadata filter, e.g. {"source": "news"} or {"$and": [{"year": {"$gte": 2024}}, {"lang": {"$in": ["id", "en"]}}]}' };
const whereDocumentParam = { in: "body", type: "object", description: 'Document text filter, e.g. {"$contains": "banjir"} or {"$regex": "^Jakarta"}' };
const recordIdsParam = (description) => ({ in: "body", type: "array", items: { type: "string" }, maxItems: 10000, description });
const includeParam = (defaultFields) => ({
  in: "body",
  type: "array",
  items: { type: "string", enum: INCLUDE_VALUES },
  default: defaultFields,
  description: `Fields to return: ${INCLUDE_VALUES.join(", ")}`,
});
const embeddingsParam = { in: "body", type: "array", items: { type: "array" }, maxItems: 10000, description: "One embedding (array of numbers) per id, same dimension as the collection" };
const recordBodyParams = {
  documents: { in: "body", type: "array", maxItems: 10000, description: "One document text (or null) per id" },
  metadatas: { in: "body", type: "array", maxItems: 10000, description: "One metadata object (or null) per id" },
  uris: { in: "body", type: "array", maxItems: 10000, description: "One URI (or null) per id" },
};

// --- server -------------------------------------------------------------------------------------------

const serverOperations = [
  {
    name: "heartbeat",
    title: "Heartbeat",
    description: "Check the server is up ({\"nanosecond heartbeat\": ...})",
    baseUrl: resolveChromaRootUrl,
    path: "/api/v2/heartbeat",
  },
  {
    name: "get_identity",
    title: "Get identity",
    description: "Who the token belongs to: user id, tenant and the databases it can use",
    baseUrl: resolveChromaRootUrl,
    path: "/api/v2/auth/identity",
  },
];

// --- collections ------------------------------------------------------------------------------------------

const collectionOperations = [
  {
    name: "list_collections",
    title: "List collections",
    description: "Collections of the database with id, name, metadata and configuration",
    path: "/collections",
    response: { offsetPagination: { offsetParam: "offset", limitParam: "limit" }, maxLimit: 1000 },
  },
  {
    name: "count_collections",
    title: "Count collections",
    description: "Number of collections in the database",
    path: "/collections_count",
  },
  {
    name: "get_collection",
    title: "Get collection",
    description: "A collection by name: its id (needed by record operations), metadata, configuration and dimension",
    path: "/collections/{collection_name}",
    params: { collection_name: collectionNameParam },
  },
  {
    name: "create_collection",
    title: "Create collection",
    description: "Create a collection (or return the existing one with get_or_create)",
    method: "POST",
    // With get_or_create (the default) a repeat returns the same collection.
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    path: "/collections",
    params: {
      name: { in: "body", type: "string", required: true, minLength: 3, description: "Collection name (3-512 characters: letters, digits, . _ -)" },
      metadata: { in: "body", type: "object", description: "Collection metadata" },
      configuration: { in: "body", type: "object", description: 'Index configuration, e.g. {"hnsw": {"space": "cosine"}}' },
      get_or_create: { in: "body", type: "boolean", default: true, description: "Return the existing collection instead of failing" },
    },
  },
  {
    name: "delete_collection",
    title: "Delete collection",
    description: "Delete a collection by name, with all its records",
    method: "DELETE",
    write: "idempotent",
    nodeOnly: true,
    path: "/collections/{collection_name}",
    params: { collection_name: collectionNameParam },
  },
];

// --- records -------------------------------------------------------------------------------------------------

const recordReadOperations = [
  {
    name: "count_records",
    title: "Count records",
    description: "Number of records in a collection",
    path: "/collections/{collection_id}/count",
    params: { collection_id: collectionIdParam },
  },
  {
    name: "get_records",
    title: "Get records",
    description: "Records by ids and/or filters (columnar: ids, documents, metadatas, ... arrays of equal length)",
    method: "POST",
    write: "idempotent",
    path: "/collections/{collection_id}/get",
    params: {
      collection_id: collectionIdParam,
      ids: recordIdsParam("Record ids"),
      where: whereParam,
      where_document: whereDocumentParam,
      include: includeParam(["documents", "metadatas"]),
      record_limit: { in: "body", type: "integer", min: 1, max: 10000, wireName: "limit", description: "Maximum records" },
      record_offset: { in: "body", type: "integer", min: 0, wireName: "offset", description: "Skip this many records" },
    },
  },
  {
    name: "query_records",
    title: "Query records",
    description: "Nearest records to one or more query embeddings (one result list per query embedding, with distances)",
    method: "POST",
    write: "idempotent",
    path: "/collections/{collection_id}/query",
    params: {
      collection_id: collectionIdParam,
      query_embeddings: { in: "body", type: "array", items: { type: "array" }, required: true, maxItems: 100, description: "Query embeddings, e.g. [[0.1, 0.2, ...]]" },
      n_results: { in: "body", type: "integer", min: 1, max: 1000, default: 10, description: "Results per query" },
      where: whereParam,
      where_document: whereDocumentParam,
      ids: recordIdsParam("Only consider these record ids"),
      include: includeParam(["documents", "metadatas", "distances"]),
    },
  },
  {
    name: "search_records",
    title: "Search records",
    description: "Search API (Chroma Cloud and recent servers): searches with rank expressions (knn, rrf), filters, select and limit",
    method: "POST",
    write: "idempotent",
    path: "/collections/{collection_id}/search",
    params: {
      collection_id: collectionIdParam,
      searches: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 100, description: 'e.g. [{"rank": {"$knn": {"query": [0.1, ...]}}, "limit": {"limit": 5}, "select": {"keys": ["#document", "#score"]}}]' },
      read_level: { in: "body", type: "string", enum: ["index_and_wal", "index_only", "index_and_bounded_wal"], description: "Consistency vs speed (default index_and_wal)" },
    },
  },
];

const recordWriteOperations = [
  {
    name: "add_records",
    title: "Add records",
    description: "Add records with embeddings (ids that already exist are left unchanged)",
    method: "POST",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    path: "/collections/{collection_id}/add",
    params: { collection_id: collectionIdParam, ids: { ...recordIdsParam("Record ids"), required: true }, embeddings: { ...embeddingsParam, required: true }, ...recordBodyParams },
  },
  {
    name: "upsert_records",
    title: "Upsert records",
    description: "Insert or overwrite records by id",
    method: "POST",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    path: "/collections/{collection_id}/upsert",
    params: { collection_id: collectionIdParam, ids: { ...recordIdsParam("Record ids"), required: true }, embeddings: { ...embeddingsParam, required: true }, ...recordBodyParams },
  },
  {
    name: "update_records",
    title: "Update records",
    description: "Update embeddings, documents, metadata or URIs of existing records by id",
    method: "POST",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    path: "/collections/{collection_id}/update",
    params: { collection_id: collectionIdParam, ids: { ...recordIdsParam("Record ids"), required: true }, embeddings: embeddingsParam, ...recordBodyParams },
  },
  {
    name: "delete_records",
    title: "Delete records",
    description: "Delete records by ids and/or a metadata or document filter",
    method: "POST",
    write: "idempotent",
    nodeOnly: true,
    path: "/collections/{collection_id}/delete",
    params: { collection_id: collectionIdParam, ids: recordIdsParam("Record ids to delete"), where: whereParam, where_document: whereDocumentParam },
  },
];

const restDefinition = defineRestPlugin({
  name: "chroma",
  version: "0.1.0",
  description: "Chroma (HTTP API v2, local or Chroma Cloud): collections, get, query and search records; adds and upserts opt-in for agents, deletes node only",
  apiName: "Chroma API (database-scoped)",
  baseUrl: resolveChromaDatabaseUrl,
  // CHROMA_API_KEY is optional (a local server usually has no auth), so the header is only set when there is a token.
  auth: { type: "custom", env: CHROMA_TOKEN_ENV, authorize: authorizeWithOptionalToken },
  extraEnv: [CHROMA_URL_ENV, CHROMA_TENANT_ENV, CHROMA_DATABASE_ENV, CHROMA_AUTH_HEADER_ENV, "CHROMA_TOOL_API_EXTRA_PATHS"],
  // Errors are {"error": "NotFoundError", "message": "Collection [x] does not exist"}.
  errors: {
    messagePath: ["message", "error"],
    codePath: "error",
    kindByCode: { NotFoundError: "not_found", InvalidArgumentError: "invalid_input" },
  },
  apiRequest: { examplePath: "/collections/<collection_id>/indexing_status" },
  operations: [...serverOperations, ...collectionOperations, ...recordReadOperations, ...recordWriteOperations],
});

const guardedDefinition = guardToolApiRequest(restDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "CHROMA_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read collection metadata of the configured database; use a workflow node",
});

export const pluginDefinition = { ...guardedDefinition, resolveAccessToken: resolveOptionalToken };
