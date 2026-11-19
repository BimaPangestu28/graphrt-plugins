import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { FakeObjectId, TEST_PASSWORD, TEST_URL, createTestRunner } from "./helpers.mjs";

const AS_TOOL = { source: "tool" };
const ORDER_ID = "65a1f0c2e4b0a1b2c3d4e5f6";
const ORDERS = [
  { _id: new FakeObjectId(ORDER_ID), status: "paid", created: new Date("2026-01-02T00:00:00Z") },
  { _id: new FakeObjectId("65a1f0c2e4b0a1b2c3d4e5f7"), status: "new", created: new Date("2026-01-03T00:00:00Z") },
  { _id: new FakeObjectId("65a1f0c2e4b0a1b2c3d4e5f8"), status: "paid", created: new Date("2026-01-04T00:00:00Z") },
];

test("manifest: all operations are tools, MONGODB_URL and settings env declared", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), [
    "find", "find_one", "count", "distinct", "aggregate", "list_databases", "list_collections",
    "insert_one", "insert_many", "update_one", "update_many", "replace_one", "delete_one", "delete_many",
  ]);
  assert.deepEqual(manifest.permissions.env, ["MONGODB_URL", "MONGODB_DATABASE", "MONGODB_TOOL_ALLOW_WRITES", "MONGODB_TOOL_ALLOWED_DATABASES", "MONGODB_MAX_RESULT_BYTES", "MONGODB_IDLE_MINUTES"]);
  assert.equal(manifest.permissions.network, true);
});

test("no connection string → auth_error before loading the driver", async () => {
  const { runOperation, state } = createTestRunner({ environment: { MONGODB_URL: "" } });
  await assert.rejects(runOperation("find", { collection: "orders" }), { kind: "auth_error", message: /MONGODB_URL/ });
  assert.equal(state.loadCount, 0);
});

test("a non-mongodb URL is refused without echoing it", async () => {
  const { runOperation } = createTestRunner({ environment: { MONGODB_URL: "postgres://u:hunter22@db/x" } });
  await assert.rejects(runOperation("find", { collection: "orders" }), (error) => {
    assert.equal(error.kind, "invalid_input");
    assert.doesNotMatch(error.message, /hunter22/);
    return true;
  });
});

test("find decodes Extended JSON, passes caps and maxTimeMS, and encodes results", async () => {
  const { runOperation, state } = createTestRunner({ documents: ORDERS });
  const output = await runOperation("find", {
    collection: "orders",
    filter: { _id: { $oid: ORDER_ID }, created: { $gte: { $date: "2026-01-01T00:00:00Z" } } },
    projection: { status: 1 },
    sort: { created: -1 },
    limit: 2,
  });
  const [filter, options] = state.calls[0].args;
  assert.equal(state.calls[0].database, "shop");
  assert.ok(filter._id instanceof FakeObjectId);
  assert.ok(filter.created.$gte instanceof Date);
  assert.deepEqual([options.limit, options.skip, options.maxTimeMS], [3, 0, 15000]);
  assert.deepEqual(options.sort, { created: -1 });
  assert.equal(output.data.count, 2);
  assert.deepEqual(output.data.documents[0], { _id: { $oid: ORDER_ID }, status: "paid", created: { $date: "2026-01-02T00:00:00.000Z" } });
  assert.equal(output.data.has_more, true);
  assert.equal(output.next_cursor, "2");
  assert.equal(state.closedCursors, 1);
});

test("find with the next_cursor reads the next page", async () => {
  const { runOperation, state } = createTestRunner({ documents: ORDERS });
  const output = await runOperation("find", { collection: "orders", limit: 2, cursor: "2" });
  assert.equal(state.calls[0].args[1].skip, 2);
  assert.equal(output.data.count, 1);
  assert.equal(output.data.has_more, false);
  assert.equal(output.next_cursor, null);
});

test("find refuses a limit above 1000 and a malformed cursor", async () => {
  const { runOperation } = createTestRunner();
  await assert.rejects(runOperation("find", { collection: "orders", limit: 1001 }), { kind: "invalid_input" });
  await assert.rejects(runOperation("find", { collection: "orders", cursor: "abc" }), { kind: "invalid_input" });
});

test("find stops at MONGODB_MAX_RESULT_BYTES with truncated and a cursor", async () => {
  const bigDocuments = Array.from({ length: 5 }, (unused, index) => ({ index, text: "x".repeat(400) }));
  const { runOperation } = createTestRunner({ documents: bigDocuments, environment: { MONGODB_MAX_RESULT_BYTES: "1000" } });
  const output = await runOperation("find", { collection: "notes" });
  assert.equal(output.data.count, 2);
  assert.equal(output.data.truncated, true);
  assert.equal(output.next_cursor, "2");
});

test("a single document above the byte cap is an error, not an empty page", async () => {
  const { runOperation } = createTestRunner({ documents: [{ text: "x".repeat(2000) }], environment: { MONGODB_MAX_RESULT_BYTES: "1000" } });
  await assert.rejects(runOperation("find", { collection: "notes" }), { kind: "invalid_input", message: /projection/ });
  await assert.rejects(runOperation("find_one", { collection: "notes" }), { kind: "invalid_input", message: /projection/ });
});

test("find_one, count and distinct return encoded values", async () => {
  const { runOperation, state } = createTestRunner({ documents: ORDERS });
  const found = await runOperation("find_one", { collection: "orders", filter: { status: "paid" } });
  assert.deepEqual(found.data.document._id, { $oid: ORDER_ID });
  assert.equal(found.data.found, true);
  assert.equal((await runOperation("count", { collection: "orders" })).data.count, 3);
  const distinctOutput = await runOperation("distinct", { collection: "orders", field: "status" });
  assert.deepEqual(distinctOutput.data.values, ["paid", "new"]);
  assert.equal(state.calls.find((call) => call.method === "distinct").args[2].maxTimeMS, 15000);
});

test("distinct refuses an expression as field", async () => {
  const { runOperation } = createTestRunner();
  await assert.rejects(runOperation("distinct", { collection: "orders", field: "$status" }), { kind: "invalid_input" });
});

test("aggregate appends a $limit and caps the documents", async () => {
  const { runOperation, state } = createTestRunner({ documents: ORDERS });
  const output = await runOperation("aggregate", { collection: "orders", pipeline: [{ $match: { status: "paid" } }], limit: 2 }, AS_TOOL);
  const [pipeline, options] = state.calls[0].args;
  assert.deepEqual(pipeline, [{ $match: { status: "paid" } }, { $limit: 3 }]);
  assert.equal(options.maxTimeMS, 15000);
  assert.equal(options.allowDiskUse, false);
  assert.equal(output.data.count, 2);
  assert.equal(output.data.has_more, true);
});

for (const [stage, caseName] of [
  [{ $match: { $where: "sleep(1000)" } }, "$where"],
  [{ $addFields: { x: { $function: { body: "function() {}", args: [], lang: "js" } } } }, "$function"],
  [{ $group: { _id: null, x: { $accumulator: {} } } }, "$accumulator"],
  [{ $match: { code: { $code: "while(true){}" } } }, "BSON Code"],
]) {
  test(`aggregate from a tool refuses ${caseName}; a node may use it`, async () => {
    const { runOperation, state } = createTestRunner();
    await assert.rejects(runOperation("aggregate", { collection: "orders", pipeline: [stage] }, AS_TOOL), { kind: "permission_denied" });
    assert.equal(state.calls.length, 0);
    await runOperation("aggregate", { collection: "orders", pipeline: [stage] });
    assert.equal(state.calls.length, 1);
  });
}

test("aggregate from a tool refuses $out/$merge unless writes are enabled", async () => {
  const pipeline = [{ $match: {} }, { $merge: { into: "summary" } }];
  const readOnly = createTestRunner();
  await assert.rejects(readOnly.runOperation("aggregate", { collection: "orders", pipeline }, AS_TOOL), { kind: "permission_denied", message: /MONGODB_TOOL_ALLOW_WRITES/ });
  const writable = createTestRunner({ environment: { MONGODB_TOOL_ALLOW_WRITES: "1" } });
  const output = await writable.runOperation("aggregate", { collection: "orders", pipeline }, AS_TOOL);
  assert.equal(output.data.wrote_output, true);
  assert.deepEqual(writable.state.calls[0].args[0], pipeline, "no $limit after $merge");
});

test("tool calls may not read system collections or other databases through $lookup/$unionWith", async () => {
  const { runOperation } = createTestRunner();
  for (const stage of [
    { $lookup: { from: "system.users", localField: "a", foreignField: "b", as: "c" } },
    { $unionWith: "system.views" },
    { $unionWith: { coll: "x", db: "admin" } },
    { $lookup: { from: { db: "other", coll: "x" }, as: "c", pipeline: [] } },
  ]) {
    await assert.rejects(runOperation("aggregate", { collection: "orders", pipeline: [stage] }, AS_TOOL), { kind: "permission_denied" });
  }
});

test("tool filters may not use $where or $function anywhere", async () => {
  const { runOperation } = createTestRunner();
  await assert.rejects(runOperation("find", { collection: "orders", filter: { $or: [{ $where: "true" }] } }, AS_TOOL), { kind: "permission_denied" });
  await assert.rejects(
    runOperation("count", { collection: "orders", filter: { $expr: { $function: { body: "x", args: [], lang: "js" } } } }, AS_TOOL),
    { kind: "permission_denied" },
  );
  await assert.rejects(runOperation("find", { collection: "orders", projection: { x: { $function: {} } } }, AS_TOOL), { kind: "permission_denied" });
});

test("tool calls may not use the admin/local/config databases or system.* collections", async () => {
  const { runOperation } = createTestRunner();
  await assert.rejects(runOperation("find", { database: "admin", collection: "users" }, AS_TOOL), { kind: "permission_denied" });
  await assert.rejects(runOperation("find", { collection: "system.users" }, AS_TOOL), { kind: "permission_denied" });
  await assert.rejects(runOperation("list_collections", { database: "local" }, AS_TOOL), { kind: "permission_denied" });
  await runOperation("find", { database: "admin", collection: "system.users" });
});

test("invalid database and collection names are refused", async () => {
  const { runOperation } = createTestRunner();
  await assert.rejects(runOperation("find", { database: "a.b", collection: "orders" }), { kind: "invalid_input" });
  await assert.rejects(runOperation("find", { collection: "or$ders" }), { kind: "invalid_input" });
});

test("database falls back to MONGODB_DATABASE, then the URL path; none is an error", async () => {
  const withSetting = createTestRunner({ environment: { MONGODB_DATABASE: "crm" } });
  await withSetting.runOperation("count", { collection: "leads" });
  assert.equal(withSetting.state.calls[0].database, "crm");
  const withoutDatabase = createTestRunner({ environment: { MONGODB_URL: "mongodb://127.0.0.1:27017" } });
  await assert.rejects(withoutDatabase.runOperation("count", { collection: "leads" }), { kind: "invalid_input", message: /No database/ });
});

test("list_databases and list_collections", async () => {
  const { runOperation, state } = createTestRunner();
  const databases = await runOperation("list_databases", {}, AS_TOOL);
  assert.deepEqual(databases.data.databases, [{ name: "shop", size_on_disk: 8192, empty: false }]);
  const collections = await runOperation("list_collections", {}, AS_TOOL);
  assert.deepEqual(collections.data.collections, [{ name: "orders", type: "collection" }]);
  assert.equal(state.calls.at(-1).args[1].nameOnly, true);
});

const WRITE_CALLS = [
  ["insert_one", { collection: "orders", document: { status: "new" } }],
  ["insert_many", { collection: "orders", documents: [{ status: "new" }] }],
  ["update_one", { collection: "orders", filter: { status: "new" }, update: { $set: { status: "paid" } } }],
  ["update_many", { collection: "orders", filter: { status: "new" }, update: { $set: { status: "paid" } } }],
  ["replace_one", { collection: "orders", filter: { status: "new" }, replacement: { status: "paid" } }],
  ["delete_one", { collection: "orders", filter: { status: "new" } }],
  ["delete_many", { collection: "orders", filter: { status: "new" } }],
];

for (const [operationName, args] of WRITE_CALLS) {
  test(`${operationName}: refused for tools by default, allowed with MONGODB_TOOL_ALLOW_WRITES=1 and for nodes`, async () => {
    const readOnly = createTestRunner();
    await assert.rejects(readOnly.runOperation(operationName, args, AS_TOOL), { kind: "permission_denied", message: /MONGODB_TOOL_ALLOW_WRITES=1/ });
    assert.equal(readOnly.state.loadCount, 0);
    await readOnly.runOperation(operationName, args);
    const writable = createTestRunner({ environment: { MONGODB_TOOL_ALLOW_WRITES: "1" } });
    await writable.runOperation(operationName, args, AS_TOOL);
    assert.equal(writable.state.calls.length, 1);
  });
}

test("insert_one decodes EJSON and returns the encoded _id", async () => {
  const { runOperation, state } = createTestRunner();
  const output = await runOperation("insert_one", { collection: "orders", document: { _id: { $oid: ORDER_ID }, at: { $date: "2026-11-19T00:00:00Z" } } });
  assert.ok(state.calls[0].args[0].at instanceof Date);
  assert.deepEqual(output.data, { inserted_id: { $oid: ORDER_ID }, acknowledged: true });
});

test("insert_many returns ids in order and refuses an empty list", async () => {
  const { runOperation } = createTestRunner();
  const output = await runOperation("insert_many", { collection: "orders", documents: [{ a: 1 }, { a: 2 }] });
  assert.equal(output.data.inserted_count, 2);
  assert.equal(output.data.inserted_ids.length, 2);
  await assert.rejects(runOperation("insert_many", { collection: "orders", documents: [] }), { kind: "invalid_input" });
});

test("update_many and delete_many with an empty filter: tools never, nodes only with allow_all", async () => {
  const { runOperation, state } = createTestRunner({ environment: { MONGODB_TOOL_ALLOW_WRITES: "1" } });
  const updateArgs = { collection: "orders", filter: {}, update: { $set: { archived: true } } };
  await assert.rejects(runOperation("update_many", { ...updateArgs, allow_all: true }, AS_TOOL), { kind: "permission_denied" });
  await assert.rejects(runOperation("delete_many", { collection: "orders", filter: {}, allow_all: true }, AS_TOOL), { kind: "permission_denied" });
  await assert.rejects(runOperation("update_many", updateArgs), { kind: "invalid_input", message: /allow_all/ });
  await assert.rejects(runOperation("delete_many", { collection: "orders", filter: {} }), { kind: "invalid_input", message: /allow_all/ });
  assert.equal(state.calls.length, 0);
  await runOperation("update_many", { ...updateArgs, allow_all: true });
  const deleted = await runOperation("delete_many", { collection: "orders", filter: {}, allow_all: true });
  assert.equal(deleted.data.deleted_count, 3);
});

test("update requires operators; replace refuses them", async () => {
  const { runOperation } = createTestRunner();
  await assert.rejects(runOperation("update_one", { collection: "o", filter: {}, update: { status: "x" } }), { kind: "invalid_input" });
  await assert.rejects(runOperation("replace_one", { collection: "o", filter: {}, replacement: { $set: { a: 1 } } }), { kind: "invalid_input" });
});

test("update results are reported with the upserted id encoded", async () => {
  const { runOperation, state } = createTestRunner({
    writeResult: { update: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: new FakeObjectId(ORDER_ID) } },
  });
  const output = await runOperation("update_one", { collection: "o", filter: { sku: "A1" }, update: { $inc: { stock: 1 } }, upsert: true });
  assert.deepEqual(output.data, { matched_count: 0, modified_count: 0, upserted_count: 1, upserted_id: { $oid: ORDER_ID }, acknowledged: true });
  assert.deepEqual(state.calls[0].args[2], { upsert: true, maxTimeMS: 15000 });
});

test("tool writes may not carry server-side JavaScript either", async () => {
  const { runOperation } = createTestRunner({ environment: { MONGODB_TOOL_ALLOW_WRITES: "1" } });
  await assert.rejects(runOperation("insert_one", { collection: "o", document: { f: { $code: "x" } } }, AS_TOOL), { kind: "permission_denied" });
  await assert.rejects(runOperation("delete_one", { collection: "o", filter: { $where: "true" } }, AS_TOOL), { kind: "permission_denied" });
});

test("driver errors are classified and the password never leaks", async () => {
  const networkError = Object.assign(new Error(`connect ECONNREFUSED while using ${TEST_URL}`), { name: "MongoServerSelectionError" });
  const authError = Object.assign(new Error(`Authentication failed for app:${decodeURIComponent(TEST_PASSWORD)}`), { name: "MongoServerError", code: 18, codeName: "AuthenticationFailed" });
  const timeoutError = Object.assign(new Error("operation exceeded time limit"), { name: "MongoServerError", code: 50 });
  const duplicateError = Object.assign(new Error("E11000 duplicate key"), { name: "MongoServerError", code: 11000 });
  for (const [error, kind, retryable] of [[networkError, "network_error", true], [authError, "auth_error", false], [timeoutError, "timeout", true], [duplicateError, "conflict", false]]) {
    const { runOperation } = createTestRunner({ connectError: error === networkError || error === authError ? error : null, operationError: error });
    await assert.rejects(runOperation("count", { collection: "orders" }), (thrown) => {
      assert.equal(thrown.kind, kind);
      assert.equal(thrown.retryable, retryable);
      assert.ok(!thrown.message.includes(TEST_PASSWORD), thrown.message);
      assert.ok(!thrown.message.includes(decodeURIComponent(TEST_PASSWORD)), thrown.message);
      return true;
    });
  }
});

test("a failed connect is not cached: the next call connects again", async () => {
  const { runOperation, state, definition } = createTestRunner({ connectError: Object.assign(new Error("down"), { name: "MongoServerSelectionError" }) });
  await assert.rejects(runOperation("count", { collection: "orders" }), { kind: "network_error" });
  state.connectError = null;
  await runOperation("count", { collection: "orders" });
  assert.equal(state.clients.length, 2);
  assert.ok(state.clients[0].closed);
  await definition.closeAllClients();
});

test("outputs never contain the connection string", async () => {
  const { runOperation } = createTestRunner({ documents: ORDERS });
  for (const [operationName, args] of [["find", { collection: "orders" }], ["list_databases", {}], ["list_collections", {}]]) {
    const output = await runOperation(operationName, args);
    assert.ok(!JSON.stringify(output).includes(TEST_PASSWORD));
  }
});

test("a cancelled read rejects with cancelled; a cancelled write says it may have been applied", async () => {
  const { runOperation } = createTestRunner({ delayMs: 200 });
  const readController = new AbortController();
  const read = runOperation("count", { collection: "orders" }, { signal: readController.signal });
  setTimeout(() => readController.abort(), 20);
  await assert.rejects(read, { kind: "cancelled" });
  const writeController = new AbortController();
  const write = runOperation("delete_one", { collection: "orders", filter: { a: 1 } }, { signal: writeController.signal });
  setTimeout(() => writeController.abort(), 20);
  await assert.rejects(write, { kind: "cancelled", message: /may already have been applied/ });
});

test("the read signal is passed to the driver", async () => {
  const { runOperation, state } = createTestRunner({ documents: ORDERS });
  const controller = new AbortController();
  await runOperation("find", { collection: "orders" }, { signal: controller.signal });
  assert.equal(state.calls[0].args[1].signal, controller.signal);
});

test("the pooled client is reused, created with bounded timeouts, and closed after the idle period", async () => {
  const scheduled = [];
  const timers = {
    setTimeout: (callback, delayMs) => {
      const handle = { callback, delayMs, cleared: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (handle) handle.cleared = true;
    },
  };
  const { runOperation, state } = createTestRunner({ timers, environment: { MONGODB_IDLE_MINUTES: "2" } });
  await runOperation("count", { collection: "orders" });
  await runOperation("count", { collection: "orders" });
  assert.equal(state.clients.length, 1);
  assert.equal(state.clients[0].options.serverSelectionTimeoutMS, 10000);
  assert.equal(state.clients[0].options.connectTimeoutMS, 10000);
  const idleTimer = scheduled.at(-1);
  assert.equal(idleTimer.delayMs, 120000);
  assert.equal(scheduled[0].cleared, true, "the first idle timer was cancelled by the second call");
  await idleTimer.callback();
  assert.equal(state.clients[0].closed, true);
  await runOperation("count", { collection: "orders" });
  assert.equal(state.clients.length, 2, "a new client after the idle close");
});
