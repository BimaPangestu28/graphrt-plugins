/**
 * Test doubles: a fake MongoDB driver (MongoClient + EJSON) that records
 * every call, and a runner wired to it. Nothing here opens a socket or needs
 * the mongodb package.
 */
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const TEST_PASSWORD = "s3cr%40t-pass";
export const TEST_URL = `mongodb://app:${TEST_PASSWORD}@db.example.com:27017/shop?authSource=admin`;

/** Minimal ObjectId stand-in, so EJSON round trips can be checked. */
export class FakeObjectId {
  constructor(hex) {
    this.hex = hex;
  }
}

/** Fake EJSON: `$oid` ↔ FakeObjectId and `$date` ↔ Date, everything else as is. */
export const FAKE_EJSON = {
  deserialize(value) {
    return reviveValue(structuredClone(value));
  },
  serialize(value) {
    return encodeValue(value);
  },
};

function reviveValue(value) {
  if (Array.isArray(value)) return value.map(reviveValue);
  if (value === null || typeof value !== "object") return value;
  if (typeof value.$oid === "string") return new FakeObjectId(value.$oid);
  if (typeof value.$date === "string") return new Date(value.$date);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, reviveValue(child)]));
}

function encodeValue(value) {
  if (value instanceof FakeObjectId) return { $oid: value.hex };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeValue(child)]));
}

/** Cursor over a list of documents that records whether it was closed. */
export class FakeCursor {
  constructor(documents, state) {
    this.documents = documents;
    this.state = state;
    this.closed = false;
  }

  async *[Symbol.asyncIterator]() {
    for (const document of this.documents) {
      if (this.state.cursorError) throw this.state.cursorError;
      yield document;
    }
  }

  async toArray() {
    return [...this.documents];
  }

  async close() {
    this.closed = true;
    this.state.closedCursors += 1;
  }
}

/**
 * Creates the fake driver and its shared, inspectable state.
 *
 * @param options - `{documents, connectError, operationError, writeResult, databases, collections, delayMs}` (object)
 * @returns `{loadDriver, state}`; `state.calls` lists `{method, database, collection, args}` (object)
 */
export function createFakeDriver(options = {}) {
  const state = {
    documents: options.documents ?? [],
    connectError: options.connectError ?? null,
    operationError: options.operationError ?? null,
    cursorError: null,
    delayMs: options.delayMs ?? 0,
    calls: [],
    clients: [],
    closedCursors: 0,
    loadCount: 0,
  };
  class FakeMongoClient {
    constructor(connectionUrl, clientOptions) {
      this.connectionUrl = connectionUrl;
      this.options = clientOptions;
      this.closed = false;
      state.clients.push(this);
    }

    async connect() {
      if (state.connectError) throw state.connectError;
    }

    async close() {
      this.closed = true;
    }

    db(databaseName) {
      return createFakeDatabase(databaseName, state, options);
    }
  }
  const loadDriver = async () => {
    state.loadCount += 1;
    return { MongoClient: FakeMongoClient, EJSON: FAKE_EJSON };
  };
  return { loadDriver, state };
}

function createFakeDatabase(databaseName, state, options) {
  return {
    databaseName,
    collection: (collectionName) => createFakeCollection(databaseName, collectionName, state, options),
    admin: () => ({
      listDatabases: async (listOptions) => {
        record(state, "listDatabases", databaseName, null, [listOptions]);
        return { databases: options.databases ?? [{ name: "shop", sizeOnDisk: 8192, empty: false }] };
      },
    }),
    listCollections: (filter, listOptions) => {
      record(state, "listCollections", databaseName, null, [filter, listOptions]);
      return new FakeCursor(options.collections ?? [{ name: "orders", type: "collection" }], state);
    },
  };
}

function createFakeCollection(databaseName, collectionName, state, options) {
  const respond = async (method, args, result) => {
    record(state, method, databaseName, collectionName, args);
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.operationError) throw state.operationError;
    return typeof result === "function" ? result() : result;
  };
  const writeResult = options.writeResult ?? {};
  return {
    find(filter, findOptions) {
      record(state, "find", databaseName, collectionName, [filter, findOptions]);
      if (state.operationError) throw state.operationError;
      const skipped = state.documents.slice(findOptions?.skip ?? 0);
      return new FakeCursor(findOptions?.limit ? skipped.slice(0, findOptions.limit) : skipped, state);
    },
    aggregate(pipeline, aggregateOptions) {
      record(state, "aggregate", databaseName, collectionName, [pipeline, aggregateOptions]);
      return new FakeCursor(state.documents, state);
    },
    findOne: (filter, findOptions) => respond("findOne", [filter, findOptions], () => state.documents[0] ?? null),
    countDocuments: (filter, countOptions) => respond("countDocuments", [filter, countOptions], state.documents.length),
    distinct: (field, filter, distinctOptions) =>
      respond("distinct", [field, filter, distinctOptions], () => [...new Set(state.documents.map((document) => document[field]))]),
    insertOne: (document, insertOptions) => respond("insertOne", [document, insertOptions], { acknowledged: true, insertedId: document._id ?? new FakeObjectId("aaaaaaaaaaaaaaaaaaaaaaaa") }),
    insertMany: (documents, insertOptions) =>
      respond("insertMany", [documents, insertOptions], {
        acknowledged: true,
        insertedCount: documents.length,
        insertedIds: Object.fromEntries(documents.map((document, index) => [index, document._id ?? new FakeObjectId(String(index).padStart(24, "0"))])),
      }),
    updateOne: (filter, update, updateOptions) => respond("updateOne", [filter, update, updateOptions], writeResult.update ?? defaultUpdateResult()),
    updateMany: (filter, update, updateOptions) => respond("updateMany", [filter, update, updateOptions], writeResult.update ?? defaultUpdateResult()),
    replaceOne: (filter, replacement, replaceOptions) => respond("replaceOne", [filter, replacement, replaceOptions], writeResult.update ?? defaultUpdateResult()),
    deleteOne: (filter, deleteOptions) => respond("deleteOne", [filter, deleteOptions], { acknowledged: true, deletedCount: 1 }),
    deleteMany: (filter, deleteOptions) => respond("deleteMany", [filter, deleteOptions], { acknowledged: true, deletedCount: 3 }),
  };
}

function defaultUpdateResult() {
  return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
}

function record(state, method, database, collection, args) {
  state.calls.push({ method, database, collection, args });
}

/**
 * Builds a runner over a fake driver.
 *
 * @param options - `{environment, driver options…}` (object)
 * @returns `{runOperation(name, args, {source, signal}), state, definition}` (object)
 */
export function createTestRunner({ environment = {}, timers, ...driverOptions } = {}) {
  const { loadDriver, state } = createFakeDriver(driverOptions);
  const definition = createPluginDefinition({ loadDriver, timers });
  const runner = createOperationRunner(definition, { MONGODB_URL: TEST_URL, ...environment });
  const runOperation = (operationName, args = {}, { source = "node", signal } = {}) => runner(operationName, args, { source, signal });
  return { runOperation, state, definition };
}
