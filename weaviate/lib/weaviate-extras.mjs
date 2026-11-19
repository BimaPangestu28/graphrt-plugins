/**
 * Weaviate-specific pieces of the plugin:
 *   - resolveWeaviateUrl: WEAVIATE_URL (https, or http on localhost);
 *   - authorizeWeaviate: optional `Authorization: Bearer` (WEAVIATE_API_KEY or a node's access_token) plus model
 *     provider keys from WEAVIATE_PROVIDER_HEADERS (e.g. X-OpenAI-Api-Key), all redacted;
 *   - searchObjects / countObjects: hand-written operations that send GraphQL built by graphql-builder.mjs, because
 *     a declarative operation cannot turn structured arguments into a GraphQL document safely.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";
import { buildCountQuery, buildGetQuery } from "./graphql-builder.mjs";

export const URL_ENV = "WEAVIATE_URL";
export const API_KEY_ENV = "WEAVIATE_API_KEY";
export const PROVIDER_HEADERS_ENV = "WEAVIATE_PROVIDER_HEADERS";
const DEFAULT_WEAVIATE_URL = "http://localhost:8080";
const PROVIDER_HEADER_NAME = /^X-[A-Za-z0-9-]+$/;
const SEARCH_TIMEOUT_MS = 60000;

/**
 * Resolves the Weaviate URL from WEAVIATE_URL (default http://localhost:8080).
 *
 * @param environment - Environment variables (object)
 * @returns Base URL without a trailing slash (string)
 * @throws Error - When the URL is not http(s), or has credentials, a query or a fragment
 *
 * @example
 * resolveWeaviateUrl({ WEAVIATE_URL: "https://abc.c0.europe-west3.gcp.weaviate.cloud/" }); // "https://abc.c0.europe-west3.gcp.weaviate.cloud"
 */
export function resolveWeaviateUrl(environment) {
  const configuredUrl = environment[URL_ENV]?.trim() || DEFAULT_WEAVIATE_URL;
  const parsedUrl = new URL(configuredUrl.includes("://") ? configuredUrl : `https://${configuredUrl}`);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error(`${URL_ENV} must be an https:// URL (http:// only on localhost)`);
  if (parsedUrl.username || parsedUrl.password) throw new Error(`${URL_ENV} must not contain credentials; use ${API_KEY_ENV}`);
  if (parsedUrl.search || parsedUrl.hash) throw new Error(`${URL_ENV} must not have a query or fragment`);
  return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, "")}`;
}

/**
 * Reads WEAVIATE_PROVIDER_HEADERS: a JSON object of `X-...` header names to values.
 *
 * @param environment - Environment variables (object)
 * @returns Header entries (Array<[string, string]>)
 * @throws PluginError kind `invalid_input` - When it is not such an object
 *
 * @example
 * readProviderHeaders({ WEAVIATE_PROVIDER_HEADERS: '{"X-OpenAI-Api-Key": "sk-..."}' }); // [["x-openai-api-key", "sk-..."]]
 */
export function readProviderHeaders(environment) {
  const headersText = environment?.[PROVIDER_HEADERS_ENV]?.trim();
  if (!headersText) return [];
  let parsedHeaders;
  try {
    parsedHeaders = JSON.parse(headersText);
  } catch {
    throw new PluginError(`${PROVIDER_HEADERS_ENV} must be a JSON object, e.g. {"X-OpenAI-Api-Key": "..."}`, { kind: "invalid_input" });
  }
  if (!parsedHeaders || typeof parsedHeaders !== "object" || Array.isArray(parsedHeaders)) {
    throw new PluginError(`${PROVIDER_HEADERS_ENV} must be a JSON object of header names to values`, { kind: "invalid_input" });
  }
  return Object.entries(parsedHeaders).map(([headerName, headerValue]) => {
    const validValue = typeof headerValue === "string" && headerValue !== "" && !/[\r\n\0]/.test(headerValue);
    if (!PROVIDER_HEADER_NAME.test(headerName) || !validValue) {
      throw new PluginError(`${PROVIDER_HEADERS_ENV}: each entry must be an X-... header with a one-line string value (${headerName})`, { kind: "invalid_input" });
    }
    return [headerName.toLowerCase(), headerValue];
  });
}

/**
 * Custom auth hook: optional bearer API key and provider key headers.
 *
 * @param request - `{headers, credential, environment}` from the declarative layer (object)
 * @returns Secrets to redact (string[])
 */
export function authorizeWeaviate({ headers, credential, environment }) {
  const secrets = [];
  const apiKey = credential || environment?.[API_KEY_ENV]?.trim();
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    secrets.push(apiKey);
  }
  for (const [headerName, headerValue] of readProviderHeaders(environment)) {
    headers[headerName] = headerValue;
    secrets.push(headerValue);
  }
  return secrets;
}

const collectionParam = { type: "string", description: 'Collection (class) name, e.g. "Article"' };
const whereParam = {
  type: "object",
  description: 'Filter, e.g. {"path": ["year"], "operator": "GreaterThan", "valueInt": 2000} or {"operator": "And", "operands": [...]}',
};
const tenantParam = { type: "string", description: "Tenant (multi-tenant collections)" };
const numberArray = (description) => ({ type: "array", items: { type: "number" }, maxItems: 8192, description });

const searchParameters = {
  type: "object",
  properties: {
    collection: collectionParam,
    properties: { type: "array", items: { type: "string" }, maxItems: 100, description: 'Properties to return, e.g. ["title", "body"] (id and scores are always returned)' },
    near_text: { type: "array", items: { type: "string" }, maxItems: 20, description: "Semantic search by text concepts (the collection's vectorizer embeds them)" },
    near_vector: numberArray("Semantic search by a query vector"),
    near_object: { type: "string", description: "Find objects similar to the object with this UUID" },
    hybrid_query: { type: "string", description: "Hybrid search (keyword + vector) for this text" },
    bm25_query: { type: "string", description: "Keyword (BM25) search for this text" },
    search_properties: { type: "array", items: { type: "string" }, maxItems: 50, description: 'Properties bm25/hybrid search in, boost with ^, e.g. ["title^2", "body"]' },
    alpha: { type: "number", minimum: 0, maximum: 1, description: "Hybrid weight: 0 = keyword only, 1 = vector only (default 0.75)" },
    fusion_type: { type: "string", enum: ["rankedFusion", "relativeScoreFusion"], description: "Hybrid fusion (default relativeScoreFusion)" },
    hybrid_vector: numberArray("Hybrid: use this vector instead of embedding hybrid_query"),
    distance: { type: "number", minimum: 0, description: "Vector searches: maximum distance" },
    target_vectors: { type: "array", items: { type: "string" }, maxItems: 10, description: "Named vectors to search (collections with several vectors)" },
    where: whereParam,
    limit: { type: "integer", minimum: 1, maximum: 1000, default: 10, description: "Maximum objects" },
    offset: { type: "integer", minimum: 0, maximum: 10000, description: "Skip this many results" },
    autocut: { type: "integer", minimum: 1, maximum: 10, description: "Cut results after this many jumps in distance/score" },
    after: { type: "string", description: "Cursor paging without a search: UUID of the last object of the previous page" },
    include_vector: { type: "boolean", description: "Also return each object's vector" },
    tenant: tenantParam,
  },
  required: ["collection"],
};

const countParameters = {
  type: "object",
  properties: { collection: collectionParam, where: whereParam, tenant: tenantParam },
  required: ["collection"],
};

// near_text and hybrid without a vector make Weaviate call the collection's embedding provider, which may bill per
// request: those are never retried. Other searches are free reads and are retried like GETs.
function isFreeSearch(mode, args) {
  if (mode === "near_text") return false;
  if (mode === "hybrid_query") return Array.isArray(args.hybrid_vector);
  return true;
}

async function postGraphql(context, query, idempotent) {
  return context.client.request({
    method: "POST",
    path: "/v1/graphql",
    json: { query },
    signal: context.signal,
    redactResponse: true,
    idempotent,
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
}

function shapeForSource(context, data) {
  return context.source === "tool" ? truncateForTool(data, DEFAULT_TOOL_OUTPUT) : data;
}

/**
 * The `search_objects` operation: a GraphQL Get with one search mode, filters and paging.
 *
 * @returns Operation `{name, title, description, parameters, run}` (object)
 */
export function createSearchObjectsOperation() {
  return {
    name: "search_objects",
    title: "Search objects",
    description:
      "Search a collection: near_text, near_vector, near_object, hybrid_query or bm25_query (one at a time, or none to list), with a where filter; objects with _additional id, distance or score",
    parameters: searchParameters,
    run: async (context) => {
      const { query, mode } = buildGetQuery(context.args);
      const body = await postGraphql(context, query, isFreeSearch(mode, context.args));
      return { data: shapeForSource(context, body?.data?.Get?.[context.args.collection] ?? []), next_cursor: null };
    },
  };
}

/**
 * The `count_objects` operation: a GraphQL Aggregate meta count, optionally filtered.
 *
 * @returns Operation `{name, title, description, parameters, run}` (object)
 */
export function createCountObjectsOperation() {
  return {
    name: "count_objects",
    title: "Count objects",
    description: "Number of objects in a collection, optionally matching a where filter (count)",
    parameters: countParameters,
    run: async (context) => {
      const body = await postGraphql(context, buildCountQuery(context.args), true);
      const count = body?.data?.Aggregate?.[context.args.collection]?.[0]?.meta?.count ?? null;
      return { data: { count }, next_cursor: null };
    },
  };
}
