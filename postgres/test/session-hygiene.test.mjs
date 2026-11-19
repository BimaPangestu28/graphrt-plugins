/**
 * Review fixes: connection reuse after errors and writes, cancel escalation, memory bounds,
 * interrupted reads and the superuser policy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryTexts, withRunner } from "./helpers.mjs";

const AS_NODE = { source: "node" };
const AS_TOOL = { source: "tool" };

function sqlError(code, message) {
  return Object.assign(new Error(message), { code });
}

test("any failed read destroys the connection instead of returning it to the pool", async () => {
  for (const cursorError of [sqlError("22012", "division by zero"), sqlError("25006", "read-only"), new Error("weird client failure")]) {
    await withRunner({ scenario: { cursorError } }, async ({ runOperation, log }) => {
      await assert.rejects(runOperation("query", { sql: "SELECT pg_advisory_lock(1), 1 / 0" }, AS_TOOL));
      assert.equal(log.clients[0].released, "destroyed", cursorError.message);
    });
  }
});

test("a successful read rolls back, discards session state and returns the connection", () =>
  withRunner({ scenario: { cursorFields: [["n", 23]], cursorRows: [[1]] } }, async ({ runOperation, log }) => {
    await runOperation("query", { sql: "SELECT 1 AS n" }, AS_TOOL);
    assert.deepEqual(queryTexts(log).slice(-2), ["ROLLBACK", "DISCARD ALL"]);
    assert.equal(log.clients[0].released, "returned");
  }));

test("a committed write is followed by DISCARD ALL before the connection is reused", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await runOperation("execute", { sql: "SET ROLE reporting" }, AS_NODE);
    assert.deepEqual(queryTexts(log).slice(-3), ["SET ROLE reporting", "COMMIT", "DISCARD ALL"]);
    assert.equal(log.clients[0].released, "returned");
  }));

test("if DISCARD ALL fails after a committed write, the write is reported and the connection destroyed", () =>
  withRunner({ scenario: { onQuery: (text) => { if (text === "DISCARD ALL") throw new Error("connection lost"); } } }, async ({ runOperation, log }) => {
    const output = await runOperation("execute", { sql: "UPDATE items SET name = 'x'" }, AS_NODE);
    assert.equal(output.data.command, "UPDATE");
    assert.equal(log.clients[0].released, "destroyed");
  }));

test("a write with in_transaction false always destroys its connection afterwards", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await runOperation("execute", { sql: "VACUUM items", in_transaction: false }, AS_NODE);
    assert.equal(log.clients[0].released, "destroyed");
  }));

test("a failed write destroys the connection", () =>
  withRunner({ scenario: { onQuery: (text) => { if (text.startsWith("INSERT")) throw sqlError("23505", "duplicate key"); } } }, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("execute", { sql: "INSERT INTO items VALUES (1)" }, AS_NODE), { kind: "invalid_input" });
    assert.equal(log.clients[0].released, "destroyed");
  }));

test("client_connection_check_interval is set (only where the server has it) next to the statement timeout", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await runOperation("query", { sql: "SELECT 1" }, AS_TOOL);
    const checkInterval = log.queries.find((entry) => entry.text.includes("client_connection_check_interval"));
    assert.ok(checkInterval, "check interval query sent");
    assert.match(checkInterval.text, /FROM pg_settings WHERE name = 'client_connection_check_interval'/);
    assert.deepEqual(checkInterval.values, ["2000", true]);
  }));

test("cancel escalates to pg_terminate_backend when the backend ignores pg_cancel_backend", () =>
  withRunner({ scenario: { cursorFields: [["x", 23]], holdCursor: true } }, async ({ runOperation, log }) => {
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 20);
    await assert.rejects(runOperation("query", { sql: "DO $$ BEGIN LOOP END LOOP; END $$" }, { source: "node", signal: abortController.signal }), { kind: "cancelled" });
    assert.deepEqual(log.cancelQueries.map((entry) => entry.text), ["SELECT pg_cancel_backend($1)", "SELECT pg_terminate_backend($1)"]);
    assert.deepEqual(log.cancelQueries[1].values, [42]);
  }));

test("a read that was interrupted is reported as cancelled even if rows still arrived", () =>
  withRunner({ scenario: { cursorFields: [["n", 23]], cursorRows: [[1]], cursorDelayMs: 150 } }, async ({ runOperation }) => {
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 20);
    await assert.rejects(runOperation("query", { sql: "SELECT 1 AS n" }, { source: "node", signal: abortController.signal }), { kind: "cancelled" });
  }));

test("cursor batches start at one row and grow from the observed row size", () =>
  withRunner({ scenario: { cursorFields: [["t", 25]], cursorRows: Array.from({ length: 600 }, () => ["x".repeat(100)]) } }, async ({ runOperation, log }) => {
    const output = await runOperation("query", { sql: "SELECT t FROM big", max_rows: 500 }, AS_TOOL);
    assert.equal(log.readSizes[0], 1);
    assert.ok(log.readSizes[1] > 1, `second batch grew: ${log.readSizes}`);
    assert.ok(log.readSizes.every((size) => size <= 200));
    assert.equal(output.data.row_count, 500);
  }));

test("huge rows: only one row is buffered before the byte cap stops the read", () =>
  withRunner({ scenario: { cursorFields: [["t", 25]], cursorRows: Array.from({ length: 200 }, () => ["x".repeat(2000000)]) } }, async ({ runOperation, log }) => {
    const output = await runOperation("query", { sql: "SELECT repeat('x', 2000000) FROM generate_series(1, 200)" }, AS_TOOL);
    assert.equal(output.data.row_count, 0);
    assert.equal(output.data.truncated_reason, "max_bytes");
    assert.deepEqual(log.readSizes, [1]);
    assert.equal(log.cursors[0].offset, 1);
  }));

test("more bytes on the socket than the budget (4 x max bytes + 1 MiB) destroys the connection and returns the rows so far", () =>
  withRunner(
    { environment: { POSTGRES_MAX_RESULT_BYTES: "1000" }, scenario: { cursorFields: [["t", 25]], cursorRows: Array.from({ length: 50 }, () => ["small"]), wireBytesPerRow: 600000 } },
    async ({ runOperation, log }) => {
      const output = await runOperation("query", { sql: "SELECT t FROM wide" }, AS_TOOL);
      assert.equal(output.data.truncated, true);
      assert.equal(output.data.truncated_reason, "max_bytes");
      assert.ok(output.data.row_count < 50);
      assert.equal(log.clients[0].connection.stream.destroyed, true);
      assert.equal(log.clients[0].released, "destroyed");
    },
  ));

test("a client 'error' event during a call (dead socket) is handled and logged, never an uncaught crash", () =>
  withRunner({ scenario: { cursorFields: [["x", 23]], holdCursor: true } }, async ({ runOperation, log }) => {
    const abortController = new AbortController();
    setTimeout(() => log.clients[0].emit("error", new Error("terminating connection due to administrator command")), 20);
    setTimeout(() => abortController.abort(), 40);
    await assert.rejects(runOperation("query", { sql: "SELECT pg_sleep(60)" }, { source: "node", signal: abortController.signal }), { kind: "cancelled" });
    assert.ok(log.warnings.some((message) => /administrator command/.test(message)));
    log.clients[0].emit("error", new Error("late error after the call"));
  }));

test("superuser connections: tool calls are refused unless POSTGRES_ALLOW_SUPERUSER=1, nodes get a warning", async () => {
  await withRunner({ scenario: { isSuperuser: true } }, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT 1" }, AS_TOOL), { kind: "permission_denied", message: /superuser.*POSTGRES_ALLOW_SUPERUSER=1/ });
    assert.ok(!log.queries.some((entry) => entry.text === "BEGIN READ ONLY"));
    await assert.rejects(runOperation("list_tables", {}, AS_TOOL), { kind: "permission_denied" });
    await runOperation("query", { sql: "SELECT 1" }, AS_NODE);
    assert.ok(log.warnings.some((message) => /superuser/.test(message)));
  });
  await withRunner({ scenario: { isSuperuser: true }, environment: { POSTGRES_ALLOW_SUPERUSER: "1" } }, async ({ runOperation }) => {
    await runOperation("query", { sql: "SELECT 1" }, AS_TOOL);
  });
  await withRunner({ scenario: { isSuperuser: false } }, async ({ runOperation, log }) => {
    await runOperation("query", { sql: "SELECT 1" }, AS_TOOL);
    assert.equal(log.warnings.length, 0);
  });
});
