/**
 * Write operations: insert, update, replace and delete.
 *
 * Agent tool calls may only run them with MONGODB_TOOL_ALLOW_WRITES=1, and
 * never with an empty filter for update_many/delete_many. Workflow nodes may,
 * with `allow_all: true`. Writes are not retried by the plugin.
 */
import { invalidInput } from "../lib/errors.mjs";
import {
  ALLOW_ALL_PROPERTY,
  COLLECTION_PROPERTY,
  DATABASE_PROPERTY,
  FILTER_PROPERTY,
  MAX_DOCUMENTS,
  MAX_TIME_PROPERTY,
  UPSERT_PROPERTY,
  assertFilterNotEmpty,
  assertWriteAllowed,
  decodeArgument,
  resolveNamespace,
} from "./common.mjs";

const DOCUMENT_PROPERTY = {
  type: "object",
  description: "Document in Extended JSON, e.g. {\"name\": \"Budi\", \"joined\": {\"$date\": \"2026-11-19T00:00:00Z\"}, \"balance\": {\"$numberDecimal\": \"10.50\"}}",
};
const UPDATE_PROPERTY = {
  type: "object",
  description: "Update operators in Extended JSON, e.g. {\"$set\": {\"status\": \"shipped\"}, \"$inc\": {\"stock\": -1}}",
};
const REQUIRED_FILTER_PROPERTY = { ...FILTER_PROPERTY, description: `${FILTER_PROPERTY.description}. Required: pass {} on purpose to match any document` };

const insertOne = defineWrite({
  name: "insert_one",
  title: "Insert document",
  description: "Insert one document (Extended JSON). Returns its _id. Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1.",
  properties: { document: DOCUMENT_PROPERTY, max_time_ms: MAX_TIME_PROPERTY },
  required: ["document"],
  execute: async ({ collection, codec, context }) => {
    const document = decodeArgument(codec, context.args.document, "document", context.source);
    const result = await collection.insertOne(document, writeOptions(context));
    return { inserted_id: codec.encode(result.insertedId), acknowledged: result.acknowledged !== false };
  },
});

const insertMany = defineWrite({
  name: "insert_many",
  title: "Insert documents",
  description: "Insert up to 1000 documents (Extended JSON). Returns their _ids. Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1.",
  properties: {
    documents: { type: "array", maxItems: MAX_DOCUMENTS, items: { type: "object" }, description: "Documents to insert" },
    ordered: { type: "boolean", default: true, description: "Stop at the first error (true) or insert the rest anyway (false)" },
    max_time_ms: MAX_TIME_PROPERTY,
  },
  required: ["documents"],
  execute: async ({ collection, codec, context }) => {
    if (context.args.documents.length === 0) throw invalidInput("`documents` must not be empty");
    const documents = decodeArgument(codec, context.args.documents, "documents", context.source);
    const result = await collection.insertMany(documents, { ordered: context.args.ordered, ...writeOptions(context) });
    const insertedIds = Object.values(result.insertedIds ?? {}).map((insertedId) => codec.encode(insertedId));
    return { inserted_ids: insertedIds, inserted_count: result.insertedCount, acknowledged: result.acknowledged !== false };
  },
});

const updateOne = defineUpdate({ name: "update_one", title: "Update document", many: false });
const updateMany = defineUpdate({ name: "update_many", title: "Update documents", many: true });

const replaceOne = defineWrite({
  name: "replace_one",
  title: "Replace document",
  description: "Replace the first document that matches the filter with a new document (no update operators). Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1.",
  properties: { filter: REQUIRED_FILTER_PROPERTY, replacement: DOCUMENT_PROPERTY, upsert: UPSERT_PROPERTY, max_time_ms: MAX_TIME_PROPERTY },
  required: ["filter", "replacement"],
  execute: async ({ collection, codec, context }) => {
    const { args, source } = context;
    if (Object.keys(args.replacement).some((key) => key.startsWith("$"))) {
      throw invalidInput("`replacement` is a whole document; use update_one for $ operators");
    }
    const filter = decodeArgument(codec, args.filter, "filter", source);
    const replacement = decodeArgument(codec, args.replacement, "replacement", source);
    const result = await collection.replaceOne(filter, replacement, { upsert: args.upsert, ...writeOptions(context) });
    return describeUpdateResult(result, codec);
  },
});

const deleteOne = defineDelete({ name: "delete_one", title: "Delete document", many: false });
const deleteMany = defineDelete({ name: "delete_many", title: "Delete documents", many: true });

function defineUpdate({ name, title, many }) {
  return defineWrite({
    name,
    title,
    description: many
      ? "Apply update operators to every document that matches the filter. An empty filter needs `allow_all: true` (workflow nodes only). Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1."
      : "Apply update operators ($set, $inc, $push…) to the first document that matches the filter. Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1.",
    properties: {
      filter: REQUIRED_FILTER_PROPERTY,
      update: UPDATE_PROPERTY,
      upsert: UPSERT_PROPERTY,
      ...(many ? { allow_all: ALLOW_ALL_PROPERTY } : {}),
      max_time_ms: MAX_TIME_PROPERTY,
    },
    required: ["filter", "update"],
    execute: async ({ collection, codec, context }) => {
      const { args, source } = context;
      assertUpdateOperators(args.update);
      const filter = decodeArgument(codec, args.filter, "filter", source);
      if (many) assertFilterNotEmpty(filter, context, name);
      const update = decodeArgument(codec, args.update, "update", source);
      const options = { upsert: args.upsert, ...writeOptions(context) };
      const result = many ? await collection.updateMany(filter, update, options) : await collection.updateOne(filter, update, options);
      return describeUpdateResult(result, codec);
    },
  });
}

function defineDelete({ name, title, many }) {
  return defineWrite({
    name,
    title,
    description: many
      ? "Delete every document that matches the filter. An empty filter needs `allow_all: true` (workflow nodes only). Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1."
      : "Delete the first document that matches the filter. Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1.",
    properties: { filter: REQUIRED_FILTER_PROPERTY, ...(many ? { allow_all: ALLOW_ALL_PROPERTY } : {}), max_time_ms: MAX_TIME_PROPERTY },
    required: ["filter"],
    execute: async ({ collection, codec, context }) => {
      const filter = decodeArgument(codec, context.args.filter, "filter", context.source);
      if (many) assertFilterNotEmpty(filter, context, name);
      const options = writeOptions(context);
      const result = many ? await collection.deleteMany(filter, options) : await collection.deleteOne(filter, options);
      return { deleted_count: result.deletedCount, acknowledged: result.acknowledged !== false };
    },
  });
}

/**
 * Builds a write operation: checks the tool opt-in and namespace, then runs `execute` on the collection.
 *
 * @param spec - `{name, title, description, properties, required, execute({collection, codec, context})}` (object)
 * @returns Operation definition (object)
 */
function defineWrite({ name, title, description, properties, required, execute }) {
  return {
    name,
    title,
    description,
    parameters: {
      type: "object",
      properties: { database: DATABASE_PROPERTY, collection: COLLECTION_PROPERTY, ...properties },
      required: ["collection", ...required],
    },
    run: (context) => {
      assertWriteAllowed(context, name);
      const { databaseName, collectionName } = resolveNamespace(context);
      return context.client.withDatabase(
        databaseName,
        async ({ database, codec }) => ({ data: await execute({ collection: database.collection(collectionName), codec, context }) }),
        { signal: context.signal, isWrite: true },
      );
    },
  };
}

// maxTimeMS bounds the server; the signal stops waiting (the write may still have been applied).
function writeOptions(context) {
  return context.signal ? { maxTimeMS: context.args.max_time_ms, signal: context.signal } : { maxTimeMS: context.args.max_time_ms };
}

function assertUpdateOperators(update) {
  const keys = Object.keys(update);
  if (keys.length === 0 || keys.some((key) => !key.startsWith("$"))) {
    throw invalidInput("`update` must contain only update operators, e.g. {\"$set\": {...}}; use replace_one to replace a whole document");
  }
}

function describeUpdateResult(result, codec) {
  return {
    matched_count: result.matchedCount,
    modified_count: result.modifiedCount,
    upserted_count: result.upsertedCount ?? 0,
    upserted_id: result.upsertedId === null || result.upsertedId === undefined ? null : codec.encode(result.upsertedId),
    acknowledged: result.acknowledged !== false,
  };
}

export const writingOperations = [insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany];
