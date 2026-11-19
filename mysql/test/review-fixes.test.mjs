/**
 * Review fixes: stored procedure calls from agents, and the socket byte budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstStatementKeyword } from "../lib/statement-scanner.mjs";
import { withRunner } from "./helpers.mjs";

const AS_NODE = { source: "node" };
const AS_TOOL = { source: "tool" };
const DISGUISED_CALLS = ["CALL p()", "call p()", "  /* c */ CALL p()", "-- c\nCALL p()", "# c\nCALL p()", ";CALL p()", ";; \n cAlL `p`()", "/*!50000 CALL p() */", "/*! CALL p() */"];

test("firstStatementKeyword skips whitespace, empty statements, comments and opens MySQL executable comments", () => {
  for (const sql of DISGUISED_CALLS) assert.equal(firstStatementKeyword(sql), "CALL", JSON.stringify(sql));
  assert.equal(firstStatementKeyword("SELECT 'CALL p()'"), "SELECT");
  assert.equal(firstStatementKeyword("/* CALL p() */ SELECT 1"), "SELECT");
  assert.equal(firstStatementKeyword("--x\nSELECT 1"), null, "`--` without a space is not a comment in MySQL, so the first token is an operator");
  assert.equal(firstStatementKeyword(""), null);
});

test("agent query refuses stored procedure calls (procedures can COMMIT and start a read-write transaction)", () =>
  withRunner({}, async ({ runOperation, log }) => {
    for (const sql of DISGUISED_CALLS) {
      await assert.rejects(runOperation("query", { sql }, AS_TOOL), { kind: "permission_denied", message: /CALL/ }, JSON.stringify(sql));
    }
    await assert.rejects(runOperation("query", { sql: "CALL p()" }), { kind: "permission_denied" }, "no source fails closed");
    assert.equal(log.pools.length, 0, "refused before connecting");
  }));

test("node query may CALL (documented: use an account without EXECUTE)", () =>
  withRunner({}, async ({ runOperation, log }) => {
    await runOperation("query", { sql: "CALL report_totals()" }, AS_NODE);
    assert.ok(log.statements.some((entry) => entry.sql === "CALL report_totals()"));
  }));

test("more bytes on the socket than the budget (4 x max bytes + 1 MiB) destroys the connection and returns the rows so far", () =>
  withRunner(
    { environment: { MYSQL_MAX_RESULT_BYTES: "1000" }, scenario: { statement: { fields: [["b", 252, 63]], rows: Array.from({ length: 50 }, () => [Buffer.from("x")]), wireBytesPerRow: 600000 } } },
    async ({ runOperation, log }) => {
      const output = await runOperation("query", { sql: "SELECT b FROM blobs" }, AS_TOOL);
      assert.equal(output.data.truncated, true);
      assert.equal(output.data.truncated_reason, "max_bytes");
      assert.ok(output.data.row_count < 50 && output.data.row_count >= 1, `rows: ${output.data.row_count}`);
      assert.equal(log.connections[0].state, "destroyed");
    },
  ));
