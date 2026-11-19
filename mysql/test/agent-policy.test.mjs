import { test } from "node:test";
import assert from "node:assert/strict";
import { withRunner } from "./helpers.mjs";

test("execute fails closed when the call has no source (neither node nor tool)", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("execute", { sql: "DELETE FROM items" }), { kind: "permission_denied" });
    await assert.rejects(runOperation("execute", { sql: "DELETE FROM items" }, { source: "something-else" }), { kind: "permission_denied" });
    assert.equal(log.pools.length, 0);
  }));

test("MYSQL_STATEMENT_TIMEOUT_MS is a ceiling for tool calls but not for nodes", () =>
  withRunner({ environment: { MYSQL_STATEMENT_TIMEOUT_MS: "2000" } }, async ({ runOperation, log }) => {
    await runOperation("query", { sql: "SELECT 1", timeout_ms: 600000 }, { source: "tool" });
    await runOperation("query", { sql: "SELECT 1", timeout_ms: 1500 }, { source: "tool" });
    await runOperation("query", { sql: "SELECT 1", timeout_ms: 600000 }, { source: "node" });
    const timeouts = log.statements.filter((entry) => entry.sql.includes("max_execution_time")).map((entry) => entry.values[0]);
    assert.deepEqual(timeouts, [2000, 1500, 600000]);
  }));
