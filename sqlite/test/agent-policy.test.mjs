import { test } from "node:test";
import assert from "node:assert/strict";
import { createShopDatabase, SKIP_WITHOUT_SQLITE, withSqliteRunner } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_SQLITE };

test("execute fails closed when the call has no source (neither node nor tool)", options, () =>
  withSqliteRunner({}, async ({ runOperation, requests }) => {
    await createShopDatabase(runOperation);
    const requestCount = requests.length;
    await assert.rejects(runOperation("execute", { sql: "DELETE FROM items" }), { kind: "permission_denied" });
    await assert.rejects(runOperation("execute", { sql: "DELETE FROM items" }, { source: "something-else" }), { kind: "permission_denied" });
    assert.equal(requests.length, requestCount);
  }));

test("SQLITE_STATEMENT_TIMEOUT_MS is a ceiling for tool calls but not for nodes", options, () =>
  withSqliteRunner({ environment: { SQLITE_STATEMENT_TIMEOUT_MS: "2000" } }, async ({ runOperation, requests }) => {
    await createShopDatabase(runOperation);
    const before = requests.length;
    await runOperation("query", { sql: "SELECT 1", statement_timeout_ms: 600000 }, { source: "tool" });
    await runOperation("query", { sql: "SELECT 1", statement_timeout_ms: 1500 }, { source: "tool" });
    await runOperation("query", { sql: "SELECT 1", statement_timeout_ms: 600000 }, { source: "node" });
    assert.deepEqual(requests.slice(before).map((entry) => entry.options.timeoutMs), [2000, 1500, 600000]);
  }));
