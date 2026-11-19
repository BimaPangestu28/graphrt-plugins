/**
 * Review follow-ups: operator allowlist for tool calls, `$_` internals refused
 * everywhere, mass-change guards, and the tool database allowlist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../lib/shared/operations.mjs";
import { isMatchEverythingFilter } from "../lib/query-guard.mjs";
import { pluginDefinition } from "../definition.mjs";
import { createTestRunner } from "./helpers.mjs";

const AS_TOOL = { source: "tool" };
const WRITABLE = { MONGODB_TOOL_ALLOW_WRITES: "1" };

// The reviewer's payloads: server-side JavaScript through internal operators (ran on 8.0.4).
const INTERNAL_JS_CALLS = [
  ["aggregate $project $_internalJsEmit", "aggregate", { collection: "js", pipeline: [{ $project: { x: { $_internalJsEmit: { eval: "function(){ emit(this.a, 41 + 1); }", this: "$$ROOT" } } } }] }],
  ["aggregate $group $_internalJsReduce", "aggregate", { collection: "js", pipeline: [{ $group: { _id: null, x: { $_internalJsReduce: { data: { k: "$a", v: "$a" }, eval: "function(k, vs){ return 1234; }" } } } }] }],
  ["find projection $_internalJsEmit", "find", { collection: "js", projection: { x: { $_internalJsEmit: { eval: "function(){ emit(1, 2); }", this: "$$ROOT" } } } }],
];

for (const [caseName, operationName, args] of INTERNAL_JS_CALLS) {
  test(`tool refuses ${caseName}`, async () => {
    const { runOperation, state } = createTestRunner();
    await assert.rejects(runOperation(operationName, args, AS_TOOL), { kind: "permission_denied" });
    assert.equal(state.calls.length, 0);
  });

  test(`node also refuses ${caseName} ($_ internals are never allowed)`, async () => {
    const { runOperation, state } = createTestRunner();
    await assert.rejects(runOperation(operationName, args), { kind: "permission_denied", message: /internal/ });
    assert.equal(state.calls.length, 0);
  });
}

test("tool calls may only use allowlisted stages and operators", async () => {
  const { runOperation } = createTestRunner();
  for (const pipeline of [[{ $collStats: { storageStats: {} } }], [{ $planCacheStats: {} }], [{ $currentOp: {} }], [{ $facet: { a: [{ $indexStats: {} }] } }]]) {
    await assert.rejects(runOperation("aggregate", { collection: "orders", pipeline }, AS_TOOL), { kind: "permission_denied" }, JSON.stringify(pipeline));
  }
  await assert.rejects(runOperation("find", { collection: "orders", filter: { a: { $futureOperator: 1 } } }, AS_TOOL), { kind: "permission_denied", message: /\$futureOperator/ });
  await assert.rejects(runOperation("insert_one", { collection: "orders", document: { f: { $unknownWrapper: 1 } } }, { source: "tool" }), { kind: "permission_denied" });
});

test("ordinary queries, pipelines, updates and EJSON values stay allowed for tools", async () => {
  const { runOperation } = createTestRunner({ environment: WRITABLE });
  await runOperation("find", {
    collection: "orders",
    filter: { $or: [{ status: { $in: ["paid", "new"] } }, { total: { $gte: { $numberDecimal: "10" } } }], created: { $lt: { $date: "2026-01-01T00:00:00Z" } }, $expr: { $gt: ["$a", "$b"] } },
    projection: { items: { $slice: 2 }, name: 1 },
    sort: { created: -1 },
  }, AS_TOOL);
  await runOperation("aggregate", {
    collection: "orders",
    pipeline: [
      { $match: { _id: { $oid: "65a1f0c2e4b0a1b2c3d4e5f6" } } },
      { $lookup: { from: "customers", localField: "c", foreignField: "_id", as: "customer", pipeline: [{ $project: { name: 1 } }] } },
      { $unwind: "$customer" },
      { $group: { _id: { $dateTrunc: { date: "$created", unit: "day" } }, total: { $sum: "$total" }, top: { $topN: { n: 3, sortBy: { total: -1 }, output: "$_id" } } } },
      { $setWindowFields: { sortBy: { _id: 1 }, output: { running: { $sum: "$total", window: { documents: ["unbounded", "current"] } } } } },
      { $facet: { counts: [{ $count: "n" }], sample: [{ $sample: { size: 1 } }] } },
    ],
  }, AS_TOOL);
  await runOperation("update_one", { collection: "orders", filter: { a: 1 }, update: { $set: { q: { $literal: 1 } }, $push: { log: { $each: ["x"], $slice: -10 } }, $currentDate: { at: true } } }, AS_TOOL);
});

test("$out is a mass change: refused for tool calls even with writes enabled", async () => {
  const { runOperation, state } = createTestRunner({ environment: WRITABLE });
  await assert.rejects(runOperation("aggregate", { collection: "orders", pipeline: [{ $out: "o2" }] }, AS_TOOL), { kind: "permission_denied", message: /\$out/ });
  assert.equal(state.calls.length, 0);
  await runOperation("aggregate", { collection: "orders", pipeline: [{ $out: "o2" }] });
});

test("$merge targets are checked like $lookup targets", async () => {
  const { runOperation, state } = createTestRunner({ environment: WRITABLE });
  for (const into of [{ db: "other", coll: "secret" }, { db: "admin", coll: "pwned" }, "system.views"]) {
    await assert.rejects(runOperation("aggregate", { collection: "orders", pipeline: [{ $merge: { into } }] }, AS_TOOL), { kind: "permission_denied" }, JSON.stringify(into));
  }
  assert.equal(state.calls.length, 0);
  await runOperation("aggregate", { collection: "orders", pipeline: [{ $merge: { into: "summary" } }] }, AS_TOOL);
  await runOperation("aggregate", { collection: "orders", pipeline: [{ $merge: { into: { db: "shop", coll: "summary" } } }] }, AS_TOOL);
});

for (const filter of [{}, { $and: [] }, { $and: [{}] }, { $or: [{}] }, { $expr: true }, { $or: [{ a: 1 }, { $and: [{}] }] }, { $comment: "x" }]) {
  test(`update_many/delete_many treat ${JSON.stringify(filter)} as an empty filter`, async () => {
    const { runOperation, state } = createTestRunner({ environment: WRITABLE });
    await assert.rejects(runOperation("delete_many", { collection: "orders", filter, allow_all: true }, AS_TOOL), { kind: "permission_denied" });
    await assert.rejects(runOperation("update_many", { collection: "orders", filter, update: { $set: { z: 1 } } }), { kind: "invalid_input", message: /allow_all/ });
    assert.equal(state.calls.length, 0);
  });
}

test("isMatchEverythingFilter keeps real filters", () => {
  for (const filter of [{ a: 1 }, { $and: [{}, { a: 1 }] }, { $or: [{ a: 1 }] }, { $expr: "$flag" }, { $expr: false }, { $nor: [{}] }]) {
    assert.equal(isMatchEverythingFilter(filter), false, JSON.stringify(filter));
  }
});

test("tool calls may only use the default database plus MONGODB_TOOL_ALLOWED_DATABASES", async () => {
  const defaultOnly = createTestRunner();
  await assert.rejects(defaultOnly.runOperation("find", { database: "other", collection: "secret" }, AS_TOOL), { kind: "permission_denied", message: /MONGODB_TOOL_ALLOWED_DATABASES/ });
  await defaultOnly.runOperation("find", { database: "shop", collection: "orders" }, AS_TOOL);
  await defaultOnly.runOperation("find", { database: "other", collection: "secret" });
  const listed = createTestRunner({ environment: { MONGODB_TOOL_ALLOWED_DATABASES: "crm, reports" } });
  await listed.runOperation("find", { database: "crm", collection: "leads" }, AS_TOOL);
  await assert.rejects(listed.runOperation("find", { database: "other", collection: "x" }, AS_TOOL), { kind: "permission_denied" });
  const any = createTestRunner({ environment: { MONGODB_TOOL_ALLOWED_DATABASES: "*" } });
  await any.runOperation("find", { database: "other", collection: "x" }, AS_TOOL);
  for (const internal of ["admin", "Admin", "ADMIN", "local", "Config"]) {
    await assert.rejects(any.runOperation("find", { database: internal, collection: "foo" }, AS_TOOL), { kind: "permission_denied" }, internal);
  }
});

test("$lookup/$unionWith into another database follow the same allowlist", async () => {
  const pipeline = [{ $lookup: { from: { db: "crm", coll: "leads" }, pipeline: [], as: "x" } }];
  const defaultOnly = createTestRunner();
  await assert.rejects(defaultOnly.runOperation("aggregate", { collection: "orders", pipeline }, AS_TOOL), { kind: "permission_denied" });
  const listed = createTestRunner({ environment: { MONGODB_TOOL_ALLOWED_DATABASES: "crm" } });
  await listed.runOperation("aggregate", { collection: "orders", pipeline }, AS_TOOL);
  await assert.rejects(listed.runOperation("aggregate", { collection: "orders", pipeline: [{ $unionWith: { coll: "x", db: "admin" } }] }, AS_TOOL), { kind: "permission_denied" });
});

test("list_databases for tool calls only shows allowed databases", async () => {
  const databases = [{ name: "shop" }, { name: "crm" }, { name: "other" }, { name: "admin" }].map((entry) => ({ ...entry, sizeOnDisk: 1, empty: false }));
  const listed = createTestRunner({ databases, environment: { MONGODB_TOOL_ALLOWED_DATABASES: "crm" } });
  assert.deepEqual((await listed.runOperation("list_databases", {}, AS_TOOL)).data.databases.map((entry) => entry.name), ["shop", "crm"]);
  assert.equal((await listed.runOperation("list_databases", {})).data.databases.length, 4);
  const any = createTestRunner({ databases, environment: { MONGODB_TOOL_ALLOWED_DATABASES: "*" } });
  assert.deepEqual((await any.runOperation("list_databases", {}, AS_TOOL)).data.databases.map((entry) => entry.name), ["shop", "crm", "other"]);
});

test("MONGODB_TOOL_ALLOWED_DATABASES is declared and validated", async () => {
  assert.ok(buildManifest(pluginDefinition).permissions.env.includes("MONGODB_TOOL_ALLOWED_DATABASES"));
  const { runOperation } = createTestRunner({ environment: { MONGODB_TOOL_ALLOWED_DATABASES: "ok, bad.name" } });
  await assert.rejects(runOperation("count", { collection: "orders" }), { kind: "invalid_input", message: /MONGODB_TOOL_ALLOWED_DATABASES/ });
});

test("distinct, listDatabases and writes get the abort signal; inserts get maxTimeMS", async () => {
  const { runOperation, state } = createTestRunner({ documents: [{ status: "a" }] });
  const { signal } = new AbortController();
  await runOperation("distinct", { collection: "orders", field: "status" }, { signal });
  assert.equal(state.calls.at(-1).args[2].signal, signal);
  await runOperation("list_databases", {}, { signal });
  assert.equal(state.calls.at(-1).args[0].signal, signal);
  await runOperation("insert_one", { collection: "orders", document: { a: 1 }, max_time_ms: 2000 }, { signal });
  assert.deepEqual(state.calls.at(-1).args[1], { maxTimeMS: 2000, signal });
  await runOperation("insert_many", { collection: "orders", documents: [{ a: 1 }] }, { signal });
  assert.deepEqual(state.calls.at(-1).args[1], { ordered: true, maxTimeMS: 15000, signal });
  await runOperation("delete_one", { collection: "orders", filter: { a: 1 } }, { signal });
  assert.equal(state.calls.at(-1).args[1].signal, signal);
});

test("the tool deadline leaves room for server selection plus max_time_ms", () => {
  const { limits } = buildManifest(pluginDefinition);
  // 10 s server selection (connecting included) + 60 s max_time_ms + reply transfer < timeout_ms - 10 s tool margin.
  assert.ok(limits.timeout_ms - 10_000 >= 10_000 + 60_000 + 10_000, String(limits.timeout_ms));
});
