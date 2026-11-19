/**
 * Read operations: find, find_one, count, distinct and aggregate.
 * Results are Extended JSON (relaxed), capped by document count and MONGODB_MAX_RESULT_BYTES.
 */
import { invalidInput } from "../lib/errors.mjs";
import { measureJsonBytes } from "../lib/documents.mjs";
import { assertNoInternalOperators, assertToolPipelineAllowed, isToolDatabaseAllowed, isWritingPipeline } from "../lib/query-guard.mjs";
import { capValues, collectDocuments } from "../lib/result-limits.mjs";
import {
  COLLECTION_PROPERTY,
  DATABASE_PROPERTY,
  FILTER_PROPERTY,
  MAX_DOCUMENTS,
  MAX_TIME_PROPERTY,
  decodeArgument,
  resolveNamespace,
  resolveOffset,
} from "./common.mjs";

const PROJECTION_PROPERTY = { type: "object", description: "Fields to return, e.g. {\"name\": 1, \"total\": 1, \"_id\": 0}" };
const SORT_PROPERTY = { type: "object", description: "Sort order, e.g. {\"created\": -1}" };
const LIMIT_PROPERTY = { type: "integer", minimum: 1, maximum: MAX_DOCUMENTS, default: 100, description: "Documents to return (max 1000)" };
const MAX_DISTINCT_VALUES = 1000;
const MAX_PIPELINE_STAGES = 100;

const find = {
  name: "find",
  title: "Find documents",
  description:
    "Find documents in a collection with an Extended JSON filter, projection and sort. Returns up to `limit` documents (max 1000, and at most MONGODB_MAX_RESULT_BYTES) and a next_cursor for the next page.",
  parameters: {
    type: "object",
    properties: {
      database: DATABASE_PROPERTY,
      collection: COLLECTION_PROPERTY,
      filter: FILTER_PROPERTY,
      projection: PROJECTION_PROPERTY,
      sort: SORT_PROPERTY,
      limit: LIMIT_PROPERTY,
      skip: { type: "integer", minimum: 0, maximum: 1_000_000_000, description: "Documents to skip" },
      cursor: { type: "string", description: "`next_cursor` from the previous page (replaces skip)" },
      max_time_ms: MAX_TIME_PROPERTY,
    },
    required: ["collection"],
  },
  run: (context) => {
    const { databaseName, collectionName } = resolveNamespace(context);
    const offset = resolveOffset(context.args);
    return context.client.withDatabase(
      databaseName,
      async ({ database, codec }) => {
        const query = decodeQueryOptions(codec, context);
        const cursor = database.collection(collectionName).find(query.filter, {
          projection: query.projection,
          sort: query.sort,
          skip: offset,
          limit: context.args.limit + 1,
          batchSize: Math.min(context.args.limit + 1, MAX_DOCUMENTS),
          maxTimeMS: context.args.max_time_ms,
          signal: context.signal,
        });
        const page = await collectPage(cursor, context, codec);
        return {
          data: { documents: page.documents, count: page.documents.length, truncated: page.truncated, has_more: page.hasMore },
          next_cursor: page.hasMore ? String(offset + page.documents.length) : null,
        };
      },
      { signal: context.signal },
    );
  },
};

const findOne = {
  name: "find_one",
  title: "Find one document",
  description: "Return the first document that matches an Extended JSON filter (optionally sorted and projected), or null.",
  parameters: {
    type: "object",
    properties: {
      database: DATABASE_PROPERTY,
      collection: COLLECTION_PROPERTY,
      filter: FILTER_PROPERTY,
      projection: PROJECTION_PROPERTY,
      sort: SORT_PROPERTY,
      max_time_ms: MAX_TIME_PROPERTY,
    },
    required: ["collection"],
  },
  run: (context) => {
    const { databaseName, collectionName } = resolveNamespace(context);
    return context.client.withDatabase(
      databaseName,
      async ({ database, codec }) => {
        const query = decodeQueryOptions(codec, context);
        const document = await database.collection(collectionName).findOne(query.filter, {
          projection: query.projection,
          sort: query.sort,
          maxTimeMS: context.args.max_time_ms,
          signal: context.signal,
        });
        const encodedDocument = document === null ? null : codec.encode(document);
        assertFitsResultCap(encodedDocument, context);
        return { data: { document: encodedDocument, found: document !== null } };
      },
      { signal: context.signal },
    );
  },
};

const count = {
  name: "count",
  title: "Count documents",
  description: "Count the documents that match an Extended JSON filter (an empty filter counts the whole collection).",
  parameters: {
    type: "object",
    properties: {
      database: DATABASE_PROPERTY,
      collection: COLLECTION_PROPERTY,
      filter: FILTER_PROPERTY,
      max_time_ms: MAX_TIME_PROPERTY,
    },
    required: ["collection"],
  },
  run: (context) => {
    const { databaseName, collectionName } = resolveNamespace(context);
    return context.client.withDatabase(
      databaseName,
      async ({ database, codec }) => {
        const filter = decodeArgument(codec, context.args.filter ?? {}, "filter", context.source);
        const total = await database.collection(collectionName).countDocuments(filter, { maxTimeMS: context.args.max_time_ms, signal: context.signal });
        return { data: { count: total } };
      },
      { signal: context.signal },
    );
  },
};

const distinct = {
  name: "distinct",
  title: "Distinct values",
  description: "List the distinct values of a field (dotted paths allowed) among documents that match a filter; at most 1000 values.",
  parameters: {
    type: "object",
    properties: {
      database: DATABASE_PROPERTY,
      collection: COLLECTION_PROPERTY,
      field: { type: "string", minLength: 1, description: "Field name, e.g. \"status\" or \"address.city\"" },
      filter: FILTER_PROPERTY,
      max_time_ms: MAX_TIME_PROPERTY,
    },
    required: ["collection", "field"],
  },
  run: (context) => {
    const { databaseName, collectionName } = resolveNamespace(context);
    if (context.args.field.startsWith("$")) throw invalidInput("`field` is a field name, not an expression");
    return context.client.withDatabase(
      databaseName,
      async ({ database, codec }) => {
        const filter = decodeArgument(codec, context.args.filter ?? {}, "filter", context.source);
        const values = await database.collection(collectionName).distinct(context.args.field, filter, {
          maxTimeMS: context.args.max_time_ms,
          signal: context.signal,
        });
        const capped = capValues(values.map((value) => codec.encode(value)), MAX_DISTINCT_VALUES, context.client.settings.maxResultBytes);
        return { data: { values: capped.values, count: capped.values.length, total_distinct: values.length, truncated: capped.truncated } };
      },
      { signal: context.signal },
    );
  },
};

const aggregate = {
  name: "aggregate",
  title: "Aggregate",
  description:
    "Run an aggregation pipeline (Extended JSON stages) on a collection and return up to `limit` documents. Agent tool calls may only use allowlisted stages and operators (no JavaScript, no $out), and $merge only with MONGODB_TOOL_ALLOW_WRITES=1.",
  parameters: {
    type: "object",
    properties: {
      database: DATABASE_PROPERTY,
      collection: COLLECTION_PROPERTY,
      pipeline: {
        type: "array",
        maxItems: MAX_PIPELINE_STAGES,
        items: { type: "object" },
        description: "Stages, e.g. [{\"$match\": {\"status\": \"paid\"}}, {\"$group\": {\"_id\": \"$city\", \"total\": {\"$sum\": \"$amount\"}}}]",
      },
      limit: LIMIT_PROPERTY,
      allow_disk_use: { type: "boolean", default: false, description: "Let large $sort/$group stages spill to disk" },
      max_time_ms: MAX_TIME_PROPERTY,
    },
    required: ["collection", "pipeline"],
  },
  run: (context) => {
    const { databaseName, collectionName } = resolveNamespace(context);
    const { args, source, client } = context;
    if (source === "tool") {
      const isDatabaseAllowed = (name) => isToolDatabaseAllowed(client.settings, name);
      assertToolPipelineAllowed(args.pipeline, { writesAllowed: client.settings.toolWritesAllowed, isDatabaseAllowed });
    } else {
      assertNoInternalOperators(args.pipeline, "pipeline");
    }
    const writes = isWritingPipeline(args.pipeline);
    return client.withDatabase(
      databaseName,
      async ({ database, codec }) => {
        const stages = codec.decode(args.pipeline, "pipeline");
        const options = { maxTimeMS: args.max_time_ms, allowDiskUse: args.allow_disk_use, signal: context.signal };
        const collection = database.collection(collectionName);
        if (writes) {
          await collection.aggregate(stages, options).toArray();
          return { data: { documents: [], count: 0, truncated: false, has_more: false, wrote_output: true } };
        }
        const cursor = collection.aggregate([...stages, { $limit: args.limit + 1 }], { ...options, batchSize: Math.min(args.limit + 1, MAX_DOCUMENTS) });
        const page = await collectPage(cursor, context, codec);
        return { data: { documents: page.documents, count: page.documents.length, truncated: page.truncated, has_more: page.hasMore } };
      },
      { signal: context.signal, isWrite: writes },
    );
  },
};

function decodeQueryOptions(codec, { args, source }) {
  return {
    filter: decodeArgument(codec, args.filter ?? {}, "filter", source),
    projection: args.projection === undefined ? undefined : decodeArgument(codec, args.projection, "projection", source),
    sort: args.sort === undefined ? undefined : decodeArgument(codec, args.sort, "sort", source),
  };
}

async function collectPage(cursor, context, codec) {
  const page = await collectDocuments(cursor, {
    maxDocuments: context.args.limit,
    maxBytes: context.client.settings.maxResultBytes,
    encode: (document) => codec.encode(document),
  });
  if (page.truncated && page.documents.length === 0) throw oversizedDocumentError(context);
  return page;
}

function assertFitsResultCap(encodedDocument, context) {
  if (encodedDocument !== null && measureJsonBytes(encodedDocument) > context.client.settings.maxResultBytes) throw oversizedDocumentError(context);
}

function oversizedDocumentError(context) {
  return invalidInput(
    `A matching document is larger than MONGODB_MAX_RESULT_BYTES (${context.client.settings.maxResultBytes}); use \`projection\` to return fewer fields`,
  );
}

export const readingOperations = [find, findOne, count, distinct, aggregate];
