import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { statementTexts, TEST_PASSWORD, TEST_URL, withRunner } from "./helpers.mjs";

const AS_NODE = { source: "node" };
const AS_TOOL = { source: "tool" };
const BINARY_CHARSET = 63;

function serverError(errno, sqlState, sqlMessage) {
  return Object.assign(new Error(sqlMessage), { errno, sqlState, sqlMessage, code: "ER_TEST" });
}

test("manifest: five operations are tools, connection and policy env declared, network and secrets allowed", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["query", "execute", "explain", "list_tables", "describe_table"]);
  for (const variableName of ["MYSQL_URL", "MYSQL_HOST", "MYSQL_PASSWORD", "MYSQL_TOOL_ALLOW_WRITES", "MYSQL_STATEMENT_TIMEOUT_MS", "MYSQL_MAX_RESULT_BYTES"]) {
    assert.ok(manifest.permissions.env.includes(variableName), variableName);
  }
  assert.equal(manifest.permissions.network, true);
  assert.ok(manifest.nodes.every((node) => node.config_schema.properties.access_token));
});

test("pool options: exact numbers and dates as strings, one statement per call, no LOCAL INFILE, reset on release", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await runOperation("query", { sql: "SELECT 1" }, AS_TOOL);
    const { options } = log.pools[0];
    assert.equal(options.host, "db.example.com");
    assert.equal(options.user, "app");
    assert.equal(options.password, TEST_PASSWORD);
    assert.equal(options.database, "shop");
    assert.equal(options.multipleStatements, false);
    assert.deepEqual(options.flags, ["-LOCAL_FILES"]);
    assert.equal(options.supportBigNumbers && options.bigNumberStrings && options.dateStrings, true);
    assert.equal(options.resetOnRelease, true);
    assert.equal(options.connectTimeout, 10000);
  }));

test("query: session and transaction are read-only, timeout set, statement prepared when it has params, rolled back", () =>
  withRunner(
    { scenario: { statement: { fields: [["id", 8], ["name", 253], ["raw", 253, BINARY_CHARSET], ["ts", 7], ["made", 12]], rows: [["9007199254740993", "kopi", Buffer.from("abc"), "2026-11-19 03:00:00.500", "2026-11-19 10:00:00"]] } } },
    async ({ runOperation, log }) => {
      const output = await runOperation("query", { sql: "SELECT id, name, raw, ts, made FROM items WHERE name = ?", params: ["kopi"], timeout_ms: 1500 }, AS_TOOL);
      assert.deepEqual(statementTexts(log), [
        "SET SESSION TRANSACTION READ ONLY",
        "SET SESSION max_execution_time = ?, time_zone = '+00:00'",
        "START TRANSACTION READ ONLY",
        "SELECT id, name, raw, ts, made FROM items WHERE name = ?",
        "ROLLBACK",
      ]);
      assert.deepEqual(log.statements[1].values, [1500]);
      assert.equal(log.statements[3].protocol, "execute");
      assert.deepEqual(log.statements[3].values, ["kopi"]);
      assert.equal(log.statements[3].rowsAsArray, true);
      assert.deepEqual(output.data, {
        fields: [{ name: "id", type: "bigint" }, { name: "name", type: "varchar" }, { name: "raw", type: "varbinary" }, { name: "ts", type: "timestamp" }, { name: "made", type: "datetime" }],
        rows: [{ id: "9007199254740993", name: "kopi", raw: "YWJj", ts: "2026-11-19T03:00:00.500Z", made: "2026-11-19T10:00:00" }],
        row_count: 1,
        truncated: false,
      });
      assert.equal(log.connections[0].state, "released");
    },
  ));

test("query without params uses the text protocol", () =>
  withRunner({ scenario: { statement: { fields: [["n", 8]], rows: [["1"]] } } }, async ({ runOperation, log }) => {
    await runOperation("query", { sql: "SELECT 1 AS n" }, AS_TOOL);
    assert.equal(log.statements[3].protocol, "query");
  }));

test("query at the row cap stops reading and destroys the connection (the server rolls back)", () =>
  withRunner({ scenario: { statement: { fields: [["n", 3]], rows: Array.from({ length: 100 }, (_unused, index) => [index]) } } }, async ({ runOperation, log }) => {
    const output = await runOperation("query", { sql: "SELECT n FROM numbers", max_rows: 2 }, AS_TOOL);
    assert.deepEqual(output.data.rows, [{ n: 0 }, { n: 1 }]);
    assert.equal(output.data.truncated, true);
    assert.equal(output.data.truncated_reason, "max_rows");
    assert.equal(log.connections[0].state, "destroyed");
    assert.ok(!statementTexts(log).includes("ROLLBACK"));
  }));

test("query at the byte cap reports max_bytes", () =>
  withRunner({ environment: { MYSQL_MAX_RESULT_BYTES: "1000" }, scenario: { statement: { fields: [["t", 253]], rows: Array.from({ length: 20 }, () => ["x".repeat(200)]) } } }, async ({ runOperation }) => {
    const output = await runOperation("query", { sql: "SELECT t FROM big" }, AS_TOOL);
    assert.equal(output.data.truncated_reason, "max_bytes");
    assert.ok(output.data.row_count > 0 && output.data.row_count < 20);
  }));

test("a write or DDL inside query is refused by the server (1792) → permission_denied, connection kept", () =>
  withRunner({ scenario: { statement: { error: serverError(1792, "25006", "Cannot execute statement in a READ ONLY transaction.") } } }, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("query", { sql: "DROP TABLE items" }, AS_TOOL), (error) => {
      assert.equal(error.kind, "permission_denied");
      assert.match(error.message, /READ ONLY transaction\. This call/);
      return true;
    });
    assert.equal(statementTexts(log).at(-1), "ROLLBACK");
    assert.equal(log.connections[0].state, "released");
  }));

test("max_execution_time exceeded (3024) → timeout", () =>
  withRunner({ scenario: { statement: { error: serverError(3024, "HY000", "Query execution was interrupted, maximum statement execution time exceeded") } } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT heavy()", timeout_ms: 250 }, AS_TOOL), { kind: "timeout", message: /250 ms/ });
  }));

test("MariaDB: unknown max_execution_time falls back to max_statement_time in seconds", () =>
  withRunner(
    { scenario: { onSimple: (sql) => { if (sql.includes("max_execution_time")) throw serverError(1193, "HY000", "Unknown system variable 'max_execution_time'"); } } },
    async ({ runOperation, log }) => {
      await runOperation("query", { sql: "SELECT 1", timeout_ms: 2500 }, AS_TOOL);
      const fallback = log.statements.find((entry) => entry.sql.includes("max_statement_time"));
      assert.deepEqual(fallback.values, [2.5]);
    },
  ));

test("execute is refused for agent tool calls unless MYSQL_TOOL_ALLOW_WRITES=1, before connecting", async () => {
  await withRunner({}, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("execute", { sql: "DELETE FROM items" }, AS_TOOL), { kind: "permission_denied", message: /MYSQL_TOOL_ALLOW_WRITES=1/ });
    assert.equal(log.pools.length, 0);
  });
  await withRunner({ environment: { MYSQL_TOOL_ALLOW_WRITES: "1" }, scenario: { statement: { header: { affectedRows: 3 } } } }, async ({ runOperation }) => {
    const output = await runOperation("execute", { sql: "DELETE FROM items" }, AS_TOOL);
    assert.equal(output.data.affected_rows, 3);
  });
});

test("execute from a node: read-write session, prepared statement, JSON and boolean params converted, header reported", () =>
  withRunner({ scenario: { statement: { header: { affectedRows: 1, changedRows: 0, insertId: 42, warningStatus: 0 } } } }, async ({ runOperation, log }) => {
    const output = await runOperation("execute", { sql: "INSERT INTO items (name, meta, flag) VALUES (?, ?, ?)", params: ["teh", { a: 1 }, true] }, AS_NODE);
    assert.deepEqual(statementTexts(log), ["SET SESSION TRANSACTION READ WRITE", "SET SESSION time_zone = '+00:00'", "INSERT INTO items (name, meta, flag) VALUES (?, ?, ?)"]);
    assert.deepEqual(log.statements[2].values, ["teh", '{"a":1}', 1]);
    assert.deepEqual(output.data, { affected_rows: 1, changed_rows: 0, insert_id: "42", warning_count: 0, rows: [], returned_row_count: 0, fields: [], truncated: false });
  }));

test("a write that loses its connection is never retryable", () =>
  withRunner({ scenario: { statement: { error: Object.assign(new Error("Connection lost: The server closed the connection."), { code: "PROTOCOL_CONNECTION_LOST", fatal: true }) } } }, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("execute", { sql: "UPDATE items SET name = ?", params: ["x"] }, AS_NODE), (error) => {
      assert.equal(error.kind, "network_error");
      assert.equal(error.retryable, false);
      assert.match(error.message, /may or may not have been applied/);
      return true;
    });
    assert.equal(log.connections[0].state, "destroyed");
  }));

test("cancelling a running query sends KILL QUERY for its thread and destroys the connection", () =>
  withRunner({ scenario: { statement: { hold: true } } }, async ({ runOperation, log }) => {
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 20);
    await assert.rejects(runOperation("query", { sql: "SELECT SLEEP(60)" }, { source: "node", signal: abortController.signal }), { kind: "cancelled" });
    assert.deepEqual(log.killQueries, [{ sql: "KILL QUERY ?", values: [7] }]);
    assert.equal(log.connections[0].state, "destroyed");
  }));

test("connection errors are redacted and network failures on reads are retryable", () =>
  withRunner(
    { scenario: { connectError: Object.assign(new Error(`connect ECONNREFUSED ${TEST_URL} ${TEST_PASSWORD}`), { code: "ECONNREFUSED" }) } },
    async ({ runOperation }) => {
      await assert.rejects(runOperation("query", { sql: "SELECT 1" }, AS_TOOL), (error) => {
        assert.equal(error.kind, "network_error");
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.message, /S3cret/);
        return true;
      });
    },
  ));

test("access denied (1045) → auth_error", () =>
  withRunner({ scenario: { connectError: serverError(1045, "28000", "Access denied for user 'app'@'10.0.0.1' (using password: YES)") } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT 1" }, AS_TOOL), { kind: "auth_error" });
  }));

test("URL query parameters are not passed to mysql2; ssl-mode is honoured", () =>
  withRunner({ environment: { MYSQL_URL: `${TEST_URL}?multipleStatements=true&ssl-mode=REQUIRED` } }, async ({ runOperation, log }) => {
    await runOperation("query", { sql: "SELECT 1" }, AS_TOOL);
    assert.equal(log.pools[0].options.multipleStatements, false);
    assert.deepEqual(log.pools[0].options.ssl, { rejectUnauthorized: false });
  }));

test("a node's access_token URL replaces MYSQL_URL; tools cannot pass one", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await runOperation("query", { sql: "SELECT 1", access_token: "mysql://reporter:other-secret@replica.example.com/shop" }, AS_NODE);
    await runOperation("query", { sql: "SELECT 1", access_token: "mysql://reporter:other-secret@replica.example.com/shop" }, AS_TOOL);
    assert.deepEqual(log.pools.map((pool) => pool.options.host), ["replica.example.com", "db.example.com"]);
  }));

test("no connection → setup_required; a postgres URL → invalid_input without echoing it", () =>
  withRunner({ environment: { MYSQL_URL: "" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT 1" }, AS_TOOL), { kind: "setup_required" });
    await assert.rejects(runOperation("query", { sql: "SELECT 1", access_token: "postgres://u:hunter22@h/db" }, AS_NODE), (error) => {
      assert.equal(error.kind, "invalid_input");
      assert.doesNotMatch(error.message, /hunter22/);
      return true;
    });
  }));

test("list_tables and describe_table pass names as parameters", async () => {
  await withRunner({ scenario: { statement: { fields: [["schema", 253], ["name", 253], ["type", 253]], rows: [["shop", "items", "table"]] } } }, async ({ runOperation, log }) => {
    const output = await runOperation("list_tables", { schema: "shop'; DROP TABLE x; --" }, AS_TOOL);
    const listStatement = log.statements.find((entry) => entry.sql.includes("information_schema.TABLES"));
    assert.deepEqual(listStatement.values, ["shop'; DROP TABLE x; --", "shop'; DROP TABLE x; --", 1]);
    assert.doesNotMatch(listStatement.sql, /DROP TABLE/);
    assert.deepEqual(output.data.tables, [{ schema: "shop", name: "items", type: "table" }]);
  });
  await withRunner({ scenario: { statement: { fields: [["schema", 253]], rows: [] } } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("describe_table", { table: "nope" }, AS_TOOL), { kind: "not_found" });
  });
});

test("explain uses a fixed prefix and returns traditional rows", () =>
  withRunner({ scenario: { statement: { fields: [["id", 8], ["table", 253]], rows: [["1", "items"]] } } }, async ({ runOperation, log }) => {
    const output = await runOperation("explain", { sql: "SELECT * FROM items WHERE id = ?", params: [1] }, AS_TOOL);
    assert.equal(log.statements[3].sql, "EXPLAIN SELECT * FROM items WHERE id = ?");
    assert.deepEqual(output.data.plan, [{ id: "1", table: "items" }]);
  }));
