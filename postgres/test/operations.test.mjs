import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { queryTexts, TEST_PASSWORD, TEST_URL, withRunner } from "./helpers.mjs";

const AS_NODE = { source: "node" };
const AS_TOOL = { source: "tool" };
const ITEM_FIELDS = [["id", 20], ["name", 25], ["raw", 17]];

function sqlError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

test("manifest: five operations are tools, connection and policy env declared, network and secrets allowed", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["query", "execute", "explain", "list_tables", "describe_table"]);
  for (const variableName of ["POSTGRES_URL", "POSTGRES_HOST", "POSTGRES_PASSWORD", "POSTGRES_TOOL_ALLOW_WRITES", "POSTGRES_STATEMENT_TIMEOUT_MS", "POSTGRES_MAX_RESULT_BYTES"]) {
    assert.ok(manifest.permissions.env.includes(variableName), variableName);
  }
  assert.equal(manifest.permissions.network, true);
  assert.equal(manifest.permissions.secrets, true);
  assert.ok(manifest.nodes.every((node) => node.config_schema.properties.access_token));
});

test("query runs in a READ ONLY transaction with a local statement timeout, rolls back and discards session state", () =>
  withRunner({ scenario: { cursorFields: ITEM_FIELDS, cursorRows: [["1", "kopi", Buffer.from([1, 2, 255])]] } }, async ({ runOperation, log }) => {
    const output = await runOperation("query", { sql: "SELECT id, name, raw FROM items WHERE name = $1", params: ["kopi"], timeout_ms: 1500 }, AS_TOOL);
    assert.deepEqual(queryTexts(log), [
      "SELECT current_setting('is_superuser') = 'on' AS is_superuser",
      "BEGIN READ ONLY",
      "SELECT set_config('statement_timeout', $1, $2)",
      "SELECT set_config(name, $1, $2) FROM pg_settings WHERE name = 'client_connection_check_interval'",
      "CURSOR SELECT id, name, raw FROM items WHERE name = $1",
      "ROLLBACK",
      "DISCARD ALL",
    ]);
    assert.deepEqual(log.queries[2].values, ["1500", true]);
    assert.deepEqual(log.cursors[0].values, ["kopi"]);
    assert.equal(log.cursors[0].config.rowMode, "array");
    assert.deepEqual(output.data, {
      fields: [{ name: "id", type: "int8" }, { name: "name", type: "text" }, { name: "raw", type: "bytea" }],
      rows: [{ id: "1", name: "kopi", raw: "AQL/" }],
      row_count: 1,
      truncated: false,
    });
    assert.equal(log.cursors[0].closed, true);
    assert.equal(log.clients[0].released, "returned");
  }));

test("query stops at max_rows and reports truncated", () =>
  withRunner({ scenario: { cursorFields: [["g", 23]], cursorRows: Array.from({ length: 50 }, (_unused, index) => [index]) } }, async ({ runOperation, log }) => {
    const output = await runOperation("query", { sql: "SELECT g FROM generate_series(1, 50) g", max_rows: 3 }, AS_TOOL);
    assert.deepEqual(output.data.rows, [{ g: 0 }, { g: 1 }, { g: 2 }]);
    assert.equal(output.data.truncated, true);
    assert.equal(output.data.truncated_reason, "max_rows");
    assert.equal(log.cursors[0].offset, 4, "reads only one row past the cap");
  }));

test("query stops at the byte cap", () =>
  withRunner({ environment: { POSTGRES_MAX_RESULT_BYTES: "1000" }, scenario: { cursorFields: [["t", 25]], cursorRows: Array.from({ length: 20 }, () => ["x".repeat(200)]) } }, async ({ runOperation }) => {
    const output = await runOperation("query", { sql: "SELECT t FROM big" }, AS_TOOL);
    assert.equal(output.data.truncated, true);
    assert.equal(output.data.truncated_reason, "max_bytes");
    assert.ok(output.data.row_count < 20 && output.data.row_count > 0);
    assert.ok(JSON.stringify(output.data.rows).length <= 1000);
  }));

test("query max_rows above 5000 is refused", () =>
  withRunner({}, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT 1", max_rows: 5001 }, AS_TOOL), { kind: "invalid_input", message: /max_rows/ });
  }));

test("a write inside query is refused by the database and reported as permission_denied", () =>
  withRunner({ scenario: { cursorError: sqlError("25006", "cannot execute DELETE in a read-only transaction") } }, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("query", { sql: "DELETE FROM items" }, AS_TOOL), { kind: "permission_denied", message: /read-only transaction.*execute/ });
    assert.equal(log.clients[0].released, "destroyed", "any read error discards the connection (and its open transaction)");
  }));

test("statement timeout from the server maps to kind timeout", () =>
  withRunner({ scenario: { cursorError: sqlError("57014", "canceling statement due to statement timeout") } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT pg_sleep(10)", timeout_ms: 200 }, AS_TOOL), { kind: "timeout", message: /200 ms/ });
  }));

test("execute is refused for agent tool calls unless POSTGRES_TOOL_ALLOW_WRITES=1, before connecting", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("execute", { sql: "DELETE FROM items" }, AS_TOOL), { kind: "permission_denied", message: /POSTGRES_TOOL_ALLOW_WRITES=1/ });
    assert.equal(log.pools.length, 0);
  }));

test("execute from a tool works with the opt-in", () =>
  withRunner({ environment: { POSTGRES_TOOL_ALLOW_WRITES: "1" } }, async ({ runOperation }) => {
    const output = await runOperation("execute", { sql: "DELETE FROM items WHERE id = $1", params: [1] }, AS_TOOL);
    assert.equal(output.data.command, "DELETE");
  }));

test("execute from a node commits one extended-protocol statement and returns RETURNING rows", () =>
  withRunner(
    {
      scenario: {
        onQuery: (text) => (text.startsWith("INSERT") ? { command: "INSERT", rowCount: 1, fields: [{ name: "id", dataTypeID: 20 }], rows: [["7"]] } : null),
      },
    },
    async ({ runOperation, log }) => {
      const output = await runOperation("execute", { sql: "INSERT INTO items (name) VALUES ($1) RETURNING id", params: ["teh"] }, AS_NODE);
      assert.deepEqual(queryTexts(log).slice(1), [
        "BEGIN",
        "SELECT set_config('statement_timeout', $1, $2)",
        "SELECT set_config(name, $1, $2) FROM pg_settings WHERE name = 'client_connection_check_interval'",
        "INSERT INTO items (name) VALUES ($1) RETURNING id",
        "COMMIT",
        "DISCARD ALL",
      ]);
      const insertEntry = log.queries.find((entry) => entry.text.startsWith("INSERT"));
      assert.equal(insertEntry.config.queryMode, "extended", "extended protocol refuses multiple statements");
      assert.equal(insertEntry.config.rowMode, "array");
      assert.deepEqual(output.data, {
        command: "INSERT",
        affected_rows: 1,
        fields: [{ name: "id", type: "int8" }],
        rows: [{ id: "7" }],
        returned_row_count: 1,
        truncated: false,
      });
    },
  ));

test("execute with in_transaction false sets a session timeout and discards the connection afterwards", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await runOperation("execute", { sql: "VACUUM items", in_transaction: false }, AS_NODE);
    assert.deepEqual(queryTexts(log).slice(1), [
      "SELECT set_config('statement_timeout', $1, $2)",
      "SELECT set_config(name, $1, $2) FROM pg_settings WHERE name = 'client_connection_check_interval'",
      "VACUUM items",
    ]);
    assert.deepEqual(log.queries[1].values, ["30000", false]);
    assert.equal(log.clients[0].released, "destroyed");
  }));

test("a failed write is discarded with its connection, and a lost connection is never retryable", () =>
  withRunner(
    {
      scenario: {
        onQuery: (text) => {
          if (text.startsWith("UPDATE")) throw Object.assign(new Error("Connection terminated unexpectedly"), { code: undefined });
          return null;
        },
      },
    },
    async ({ runOperation, log }) => {
      await assert.rejects(runOperation("execute", { sql: "UPDATE items SET name = $1", params: ["x"] }, AS_NODE), (error) => {
        assert.equal(error.kind, "network_error");
        assert.equal(error.retryable, false);
        assert.match(error.message, /may or may not have been applied/);
        return true;
      });
      assert.ok(!queryTexts(log).includes("COMMIT"));
      assert.equal(log.clients[0].released, "destroyed");
    },
  ));

test("cancelling a running query sends pg_cancel_backend and discards the connection", () =>
  withRunner({ scenario: { cursorFields: [["x", 23]], holdCursor: true } }, async ({ runOperation, log }) => {
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 20);
    const startedAt = Date.now();
    await assert.rejects(runOperation("query", { sql: "SELECT pg_sleep(60)" }, { source: "node", signal: abortController.signal }), { kind: "cancelled" });
    assert.ok(Date.now() - startedAt < 5000);
    assert.deepEqual(log.cancelQueries[0], { text: "SELECT pg_cancel_backend($1)", values: [42] });
    assert.equal(log.clients[0].released, "destroyed");
  }));

test("an already aborted call never connects", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT 1" }, { source: "node", signal: AbortSignal.abort() }), { kind: "cancelled" });
    assert.equal(log.clients.length, 0);
  }));

test("connection errors are redacted: the password, its URL form and the URL never leave the plugin", () =>
  withRunner(
    { scenario: { connectError: Object.assign(new Error(`connect ECONNREFUSED for ${TEST_URL} (password ${TEST_PASSWORD})`), { code: "ECONNREFUSED" }) } },
    async ({ runOperation }) => {
      await assert.rejects(runOperation("query", { sql: "SELECT 1" }, AS_TOOL), (error) => {
        assert.equal(error.kind, "network_error");
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.message, /S3cret/);
        assert.match(error.message, /\[redacted\]/);
        return true;
      });
    },
  ));

test("auth failures map to auth_error", () =>
  withRunner({ scenario: { connectError: sqlError("28P01", 'password authentication failed for user "app"') } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT 1" }, AS_TOOL), { kind: "auth_error" });
  }));

test("a node's access_token URL replaces POSTGRES_URL; tools cannot pass one", () =>
  withRunner({}, async ({ runOperation, log }) => {
    const nodeUrl = "postgres://reporter:other-secret@replica.example.com/shop";
    await runOperation("query", { sql: "SELECT 1", access_token: nodeUrl }, AS_NODE);
    await runOperation("query", { sql: "SELECT 1", access_token: nodeUrl }, AS_TOOL);
    assert.deepEqual(log.pools.map((pool) => pool.config.connectionString), [nodeUrl, TEST_URL]);
  }));

test("connection parts build the pool config; sslmode require turns TLS on", () =>
  withRunner(
    { environment: { POSTGRES_URL: "", POSTGRES_HOST: "db.internal", POSTGRES_PORT: "6543", POSTGRES_USER: "app", POSTGRES_PASSWORD: "pw-123", POSTGRES_DATABASE: "shop", POSTGRES_SSLMODE: "require" } },
    async ({ runOperation, log }) => {
      await runOperation("query", { sql: "SELECT 1" }, AS_TOOL);
      const { config } = log.pools[0];
      assert.equal(config.host, "db.internal");
      assert.equal(config.port, 6543);
      assert.equal(config.password, "pw-123");
      assert.deepEqual(config.ssl, { rejectUnauthorized: false });
      assert.equal(config.statement_timeout, 30000);
      assert.equal(config.connectionTimeoutMillis, 10000);
    },
  ));

test("no connection configured → setup_required; a non-postgres URL → invalid_input without echoing it", () =>
  withRunner({ environment: { POSTGRES_URL: "" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT 1" }, AS_TOOL), { kind: "setup_required", message: /POSTGRES_URL/ });
    await assert.rejects(runOperation("query", { sql: "SELECT 1", access_token: "mysql://u:hunter22@h/db" }, AS_NODE), (error) => {
      assert.equal(error.kind, "invalid_input");
      assert.doesNotMatch(error.message, /hunter22/);
      return true;
    });
  }));

test("pools are reused per connection and closed after being idle", async () => {
  const pendingTimers = [];
  const fakeTimers = {
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      pendingTimers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
  };
  await withRunner({ definitionOptions: { poolRegistryOptions: { timers: fakeTimers } } }, async ({ runOperation, log, definition }) => {
    await runOperation("query", { sql: "SELECT 1" }, AS_TOOL);
    await runOperation("query", { sql: "SELECT 2" }, AS_TOOL);
    assert.equal(log.pools.length, 1);
    pendingTimers.filter((timer) => !timer.cleared).forEach((timer) => timer.callback());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(log.pools[0].ended, true);
    await runOperation("query", { sql: "SELECT 3" }, AS_TOOL);
    assert.equal(log.pools.length, 2, "a new pool after the idle one closed");
    await definition.closeAllConnections();
    assert.equal(log.pools[1].ended, true);
  });
});

test("list_tables passes the schema as a parameter", () =>
  withRunner({ scenario: { cursorFields: [["schema", 19], ["name", 19], ["type", 25]], cursorRows: [["public", "items", "table"]] } }, async ({ runOperation, log }) => {
    const output = await runOperation("list_tables", { schema: "public'; DROP TABLE x; --" }, AS_TOOL);
    assert.deepEqual(log.cursors[0].values, ["public'; DROP TABLE x; --", true]);
    assert.doesNotMatch(log.cursors[0].text, /DROP TABLE/);
    assert.deepEqual(output.data.tables, [{ schema: "public", name: "items", type: "table" }]);
  }));

test("describe_table returns the table row, or not_found", async () => {
  await withRunner({ scenario: { cursorFields: [["schema", 19], ["name", 19], ["columns", 114]], cursorRows: [["public", "items", [{ name: "id" }]]] } }, async ({ runOperation, log }) => {
    const output = await runOperation("describe_table", { table: "items" }, AS_TOOL);
    assert.deepEqual(log.cursors[0].values, [null, "items"]);
    assert.deepEqual(output.data, { schema: "public", name: "items", columns: [{ name: "id" }] });
  });
  await withRunner({ scenario: { cursorFields: [["schema", 19]], cursorRows: [] } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("describe_table", { table: "nope", schema: "sales" }, AS_TOOL), { kind: "not_found", message: /"nope" in schema "sales"/ });
  });
});

test("explain prefixes EXPLAIN with fixed options and returns the plan text", () =>
  withRunner({ scenario: { cursorFields: [["QUERY PLAN", 25]], cursorRows: [["Seq Scan on items"], ["  Filter: (id = 1)"]] } }, async ({ runOperation, log }) => {
    const output = await runOperation("explain", { sql: "SELECT * FROM items WHERE id = $1", params: [1] }, AS_TOOL);
    assert.equal(log.cursors[0].text, "EXPLAIN (FORMAT TEXT, ANALYZE FALSE) SELECT * FROM items WHERE id = $1");
    assert.equal(queryTexts(log)[1], "BEGIN READ ONLY");
    assert.equal(output.data.plan, "Seq Scan on items\n  Filter: (id = 1)");
  }));

test("params must be scalars or JSON values", () =>
  withRunner({}, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT $1", params: [Number.NaN] }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("query", { sql: "SELECT $1", params: ["a\0b"] }, AS_TOOL), { kind: "invalid_input" });
  }));
