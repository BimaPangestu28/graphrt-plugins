/**
 * Parameter schemas and checks shared by the MongoDB operations.
 */
import { invalidInput, permissionDenied } from "../lib/errors.mjs";
import {
  assertNoInternalOperators,
  assertToolNamespaceAllowed,
  assertToolOperatorsAllowed,
  isMatchEverythingFilter,
  validateCollectionName,
  validateDatabaseName,
} from "../lib/query-guard.mjs";

export const MAX_DOCUMENTS = 1000;
export const DEFAULT_MAX_TIME_MS = 15_000;

export const DATABASE_PROPERTY = {
  type: "string",
  description: "Database name; defaults to MONGODB_DATABASE or the database in the connection string",
};
export const COLLECTION_PROPERTY = { type: "string", description: "Collection name" };
export const FILTER_PROPERTY = {
  type: "object",
  description: "Query filter in Extended JSON, e.g. {\"status\": \"paid\", \"_id\": {\"$oid\": \"65a1f0c2e4b0a1b2c3d4e5f6\"}, \"created\": {\"$gte\": {\"$date\": \"2026-01-01T00:00:00Z\"}}}",
};
export const MAX_TIME_PROPERTY = {
  type: "integer",
  minimum: 100,
  maximum: 60_000,
  default: DEFAULT_MAX_TIME_MS,
  description: "Server-side time limit (maxTimeMS) in milliseconds",
};
export const ALLOW_ALL_PROPERTY = {
  type: "boolean",
  default: false,
  description: "Required (workflow nodes only) to run with an empty filter, which matches every document",
};
export const UPSERT_PROPERTY = { type: "boolean", default: false, description: "Insert a document when nothing matches" };

/**
 * Resolves and checks the target database (and collection) of an operation.
 *
 * @param context - Operation context `{args, client, source}` (object)
 * @param options - `{needsCollection}` (object)
 * @returns `{databaseName, collectionName}` (object)
 * @throws PluginError kinds `invalid_input` (no database) and `permission_denied` (tool limits)
 */
export function resolveNamespace({ args, client, source }, { needsCollection = true } = {}) {
  const databaseName = args.database ?? client.settings.defaultDatabase;
  if (!databaseName) {
    throw invalidInput("No database: pass `database`, set MONGODB_DATABASE, or put it in the connection string (mongodb://host/<database>)");
  }
  validateDatabaseName(databaseName);
  const collectionName = needsCollection ? validateCollectionName(args.collection) : null;
  if (source === "tool") assertToolNamespaceAllowed(client.settings, databaseName, collectionName);
  return { databaseName, collectionName };
}

/**
 * Checks an Extended JSON argument (allowlisted operators for tools, no `$_` internals for anyone)
 * and decodes it to BSON values.
 *
 * @param codec - From createDocumentCodec (object)
 * @param value - JSON argument (unknown)
 * @param label - Argument name (string)
 * @param source - "node" or "tool" (string)
 * @returns Decoded value (unknown)
 */
export function decodeArgument(codec, value, label, source) {
  if (source === "tool") assertToolOperatorsAllowed(value, label);
  else assertNoInternalOperators(value, label);
  return codec.decode(value, label);
}

/**
 * Refuses writes from tool calls unless MONGODB_TOOL_ALLOW_WRITES=1.
 *
 * @param context - `{client, source}` (object)
 * @param operationName - For the message (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertWriteAllowed({ client, source }, operationName) {
  if (source === "tool" && !client.settings.toolWritesAllowed) {
    throw permissionDenied(`\`${operationName}\` writes to the database; agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1 (workflow nodes are always allowed)`);
  }
}

/**
 * Refuses a match-everything filter (`{}`, `{$and: [{}]}`, `{$expr: true}`…) for a multi-document write
 * unless a node passes `allow_all: true`. Accident protection, not a security boundary.
 *
 * @param filter - Decoded filter (object)
 * @param context - `{args, source}` (object)
 * @param operationName - For the message (string)
 * @throws PluginError kinds `invalid_input` / `permission_denied`
 */
export function assertFilterNotEmpty(filter, { args, source }, operationName) {
  if (!isMatchEverythingFilter(filter)) return;
  if (source === "tool") throw permissionDenied(`\`${operationName}\` with a filter that matches everything would change every document; agent tool calls may not do that`);
  if (!args.allow_all) throw invalidInput(`\`${operationName}\` with a filter that matches everything changes every document; pass \`allow_all: true\` if that is intended`);
}

/**
 * Reads an offset cursor (the `next_cursor` of an earlier call) or `skip`.
 *
 * @param args - `{cursor?, skip?}` (object)
 * @returns Documents to skip (number)
 * @throws PluginError kind `invalid_input` - When the cursor is not an offset
 */
export function resolveOffset(args) {
  if (args.cursor === undefined) return args.skip ?? 0;
  const offset = Number(args.cursor);
  if (!/^\d{1,12}$/.test(String(args.cursor)) || !Number.isSafeInteger(offset)) throw invalidInput("`cursor` must be a `next_cursor` from an earlier call");
  return offset;
}
