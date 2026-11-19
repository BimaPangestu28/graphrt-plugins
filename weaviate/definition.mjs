/**
 * weaviate plugin definition: vector, hybrid and keyword search through Weaviate's GraphQL API, objects and schema
 * through the REST API v1 (https://docs.weaviate.io/weaviate/api/rest). Self-hosted Weaviate or Weaviate Cloud.
 * Built with the declarative REST layer (docs/declarative-plugins.md) plus two hand-written GraphQL operations.
 *
 * The server is WEAVIATE_URL (default http://localhost:8080; plain http only on localhost); WEAVIATE_API_KEY is sent
 * as a bearer token when set. Embedding/LLM provider keys for vectorizer modules go in WEAVIATE_PROVIDER_HEADERS.
 *
 * Agent policy: searches, counts, objects and schema reads are tools. search_objects and count_objects build the
 * GraphQL document from validated arguments (lib/graphql-builder.mjs), so agents never send GraphQL text; raw GraphQL
 * (which can run paid generative search) needs WEAVIATE_TOOL_ALLOW_RAW_GRAPHQL=1. Object creates, patches and batch
 * imports need WEAVIATE_TOOL_ALLOW_WRITES=1; deletes are node only. api_request as a tool only reaches an allowlist of
 * read paths (no RBAC, users, backups).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { API_KEY_ENV, authorizeWeaviate, createCountObjectsOperation, createSearchObjectsOperation, PROVIDER_HEADERS_ENV, resolveWeaviateUrl, URL_ENV } from "./lib/weaviate-extras.mjs";

const WRITE_OPT_IN = "optIn:WEAVIATE_TOOL_ALLOW_WRITES";
const collectionPathParam = { in: "path", type: "string", required: true, minLength: 1, description: 'Collection (class) name, e.g. "Article"' };
const objectIdParam = { in: "path", type: "string", required: true, minLength: 1, description: "Object UUID" };
const tenantQuery = { in: "query", type: "string", description: "Tenant (multi-tenant collections)" };
const consistencyLevel = { in: "query", type: "string", enum: ["ONE", "QUORUM", "ALL"], wireName: "consistency_level", description: "Replica acknowledgement (replicated collections)" };
const includeParam = { in: "query", type: "string", enum: ["vector", "classification"], description: "Also return the vector or classification info" };
const propertiesBody = { in: "body", type: "object", description: 'Property values, e.g. {"title": "Hello", "year": 2024}' };
const vectorBody = { in: "body", type: "array", items: { type: "number" }, maxItems: 8192, description: "Your own vector (collections without a vectorizer)" };
const vectorsBody = { in: "body", type: "object", description: 'Named vectors, e.g. {"title_vector": [0.1, ...]}' };
const tenantBody = { in: "body", type: "string", description: "Tenant (multi-tenant collections)" };

const schemaOperations = [
  { name: "get_meta", title: "Server meta", description: "Weaviate version, hostname and enabled modules", path: "/v1/meta" },
  {
    name: "list_collections",
    title: "List collections",
    description: "Collections (classes) with their properties, vectorizer and index settings",
    path: "/v1/schema",
    response: { dataPath: "classes" },
  },
  {
    name: "get_collection",
    title: "Get collection",
    description: "One collection's schema: properties and data types, vectorizer, module and index config",
    path: "/v1/schema/{collection}",
    params: { collection: collectionPathParam },
  },
  {
    name: "get_nodes_status",
    title: "Nodes status",
    description: "Cluster nodes with status, version and (verbose) shard and object counts per collection",
    path: "/v1/nodes",
    params: { output: { in: "query", type: "string", enum: ["minimal", "verbose"], default: "verbose", description: "minimal or verbose (shard and object counts)" } },
  },
];

const objectReadOperations = [
  {
    name: "list_objects",
    title: "List objects",
    description: "Objects of a collection in UUID order, page by page (next_cursor is the last object's id)",
    path: "/v1/objects",
    params: {
      collection: { in: "query", type: "string", required: true, minLength: 1, wireName: "class", description: 'Collection (class) name, e.g. "Article"' },
      include: includeParam,
      tenant: tenantQuery,
    },
    response: { dataPath: "objects", lastItemCursor: { itemIdPath: "id", param: "after" }, limitParam: "limit", maxLimit: 1000, defaultLimit: 25 },
  },
  {
    name: "get_object",
    title: "Get object",
    description: "One object by collection and UUID with its properties (and vector with include: vector)",
    path: "/v1/objects/{collection}/{object_id}",
    params: { collection: collectionPathParam, object_id: objectIdParam, include: includeParam, tenant: tenantQuery, consistency_level: consistencyLevel },
  },
];

const objectWriteOperations = [
  {
    name: "create_object",
    title: "Create object",
    description: "Add an object (vectorized by the collection's vectorizer unless you pass vector); fails when the id exists",
    method: "POST",
    path: "/v1/objects",
    write: "unsafe",
    checkHint: "get_object with the id, or search for the object, before adding it again",
    toolPolicy: WRITE_OPT_IN,
    params: {
      collection: { in: "body", type: "string", required: true, minLength: 1, wireName: "class", description: 'Collection (class) name, e.g. "Article"' },
      properties: propertiesBody,
      object_uuid: { in: "body", type: "string", wireName: "id", description: "UUID for the object (generated when omitted; set it to make retries safe)" },
      vector: vectorBody,
      vectors: vectorsBody,
      tenant: tenantBody,
      consistency_level: consistencyLevel,
    },
  },
  {
    name: "update_object",
    title: "Update object",
    description: "Merge property values into an object (JSON merge patch); the object is re-vectorized when needed",
    method: "PATCH",
    path: "/v1/objects/{collection}/{object_id}",
    // A changed object is re-vectorized by the collection's vectorizer, which may bill the model provider, so a
    // timeout is not retried.
    write: "unsafe",
    checkHint: "get_object and compare its properties",
    toolPolicy: WRITE_OPT_IN,
    params: { collection: collectionPathParam, object_id: objectIdParam, properties: propertiesBody, vector: vectorBody, vectors: vectorsBody, tenant: tenantBody, consistency_level: consistencyLevel },
  },
  {
    name: "batch_objects",
    title: "Batch import objects",
    description: "Add or replace many objects in one request (objects with an existing id are replaced); check each result's errors",
    method: "POST",
    path: "/v1/batch/objects",
    write: "unsafe",
    checkHint: "count_objects or get_object for some of the ids",
    toolPolicy: WRITE_OPT_IN,
    timeoutMs: 110000,
    params: {
      objects: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 1000, description: 'Objects, e.g. [{"class": "Article", "id": "<uuid>", "properties": {...}}]' },
      consistency_level: consistencyLevel,
    },
  },
  {
    name: "delete_object",
    title: "Delete object",
    description: "Delete one object by collection and UUID",
    method: "DELETE",
    path: "/v1/objects/{collection}/{object_id}",
    write: "idempotent",
    nodeOnly: true,
    params: { collection: collectionPathParam, object_id: objectIdParam, tenant: tenantQuery, consistency_level: consistencyLevel },
  },
  {
    name: "graphql_query",
    title: "GraphQL query",
    description: "Run a raw GraphQL query (Get, Aggregate, Explore; generative search and vectorizers may bill your model provider)",
    method: "POST",
    path: "/v1/graphql",
    write: "unsafe",
    checkHint: "the model provider's usage page, if the query used generative search or a vectorizer",
    toolPolicy: "optIn:WEAVIATE_TOOL_ALLOW_RAW_GRAPHQL",
    timeoutMs: 110000,
    params: {
      query: { in: "body", type: "string", required: true, minLength: 1, description: 'GraphQL document, e.g. "{ Get { Article(limit: 2) { title } } }"' },
      variables: { in: "body", type: "object", description: "GraphQL variables" },
    },
  },
];

const restDefinition = defineRestPlugin({
  name: "weaviate",
  version: "0.1.0",
  description:
    "Weaviate: near-text, vector, hybrid and BM25 search with filters, counts, objects and schema; agent writes need an opt-in, deletes are node only",
  apiName: "Weaviate REST API",
  baseUrl: resolveWeaviateUrl,
  auth: { type: "custom", authorize: authorizeWeaviate },
  extraEnv: [URL_ENV, API_KEY_ENV, PROVIDER_HEADERS_ENV],
  limits: { timeout_ms: 120000 },
  // REST errors are {"error": [{"message": "..."}]}; GraphQL answers 200 with {"errors": [{"message": "..."}], "data": ...}.
  errors: { messagePath: ["error.0.message", "errors.0.message", "message"], errorPath: "errors.0" },
  apiRequest: { examplePath: "/v1/schema/<collection>/shards" },
  operations: [...schemaOperations, ...objectReadOperations, ...objectWriteOperations],
});

// GET paths agent tools may reach through api_request (normalized: lowercase, decoded, dot segments resolved). RBAC
// (/v1/authz), users (database user API keys), backups, replication and cluster internals are not on it.
const NAME = "[^/]+";
const TOOL_API_PATHS = [
  "/v1/meta",
  "/v1/schema",
  `/v1/schema/${NAME}`,
  `/v1/schema/${NAME}/(shards|tenants)`,
  `/v1/schema/${NAME}/tenants/${NAME}`,
  "/v1/nodes",
  `/v1/nodes/${NAME}`,
  "/v1/objects",
  `/v1/objects/${NAME}`,
  `/v1/objects/${NAME}/${NAME}`,
  "/v1/aliases",
  `/v1/aliases/${NAME}`,
  `/v1/classifications/${NAME}`,
  "/v1/[.]well-known/(ready|live)",
].map((pattern) => new RegExp(`^${pattern}$`));
const TOOL_API_BLOCKED_PATHS = [/(^|\/)(authz|users|backups|replication|cluster)(\/|$)/];

const guardedDefinition = guardToolApiRequest(restDefinition, {
  allowedPaths: TOOL_API_PATHS,
  blockedPaths: TOOL_API_BLOCKED_PATHS,
  reason: "agent tools may only read meta, schema, nodes, objects, aliases and classifications; use a workflow node",
});

export const pluginDefinition = {
  ...guardedDefinition,
  operations: [...guardedDefinition.operations.slice(0, 4), createSearchObjectsOperation(), createCountObjectsOperation(), ...guardedDefinition.operations.slice(4)],
};
