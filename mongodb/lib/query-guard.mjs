/**
 * Limits on what callers may send to MongoDB.
 *
 * - Everyone (nodes too): no `$_…` keys. They are MongoDB internals, and some
 *   (`$_internalJsEmit`, `$_internalJsReduce`) run JavaScript.
 * - Agent tool calls: only the stages and operators in operator-allowlist.mjs;
 *   no `$out` (it replaces a whole collection); `$merge` only with writes
 *   enabled; reads and writes only in allowed databases (never `admin`,
 *   `local`, `config`) and never in `system.*` collections, including through
 *   `$lookup`, `$graphLookup`, `$unionWith` and `$merge` targets.
 *
 * Workflow nodes are written by the workflow author and are not limited
 * beyond the `$_` rule.
 */
import { invalidInput, permissionDenied } from "./errors.mjs";
import { JAVASCRIPT_OPERATORS, TOOL_OPERATORS, TOOL_STAGES } from "./operator-allowlist.mjs";

export const PROTECTED_DATABASES = Object.freeze(["admin", "local", "config"]);
const WRITE_STAGES = Object.freeze(["$out", "$merge"]);
// Stage fields that name another collection.
const FOREIGN_COLLECTION_FIELDS = new Map([
  ["$lookup", "from"],
  ["$graphLookup", "from"],
  ["$unionWith", "coll"],
]);
const INVALID_DATABASE_CHARACTERS = /[/\\. "$*<>:|?\u0000]/;
const TRIVIAL_FILTER_KEYS = new Set(["$comment"]);

/**
 * Finds the first object key matching `isMatch` anywhere inside a value.
 *
 * @param value - Decoded JSON (unknown)
 * @param isMatch - `(key) => boolean`, or a list of keys (function | string[])
 * @returns Dotted path of the first match, or null (string | null)
 *
 * @example
 * findKey({ $and: [{ $where: "1" }] }, ["$where"]); // "$and.0.$where"
 */
export function findKey(value, isMatch, path = "") {
  const matches = typeof isMatch === "function" ? isMatch : (key) => isMatch.includes(key);
  if (value === null || typeof value !== "object") return null;
  for (const [childKey, childValue] of Object.entries(value)) {
    const childPath = path ? `${path}.${childKey}` : childKey;
    if (matches(childKey)) return childPath;
    const nestedMatch = findKey(childValue, matches, childPath);
    if (nestedMatch) return nestedMatch;
  }
  return null;
}

/**
 * Refuses MongoDB-internal `$_…` operators and stages, for every caller.
 *
 * @param value - Decoded JSON argument (unknown)
 * @param label - Argument name for messages (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertNoInternalOperators(value, label) {
  const match = findKey(value, (key) => key.startsWith("$_"));
  if (match) throw permissionDenied(`\`${label}\` uses ${lastSegment(match)}, a MongoDB internal operator, which the plugin never sends`);
}

/**
 * Refuses any `$` key that is not on the tool allowlist (server-side JavaScript included).
 *
 * @param value - Decoded JSON argument (unknown)
 * @param label - Argument name for messages (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolOperatorsAllowed(value, label) {
  assertNoInternalOperators(value, label);
  const match = findKey(value, (key) => key.startsWith("$") && !TOOL_OPERATORS.has(key));
  if (!match) return;
  const operator = lastSegment(match);
  if (JAVASCRIPT_OPERATORS.has(operator)) {
    throw permissionDenied(`\`${label}\` uses ${operator} (server-side JavaScript), which agent tool calls may not run; use a workflow node`);
  }
  throw permissionDenied(`\`${label}\` uses ${operator}, which is not on the operator allowlist for agent tool calls; use a workflow node`);
}

/**
 * Checks a pipeline from a tool call: allowlisted stages and operators, no `$out`, `$merge` only with
 * writes enabled, and every foreign or target namespace in an allowed database and not `system.*`.
 *
 * @param pipeline - Aggregation stages (object[])
 * @param options - `{writesAllowed, isDatabaseAllowed(name)}` (object)
 * @throws PluginError kind `permission_denied` - When a stage is not allowed
 */
export function assertToolPipelineAllowed(pipeline, { writesAllowed, isDatabaseAllowed }) {
  assertNoInternalOperators(pipeline, "pipeline");
  pipeline.forEach((stage, index) => assertToolStageAllowed(stage, index, writesAllowed));
  for (const { databaseName, collectionName } of listNamespaceReferences(pipeline)) {
    if (typeof collectionName === "string" && collectionName.startsWith("system.")) {
      throw permissionDenied(`Agent tool calls may not use \`${collectionName}\``);
    }
    if (databaseName !== undefined && !(typeof databaseName === "string" && isDatabaseAllowed(databaseName))) {
      throw permissionDenied(`Agent tool calls may not use the database \`${databaseName}\`; ${databaseHint(databaseName)}`);
    }
  }
}

function assertToolStageAllowed(stage, index, writesAllowed) {
  const stageNames = Object.keys(stage ?? {});
  if (stageNames.length !== 1) throw invalidInput(`\`pipeline[${index}]\` must have exactly one stage name`);
  const [stageName] = stageNames;
  if (stageName === "$out") {
    throw permissionDenied("`pipeline` uses $out, which replaces a whole collection; agent tool calls may not do that (use $merge, or a workflow node)");
  }
  if (stageName === "$merge" && !writesAllowed) {
    throw permissionDenied("`pipeline` uses $merge, which writes; agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1 for that");
  }
  if (stageName !== "$merge" && !TOOL_STAGES.has(stageName)) {
    throw permissionDenied(`\`pipeline\` uses the stage ${stageName}, which is not on the allowlist for agent tool calls; use a workflow node`);
  }
  assertToolOperatorsAllowed(stage[stageName], `pipeline[${index}].${stageName}`);
}

/**
 * Whether a pipeline ends in `$out` or `$merge` (the driver then returns no documents).
 *
 * @param pipeline - Aggregation stages (object[])
 * @returns True for a writing pipeline (boolean)
 */
export function isWritingPipeline(pipeline) {
  const lastStage = pipeline.at(-1);
  return Boolean(lastStage) && WRITE_STAGES.some((stageName) => Object.hasOwn(lastStage, stageName));
}

/**
 * Whether a filter obviously matches every document: `{}`, `{$and: []}`, `{$and: [{}]}`, `{$or: [{}]}`,
 * `{$expr: true}` and combinations. Accident protection for mass changes, not a security boundary:
 * a filter such as `{_id: {$exists: true}}` still matches everything.
 *
 * @param filter - Decoded filter (object)
 * @returns True when the filter is trivially "everything" (boolean)
 *
 * @example
 * isMatchEverythingFilter({ $and: [{}] }); // true
 */
export function isMatchEverythingFilter(filter) {
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) return false;
  return Object.entries(filter).every(([key, value]) => isTrivialClause(key, value));
}

function isTrivialClause(key, value) {
  if (TRIVIAL_FILTER_KEYS.has(key)) return true;
  if (key === "$and") return Array.isArray(value) && value.every(isMatchEverythingFilter);
  if (key === "$or") return Array.isArray(value) && value.some(isMatchEverythingFilter);
  if (key === "$expr") return isTruthyConstant(value);
  return false;
}

// Aggregation truthiness of a constant: everything but false, null, 0 and missing. "$x" is a field path, not a constant.
function isTruthyConstant(value) {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !value.startsWith("$");
  if (value && typeof value === "object" && Object.hasOwn(value, "$literal")) {
    return ![false, null, 0, undefined].includes(value.$literal);
  }
  return false;
}

/**
 * Validates a database name.
 *
 * @param databaseName - Name (string)
 * @param label - Where it came from, for messages (string, default "`database`")
 * @returns The name (string)
 * @throws PluginError kind `invalid_input`
 */
export function validateDatabaseName(databaseName, label = "`database`") {
  if (typeof databaseName !== "string" || !databaseName || databaseName.length > 63 || INVALID_DATABASE_CHARACTERS.test(databaseName)) {
    throw invalidInput(`${label} must be 1-63 characters without / \\ . space " $ * < > : | ?`);
  }
  return databaseName;
}

/**
 * Validates a collection name.
 *
 * @param collectionName - Name (string)
 * @returns The name (string)
 * @throws PluginError kind `invalid_input`
 */
export function validateCollectionName(collectionName) {
  if (typeof collectionName !== "string" || !collectionName || collectionName.length > 255 || /[$\u0000]/.test(collectionName)) {
    throw invalidInput("`collection` must be 1-255 characters without $ or NUL");
  }
  return collectionName;
}

/**
 * Whether a database is internal (`admin`, `local`, `config`, in any letter case).
 *
 * @param databaseName - Name (string)
 * @returns True for an internal database (boolean)
 */
export function isProtectedDatabase(databaseName) {
  return PROTECTED_DATABASES.includes(String(databaseName).toLowerCase());
}

/**
 * Whether tool calls may use a database: the default database, MONGODB_TOOL_ALLOWED_DATABASES entries,
 * or any non-internal database when that setting is `*`. Internal databases never.
 *
 * @param settings - `{defaultDatabase, toolAllowedDatabases}` from resolveSettings (object)
 * @param databaseName - Name (string)
 * @returns True when allowed (boolean)
 */
export function isToolDatabaseAllowed(settings, databaseName) {
  if (isProtectedDatabase(databaseName)) return false;
  if (settings.toolAllowedDatabases === "*") return true;
  return databaseName === settings.defaultDatabase || settings.toolAllowedDatabases.includes(databaseName);
}

/**
 * Refuses databases outside the tool allowlist and `system.*` collections for tool calls.
 *
 * @param settings - Settings (object)
 * @param databaseName - Validated database name (string)
 * @param collectionName - Validated collection name, or null for database-level calls (string | null)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolNamespaceAllowed(settings, databaseName, collectionName) {
  if (!isToolDatabaseAllowed(settings, databaseName)) {
    throw permissionDenied(`Agent tool calls may not use the \`${databaseName}\` database; ${databaseHint(databaseName)}`);
  }
  if (collectionName?.startsWith("system.")) {
    throw permissionDenied(`Agent tool calls may not use \`${collectionName}\`; use a workflow node`);
  }
}

// `{$lookup: {from: "x" | {db, coll}}}`, `{$unionWith: "x" | {coll, db?}}`, `{$merge: {into: "x" | {db, coll}}}` or `{$merge: "x"}`.
function listNamespaceReferences(value) {
  if (value === null || typeof value !== "object") return [];
  const namespaces = [];
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === "$merge") namespaces.push(...describeNamespace(typeof childValue === "string" ? childValue : childValue?.into));
    if (childKey === "$out") namespaces.push(...describeNamespace(childValue));
    const field = FOREIGN_COLLECTION_FIELDS.get(childKey);
    if (field && typeof childValue === "string") namespaces.push({ collectionName: childValue });
    if (field && childValue && typeof childValue === "object") {
      if (childKey === "$unionWith" && childValue.db !== undefined) namespaces.push({ databaseName: childValue.db, collectionName: childValue.coll });
      namespaces.push(...describeNamespace(childValue[field]));
    }
    namespaces.push(...listNamespaceReferences(childValue));
  }
  return namespaces;
}

function describeNamespace(reference) {
  if (typeof reference === "string") return [{ collectionName: reference }];
  if (reference && typeof reference === "object") return [{ databaseName: reference.db, collectionName: reference.coll }];
  return [];
}

function databaseHint(databaseName) {
  return isProtectedDatabase(databaseName) ? "use a workflow node" : "add it to MONGODB_TOOL_ALLOWED_DATABASES or use a workflow node";
}

function lastSegment(path) {
  return path.split(".").at(-1);
}
