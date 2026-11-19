/**
 * Builds Weaviate GraphQL `Get` and `Aggregate` documents from structured arguments, so agents never send GraphQL
 * text. Names (collection, properties, filter keys, enum values) must be GraphQL names; every value is emitted as a
 * literal (strings through JSON.stringify, which is valid GraphQL string syntax; numbers must be finite). Nothing a
 * caller passes can close a brace or add a field.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
// Weaviate collection names start with an uppercase letter.
const COLLECTION_NAME = /^[A-Z][_0-9A-Za-z]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTER_OPERATORS = new Set([
  "And", "Or", "Not", "Equal", "NotEqual", "GreaterThan", "GreaterThanEqual", "LessThan", "LessThanEqual",
  "Like", "WithinGeoRange", "IsNull", "ContainsAny", "ContainsAll", "ContainsNone",
]);
const FUSION_TYPES = new Set(["rankedFusion", "relativeScoreFusion"]);
const MAX_FILTER_DEPTH = 12;
const SEARCH_MODES = ["near_text", "near_vector", "near_object", "hybrid_query", "bm25_query"];
const VECTOR_ADDITIONAL = "id distance creationTimeUnix lastUpdateTimeUnix";
const KEYWORD_ADDITIONAL = "id score explainScore creationTimeUnix lastUpdateTimeUnix";
const PLAIN_ADDITIONAL = "id creationTimeUnix lastUpdateTimeUnix";

function invalid(message) {
  return new PluginError(message, { kind: "invalid_input" });
}

/**
 * Checks a collection name.
 *
 * @param collection - e.g. "Article" (string)
 * @returns The name (string)
 * @throws PluginError kind `invalid_input` - When it is not a Weaviate collection name
 */
export function checkCollectionName(collection) {
  if (typeof collection !== "string" || !COLLECTION_NAME.test(collection)) {
    throw invalid(`collection must be a Weaviate collection name (letters, digits, _; starting with an uppercase letter), got ${JSON.stringify(collection)}`);
  }
  return collection;
}

function checkName(name, label) {
  if (typeof name !== "string" || !GRAPHQL_NAME.test(name)) throw invalid(`${label} must be a property name (letters, digits, _), got ${JSON.stringify(name)}`);
  return name;
}

// Paging values are written into the document as bare numbers, so they must be integers, never text.
function checkNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw invalid(`${label} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return value;
}

function checkUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${label} must be a UUID, got ${JSON.stringify(value)}`);
  return value;
}

/**
 * Serializes a JSON value as a GraphQL input literal. Object keys must be GraphQL names; `operator` values must be
 * Weaviate filter operators and are emitted as enums.
 *
 * @param value - Filter or argument value (any JSON)
 * @param depth - Nesting depth, for the limit (number, internal)
 * @returns GraphQL literal (string)
 * @throws PluginError kind `invalid_input` - For other keys, operators, non-finite numbers, or too deep nesting
 *
 * @example
 * toGraphqlLiteral({ path: ["year"], operator: "GreaterThan", valueInt: 2000 }); // '{path: ["year"], operator: GreaterThan, valueInt: 2000}'
 */
export function toGraphqlLiteral(value, depth = 0) {
  if (depth > MAX_FILTER_DEPTH) throw invalid(`filter is nested deeper than ${MAX_FILTER_DEPTH} levels`);
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("filter numbers must be finite");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => toGraphqlLiteral(item, depth + 1)).join(", ")}]`;
  if (typeof value === "object") {
    const fields = Object.entries(value).map(([key, fieldValue]) => `${checkName(key, "filter key")}: ${serializeField(key, fieldValue, depth)}`);
    return `{${fields.join(", ")}}`;
  }
  throw invalid(`unsupported filter value ${JSON.stringify(value)}`);
}

function serializeField(key, fieldValue, depth) {
  if (key !== "operator") return toGraphqlLiteral(fieldValue, depth + 1);
  if (!FILTER_OPERATORS.has(fieldValue)) throw invalid(`filter operator must be one of ${[...FILTER_OPERATORS].join(", ")}, got ${JSON.stringify(fieldValue)}`);
  return fieldValue;
}

function pickSearchMode(args) {
  const modes = SEARCH_MODES.filter((mode) => args[mode] !== undefined);
  if (modes.length > 1) throw invalid(`use one search at a time: ${modes.join(", ")} were given`);
  return modes[0];
}

function buildSearchArgument(mode, args) {
  const distance = args.distance === undefined ? "" : `, distance: ${toGraphqlLiteral(args.distance)}`;
  const targets = args.target_vectors ? `, targetVectors: ${toGraphqlLiteral(args.target_vectors.map((name) => checkName(name, "target vector")))}` : "";
  const searchProperties = args.search_properties ? `, properties: ${toGraphqlLiteral(args.search_properties.map(checkSearchProperty))}` : "";
  const builders = {
    near_text: () => `nearText: {concepts: ${toGraphqlLiteral(args.near_text)}${distance}${targets}}`,
    near_vector: () => `nearVector: {vector: ${toGraphqlLiteral(args.near_vector)}${distance}${targets}}`,
    near_object: () => `nearObject: {id: ${toGraphqlLiteral(checkUuid(args.near_object, "near_object"))}${distance}${targets}}`,
    hybrid_query: () => `hybrid: {query: ${toGraphqlLiteral(args.hybrid_query)}${buildHybridOptions(args)}${searchProperties}${targets}}`,
    bm25_query: () => `bm25: {query: ${toGraphqlLiteral(args.bm25_query)}${searchProperties}}`,
  };
  return builders[mode]();
}

// bm25/hybrid properties may carry a boost: "title^2".
function checkSearchProperty(property) {
  const [name, boost] = String(property).split("^");
  checkName(name, "search property");
  if (boost !== undefined && !/^\d+(\.\d+)?$/.test(boost)) throw invalid(`search property boost must be a number, got ${JSON.stringify(property)}`);
  return property;
}

function buildHybridOptions(args) {
  const alpha = args.alpha === undefined ? "" : `, alpha: ${toGraphqlLiteral(args.alpha)}`;
  const vector = args.hybrid_vector ? `, vector: ${toGraphqlLiteral(args.hybrid_vector)}` : "";
  if (args.fusion_type !== undefined && !FUSION_TYPES.has(args.fusion_type)) throw invalid("fusion_type must be rankedFusion or relativeScoreFusion");
  const fusionType = args.fusion_type ? `, fusionType: ${args.fusion_type}` : "";
  return `${alpha}${vector}${fusionType}`;
}

function buildCommonArguments(args) {
  const parts = [];
  if (args.where !== undefined) parts.push(`where: ${toGraphqlLiteral(args.where)}`);
  if (args.tenant !== undefined) parts.push(`tenant: ${toGraphqlLiteral(args.tenant)}`);
  return parts;
}

/**
 * Builds a `Get` query: one search mode (or none), filter, paging and the fields to return.
 *
 * @param args - Validated search_objects arguments (object)
 * @returns `{query, mode}`: the GraphQL document and the search mode used (object)
 * @throws PluginError kind `invalid_input` - Bad names, several search modes, `after` combined with a search
 *
 * @example
 * buildGetQuery({ collection: "Article", properties: ["title"], near_text: ["graphs"], limit: 3 }).query;
 * // '{ Get { Article(nearText: {concepts: ["graphs"]}, limit: 3) { title _additional { id distance creationTimeUnix lastUpdateTimeUnix } } } }'
 */
export function buildGetQuery(args) {
  const collection = checkCollectionName(args.collection);
  const mode = pickSearchMode(args);
  if (mode && args.after !== undefined) throw invalid("after (cursor paging) only works without a search; use offset with searches");
  const parts = [...(mode ? [buildSearchArgument(mode, args)] : []), ...buildCommonArguments(args)];
  for (const field of ["limit", "offset", "autocut"]) {
    if (args[field] !== undefined) parts.push(`${field}: ${checkNonNegativeInteger(args[field], field)}`);
  }
  if (args.after !== undefined) parts.push(`after: ${toGraphqlLiteral(checkUuid(args.after, "after"))}`);
  const fields = (args.properties ?? []).map((property) => checkName(property, "property"));
  const additional = [mode === "hybrid_query" || mode === "bm25_query" ? KEYWORD_ADDITIONAL : mode ? VECTOR_ADDITIONAL : PLAIN_ADDITIONAL, args.include_vector ? "vector" : ""].filter(Boolean).join(" ");
  const argumentText = parts.length > 0 ? `(${parts.join(", ")})` : "";
  return { query: `{ Get { ${collection}${argumentText} { ${[...fields, `_additional { ${additional} }`].join(" ")} } } }`, mode };
}

/**
 * Builds an `Aggregate` query that counts objects, optionally filtered.
 *
 * @param args - Validated count_objects arguments: `{collection, where?, tenant?}` (object)
 * @returns GraphQL document (string)
 *
 * @example
 * buildCountQuery({ collection: "Article" }); // '{ Aggregate { Article { meta { count } } } }'
 */
export function buildCountQuery(args) {
  const collection = checkCollectionName(args.collection);
  const parts = buildCommonArguments(args);
  const argumentText = parts.length > 0 ? `(${parts.join(", ")})` : "";
  return `{ Aggregate { ${collection}${argumentText} { meta { count } } } }`;
}
