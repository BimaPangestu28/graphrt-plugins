/**
 * Tests for the real worker process: these fork Node, so they also prove that a
 * runaway statement is stopped by killing the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWorkerLauncher, isNodeSqliteAvailable } from "../lib/worker-launcher.mjs";
import { createShopDatabase, SKIP_WITHOUT_SQLITE, withSqliteRunner } from "./helpers.mjs";

const AS_TOOL = { source: "tool" };
const ENDLESS_COUNT = "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s) SELECT count(*) FROM s";

test("node:sqlite needs Node.js 22.13+", async () => {
  assert.equal(isNodeSqliteAvailable("22.12.0"), false);
  assert.equal(isNodeSqliteAvailable("22.13.0"), true);
  assert.equal(isNodeSqliteAvailable("24.1.0"), true);
  assert.equal(isNodeSqliteAvailable("20.19.0"), false);
  const launchOnOldNode = createWorkerLauncher({ nodeVersion: "20.19.0", fork: () => assert.fail("must not fork") });
  await assert.rejects(launchOnOldNode({ mode: "read" }, { timeoutMs: 1000 }), { kind: "setup_required", message: /22\.13/ });
});

test("the worker's stdout is ignored so it can never write into the plugin protocol", async () => {
  let forkOptions = null;
  const fakeChild = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {}, send() { setImmediate(() => fakeChild.emit("message", { ok: true, results: [] })); } });
  const launch = createWorkerLauncher({ fork: (_path, _args, options) => { forkOptions = options; return fakeChild; } });
  await launch({ mode: "read" }, { timeoutMs: 1000 });
  assert.deepEqual(forkOptions.stdio.slice(0, 2), ["ignore", "ignore"]);
});

test("real worker: query works, an endless statement is killed at the timeout, and cancel kills it too", { skip: SKIP_WITHOUT_SQLITE }, async () => {
  await withSqliteRunner({ launchWorker: createWorkerLauncher() }, async ({ runOperation }) => {
    await createShopDatabase(runOperation);
    const output = await runOperation("query", { sql: "SELECT name FROM items ORDER BY id" }, AS_TOOL);
    assert.deepEqual(output.data.rows, [{ name: "kopi" }, { name: "teh" }]);

    const timeoutStartedAt = Date.now();
    await assert.rejects(runOperation("query", { sql: ENDLESS_COUNT, timeout_ms: 300 }, AS_TOOL), { kind: "timeout" });
    assert.ok(Date.now() - timeoutStartedAt < 3000);

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 200);
    await assert.rejects(runOperation("query", { sql: ENDLESS_COUNT }, { source: "node", signal: abortController.signal }), { kind: "cancelled" });

    await assert.rejects(runOperation("query", { sql: "DELETE FROM items" }, AS_TOOL), { kind: "permission_denied" });
    await assert.rejects(runOperation("query", { sql: "SELECT * FROM nope" }, AS_TOOL), { kind: "not_found" });
    await assert.rejects(runOperation("query", { sql: ";;ATTACH '/etc/hosts' AS h" }, AS_TOOL), { kind: "permission_denied", message: /ATTACH/ });
  });
});
