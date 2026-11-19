/**
 * Opt-in test against a real MySQL / MariaDB server. It runs only when
 * MYSQL_INTEGRATION_URL points at a disposable database (and `npm install`
 * was run); it creates one uniquely named table there and drops it at the end.
 *
 *   MYSQL_INTEGRATION_URL=mysql://scratch_user:pass@127.0.0.1:3306/scratch node --test test/integration.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

const integrationUrl = process.env.MYSQL_INTEGRATION_URL;
const isMysqlInstalled = await import("mysql2").then(() => true, () => false);
const skipReason = !integrationUrl ? "MYSQL_INTEGRATION_URL is not set" : !isMysqlInstalled ? "mysql2 is not installed (npm install)" : false;

test("real server: write as node, read-only query as tool (DML and DDL refused), caps, timeout and schema", { skip: skipReason }, async () => {
  const definition = createPluginDefinition();
  const runOperation = createOperationRunner(definition, { MYSQL_URL: integrationUrl });
  const tableName = `graphrt_it_${randomBytes(4).toString("hex")}`;
  const asNode = { source: "node" };
  const asTool = { source: "tool" };
  try {
    await runOperation("execute", { sql: `CREATE TABLE ${tableName} (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL, price DECIMAL(10,2))` }, asNode);
    const inserted = await runOperation("execute", { sql: `INSERT INTO ${tableName} (name, price) VALUES (?, ?), (?, ?)`, params: ["kopi", "12.50", "teh", "8.00"] }, asNode);
    assert.equal(inserted.data.affected_rows, 2);

    const read = await runOperation("query", { sql: `SELECT name, price FROM ${tableName} ORDER BY id`, max_rows: 1 }, asTool);
    assert.deepEqual(read.data.rows, [{ name: "kopi", price: "12.50" }]);
    assert.equal(read.data.truncated, true);

    await assert.rejects(runOperation("query", { sql: `DELETE FROM ${tableName}` }, asTool), { kind: "permission_denied" });
    await assert.rejects(runOperation("query", { sql: `DROP TABLE ${tableName}` }, asTool), { kind: "permission_denied" });
    await assert.rejects(runOperation("query", { sql: `CREATE TABLE ${tableName}_evil (x INT)` }, asTool), { kind: "permission_denied" });
    await assert.rejects(runOperation("query", { sql: "SELECT 1; SELECT 2" }, asTool), { kind: "invalid_input" });
    await assert.rejects(
      runOperation("query", { sql: "SELECT count(*) FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c", timeout_ms: 200 }, asTool),
      { kind: "timeout" },
    );
    const count = await runOperation("query", { sql: `SELECT count(*) AS n FROM ${tableName}` }, asTool);
    assert.equal(count.data.rows[0].n, "2");

    const description = await runOperation("describe_table", { table: tableName }, asTool);
    assert.deepEqual(description.data.primary_key, ["id"]);
    const tables = await runOperation("list_tables", {}, asTool);
    assert.ok(tables.data.tables.some((table) => table.name === tableName));
    assert.ok(!tables.data.tables.some((table) => table.name === `${tableName}_evil`));
  } finally {
    await runOperation("execute", { sql: `DROP TABLE IF EXISTS ${tableName}` }, asNode).catch(() => {});
    await runOperation("execute", { sql: `DROP TABLE IF EXISTS ${tableName}_evil` }, asNode).catch(() => {});
    await definition.closeAllConnections();
  }
});

/**
 * Runs `work` with a node/tool runner and a fresh table, dropping the table (and procedure) afterwards.
 */
async function withScratchTable(environment, work) {
  const definition = createPluginDefinition({ logWarning: () => {} });
  const runOperation = createOperationRunner(definition, { MYSQL_URL: integrationUrl, ...environment });
  const tableName = `graphrt_it_${randomBytes(4).toString("hex")}`;
  try {
    await runOperation("execute", { sql: `CREATE TABLE ${tableName} (id INT PRIMARY KEY)` }, { source: "node" });
    return await work({ runOperation, tableName });
  } finally {
    await runOperation("execute", { sql: `DROP PROCEDURE IF EXISTS ${tableName}_writer` }, { source: "node" }).catch(() => {});
    await runOperation("execute", { sql: `DROP TABLE IF EXISTS ${tableName}` }, { source: "node" }).catch(() => {});
    await definition.closeAllConnections();
  }
}

test("real server: an agent cannot CALL a procedure that commits and writes from a read-only query", { skip: skipReason }, () =>
  withScratchTable({}, async ({ runOperation, tableName }) => {
    const procedureBody = `BEGIN COMMIT; START TRANSACTION READ WRITE; INSERT INTO ${tableName} VALUES (99); COMMIT; END`;
    await runOperation("execute", { sql: `CREATE PROCEDURE ${tableName}_writer() ${procedureBody}` }, { source: "node" });
    for (const sql of [`CALL ${tableName}_writer()`, `;CALL ${tableName}_writer()`, `/*!50000 CALL ${tableName}_writer() */`, `-- c\n call ${tableName}_writer()`]) {
      await assert.rejects(runOperation("query", { sql }, { source: "tool" }), { kind: "permission_denied" }, sql);
    }
    const count = await runOperation("query", { sql: `SELECT COUNT(*) AS n FROM ${tableName}` }, { source: "tool" });
    assert.equal(count.data.rows[0].n, "0");
  }));

test("real server: rows far larger on the wire than in JSON trip the socket budget", { skip: skipReason }, () =>
  withScratchTable({ MYSQL_MAX_RESULT_BYTES: "8000000" }, async ({ runOperation }) => {
    // 1 MB BLOBs become 64 KiB (cut, base64) in the result: 80 rows fit the JSON cap but are 80 MB on the wire.
    const sql = "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 80) SELECT REPEAT(x'61', 1000000) AS b FROM s";
    const output = await runOperation("query", { sql }, { source: "tool" });
    assert.equal(output.data.truncated, true);
    assert.equal(output.data.truncated_reason, "max_bytes");
    assert.ok(output.data.row_count < 40, `rows: ${output.data.row_count}`);
    const afterwards = await runOperation("query", { sql: "SELECT 1 AS ok" }, { source: "tool" });
    assert.equal(afterwards.data.rows[0].ok, "1");
  }));

test("real server: 200 rows of 2 MB stay within the byte cap without buffering them all", { skip: skipReason }, () =>
  withScratchTable({}, async ({ runOperation }) => {
    const rssBefore = process.memoryUsage().rss;
    const sql = "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 200) SELECT REPEAT('x', 2000000) AS t FROM s";
    const output = await runOperation("query", { sql }, { source: "tool" });
    assert.equal(output.data.truncated_reason, "max_bytes");
    assert.equal(output.data.row_count, 0);
    assert.ok(process.memoryUsage().rss - rssBefore < 100 * 1024 * 1024);
  }));
