/**
 * Integration tests against a REAL, temporary mongod. Skipped unless
 * MONGODB_INTEGRATION=1, `mongod` is on PATH and the mongodb package is installed:
 *   MONGODB_INTEGRATION=1 node --test test/integration.test.mjs
 *
 * The server runs on a free 127.0.0.1 port with a fresh temp data directory
 * and is stopped (and the directory deleted) afterwards; no existing instance
 * or data is touched.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

const hasMongod = spawnSync("mongod", ["--version"], { stdio: "ignore" }).status === 0;
const hasDriver = await import("mongodb").then(() => true, () => false);
const skipReason = process.env.MONGODB_INTEGRATION !== "1"
  ? "set MONGODB_INTEGRATION=1 to run"
  : !hasMongod ? "mongod is not installed" : !hasDriver ? "run npm install first" : false;

describe("mongodb against a temporary mongod", { skip: skipReason }, () => {
  let server;
  let definition;
  let runOperation;

  before(async () => {
    server = await startTemporaryMongod();
    definition = createPluginDefinition();
    const runner = createOperationRunner(definition, { MONGODB_URL: `mongodb://127.0.0.1:${server.port}/graphrt_test` });
    runOperation = (name, args, source = "node") => runner(name, args, { source });
  });

  after(async () => {
    await definition?.closeAllClients();
    await server?.stop();
  });

  test("insert with ObjectId/Date/Decimal128, then find, count, distinct and aggregate", async () => {
    const inserted = await runOperation("insert_many", {
      collection: "orders",
      documents: [
        { _id: { $oid: "65a1f0c2e4b0a1b2c3d4e5f6" }, city: "Bandung", total: { $numberDecimal: "10.50" }, at: { $date: "2026-01-01T00:00:00Z" } },
        { city: "Bandung", total: { $numberDecimal: "4.25" }, at: { $date: "2026-01-02T00:00:00Z" } },
        { city: "Jakarta", total: { $numberDecimal: "7.00" }, at: { $date: "2026-01-03T00:00:00Z" } },
      ],
    });
    assert.equal(inserted.data.inserted_count, 3);
    assert.deepEqual(inserted.data.inserted_ids[0], { $oid: "65a1f0c2e4b0a1b2c3d4e5f6" });

    const found = await runOperation("find", { collection: "orders", filter: { at: { $gte: { $date: "2026-01-02T00:00:00Z" } } }, sort: { at: 1 }, limit: 1 }, "tool");
    assert.equal(found.data.count, 1);
    assert.deepEqual(found.data.documents[0].total, { $numberDecimal: "4.25" });
    assert.deepEqual(found.data.documents[0].at, { $date: "2026-01-02T00:00:00Z" });
    assert.equal(found.next_cursor, "1");
    const nextPage = await runOperation("find", { collection: "orders", filter: { at: { $gte: { $date: "2026-01-02T00:00:00Z" } } }, sort: { at: 1 }, limit: 1, cursor: found.next_cursor }, "tool");
    assert.equal(nextPage.data.documents[0].city, "Jakarta");
    assert.equal(nextPage.next_cursor, null);

    const one = await runOperation("find_one", { collection: "orders", filter: { _id: { $oid: "65a1f0c2e4b0a1b2c3d4e5f6" } } }, "tool");
    assert.equal(one.data.document.city, "Bandung");
    assert.equal((await runOperation("count", { collection: "orders", filter: { city: "Bandung" } }, "tool")).data.count, 2);
    assert.deepEqual((await runOperation("distinct", { collection: "orders", field: "city" }, "tool")).data.values.sort(), ["Bandung", "Jakarta"]);

    const grouped = await runOperation("aggregate", {
      collection: "orders",
      pipeline: [{ $group: { _id: "$city", total: { $sum: "$total" } } }, { $sort: { _id: 1 } }],
    }, "tool");
    assert.deepEqual(grouped.data.documents, [{ _id: "Bandung", total: { $numberDecimal: "14.75" } }, { _id: "Jakarta", total: { $numberDecimal: "7.00" } }]);
  });

  test("list_databases and list_collections see the temp data", async () => {
    const databases = await runOperation("list_databases", {}, "tool");
    assert.ok(databases.data.databases.some((entry) => entry.name === "graphrt_test"));
    const collections = await runOperation("list_collections", {}, "tool");
    assert.deepEqual(collections.data.collections.map((entry) => entry.name), ["orders"]);
  });

  test("update, replace and delete; empty-filter guard; tool writes refused by default", async () => {
    await assert.rejects(runOperation("delete_many", { collection: "orders", filter: {} }), { kind: "invalid_input" });
    await assert.rejects(runOperation("update_one", { collection: "orders", filter: {}, update: { $set: { x: 1 } } }, "tool"), { kind: "permission_denied" });
    const updated = await runOperation("update_many", { collection: "orders", filter: { city: "Bandung" }, update: { $set: { region: "Jabar" } } });
    assert.deepEqual([updated.data.matched_count, updated.data.modified_count], [2, 2]);
    const upserted = await runOperation("update_one", { collection: "orders", filter: { city: "Medan" }, update: { $set: { total: 1 } }, upsert: true });
    assert.equal(upserted.data.upserted_count, 1);
    assert.ok(upserted.data.upserted_id.$oid);
    const replaced = await runOperation("replace_one", { collection: "orders", filter: { city: "Medan" }, replacement: { city: "Medan", total: 2 } });
    assert.equal(replaced.data.modified_count, 1);
    assert.equal((await runOperation("delete_one", { collection: "orders", filter: { city: "Medan" } })).data.deleted_count, 1);
    await assert.rejects(runOperation("insert_one", { collection: "orders", document: { _id: { $oid: "65a1f0c2e4b0a1b2c3d4e5f6" } } }), { kind: "conflict" });
    const removed = await runOperation("delete_many", { collection: "orders", filter: {}, allow_all: true });
    assert.equal(removed.data.deleted_count, 3);
  });

  test("maxTimeMS stops a slow query with a retryable timeout", async () => {
    await runOperation("insert_one", { collection: "slow", document: { a: 1 } });
    await assert.rejects(
      runOperation("find", { collection: "slow", filter: { $where: "sleep(500) || true" }, max_time_ms: 100 }),
      { kind: "timeout", retryable: true },
    );
  });

  test("review: internal JavaScript operators are refused for tools and nodes; nothing runs", async () => {
    await runOperation("insert_one", { collection: "js", document: { a: 1 } });
    const payloads = [
      ["aggregate", { collection: "js", pipeline: [{ $project: { x: { $_internalJsEmit: { eval: "function(){ emit(this.a, 41 + 1); }", this: "$$ROOT" } } } }] }],
      ["aggregate", { collection: "js", pipeline: [{ $group: { _id: null, x: { $_internalJsReduce: { data: { k: "$a", v: "$a" }, eval: "function(k, vs){ return 1234; }" } } } }] }],
      ["find", { collection: "js", projection: { x: { $_internalJsEmit: { eval: "function(){ emit(1, 2); }", this: "$$ROOT" } } } }],
    ];
    for (const [operationName, args] of payloads) {
      for (const source of ["tool", "node"]) {
        await assert.rejects(runOperation(operationName, args, source), { kind: "permission_denied" }, `${operationName} as ${source}`);
      }
    }
    await assert.rejects(runOperation("aggregate", { collection: "js", pipeline: [{ $collStats: { storageStats: {} } }] }, "tool"), { kind: "permission_denied" });
  });

  test("review: other databases, $out and match-everything filters from tools", async () => {
    await runOperation("insert_one", { database: "graphrt_other", collection: "secret", document: { pw: "hunter2" } });
    await assert.rejects(runOperation("find", { database: "graphrt_other", collection: "secret" }, "tool"), { kind: "permission_denied" });
    await assert.rejects(runOperation("find", { database: "ADMIN", collection: "foo" }, "tool"), { kind: "permission_denied" });
    const writable = createOperationRunner(definition, { MONGODB_URL: `mongodb://127.0.0.1:${server.port}/graphrt_test`, MONGODB_TOOL_ALLOW_WRITES: "1" });
    const runWritable = (name, args) => writable(name, args, { source: "tool" });
    await runOperation("insert_many", { collection: "victims", documents: [{ a: 1 }, { a: 2 }] });
    await assert.rejects(runWritable("aggregate", { collection: "victims", pipeline: [{ $out: { db: "graphrt_other", coll: "secret" } }] }), { kind: "permission_denied" });
    await assert.rejects(runWritable("aggregate", { collection: "victims", pipeline: [{ $merge: { into: { db: "graphrt_other", coll: "secret" } } }] }), { kind: "permission_denied" });
    await assert.rejects(runWritable("delete_many", { collection: "victims", filter: { $and: [{}] } }), { kind: "permission_denied" });
    await assert.rejects(runWritable("update_many", { collection: "victims", filter: { $expr: true }, update: { $set: { z: 1 } } }), { kind: "permission_denied" });
    assert.equal((await runOperation("count", { collection: "victims" })).data.count, 2);
    const secret = await runOperation("find", { database: "graphrt_other", collection: "secret" });
    assert.deepEqual(secret.data.documents.map((document) => document.pw), ["hunter2"]);
  });

  test("inserts accept max_time_ms", async () => {
    const inserted = await runOperation("insert_one", { collection: "timed", document: { a: 1 }, max_time_ms: 5000 });
    assert.ok(inserted.data.inserted_id.$oid);
  });

  test("server errors for bad input come back as invalid_input", async () => {
    await assert.rejects(runOperation("aggregate", { collection: "orders", pipeline: [{ $nosuchstage: {} }] }), { kind: "invalid_input" });
  });
});

describe("mongodb against an unused port", { skip: process.env.MONGODB_INTEGRATION !== "1" ? "set MONGODB_INTEGRATION=1 to run" : hasDriver ? false : "run npm install first" }, () => {
  test("reports a retryable network_error with the password redacted", async () => {
    const port = await findFreePort();
    const definition = createPluginDefinition();
    const runner = createOperationRunner(definition, { MONGODB_URL: `mongodb://app:Sup3rSecret@127.0.0.1:${port}/x?serverSelectionTimeoutMS=500` });
    await assert.rejects(runner("count", { collection: "orders" }, { source: "tool" }), (error) => {
      assert.equal(error.kind, "network_error");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /Sup3rSecret/);
      return true;
    });
    await definition.closeAllClients();
  });
});

async function startTemporaryMongod() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "graphrt-mongod-"));
  const port = await findFreePort();
  const child = spawn("mongod", ["--port", String(port), "--bind_ip", "127.0.0.1", "--dbpath", dataDirectory, "--logpath", join(dataDirectory, "mongod.log"), "--nounixsocket"], {
    stdio: "ignore",
  });
  await waitForPort(port, 30000);
  return {
    port,
    async stop() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, timeoutMs) {
  const { connect } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const isOpen = await new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => socket.end(() => resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (isOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`mongod did not listen on ${port} within ${timeoutMs} ms`);
}
