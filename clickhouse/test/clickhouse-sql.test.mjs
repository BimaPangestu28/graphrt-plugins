import { test } from "node:test";
import assert from "node:assert/strict";
import { buildParameterQuery, formatParameterValue, quoteIdentifier } from "../lib/clickhouse-sql.mjs";
import { mapClickHouseError } from "../lib/clickhouse-errors.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { enforceResultCaps } from "../lib/result-caps.mjs";

test("enforceResultCaps keeps fitting results, breaks or throws on rows and bytes, ignores non-row bodies", () => {
  const result = { meta: [], data: [{ n: 1 }, { n: 2 }, { n: 3 }], rows: 3 };
  assert.equal(enforceResultCaps(result, { maxRows: 3, maxBytes: 1000, overflowMode: "throw" }), result);
  assert.deepEqual(enforceResultCaps(result, { maxRows: 2, maxBytes: 1000, overflowMode: "break" }).data, [{ n: 1 }, { n: 2 }]);
  // '[{"n":1},{"n":2}]' is 17 bytes.
  assert.equal(enforceResultCaps(result, { maxRows: 10, maxBytes: 17, overflowMode: "break" }).rows, 2);
  assert.throws(() => enforceResultCaps(result, { maxRows: 2, maxBytes: 1000, overflowMode: "throw" }), /max_result_rows \(2\)/);
  assert.throws(() => enforceResultCaps(result, { maxRows: 10, maxBytes: 17, overflowMode: "throw" }), /max_result_bytes \(17\)/);
  assert.equal(enforceResultCaps("Ok.\n", { maxRows: 1, maxBytes: 1, overflowMode: "throw" }), "Ok.\n");
});

test("quoteIdentifier backtick-quotes names and escapes backslashes and backticks", () => {
  assert.equal(quoteIdentifier("events"), "`events`");
  assert.equal(quoteIdentifier("my`table"), "`my\\`table`");
  assert.equal(quoteIdentifier("a\\b"), "`a\\\\b`");
  assert.throws(() => quoteIdentifier(""), (error) => error.kind === "invalid_input");
  assert.throws(() => quoteIdentifier("a\nb"), (error) => error.kind === "invalid_input");
});

test("formatParameterValue sends scalars as text and lists as ClickHouse array literals", () => {
  assert.equal(formatParameterValue("O'Brien"), "O'Brien");
  assert.equal(formatParameterValue(42), "42");
  assert.equal(formatParameterValue(true), "true");
  assert.equal(formatParameterValue(["a", "it's", "back\\slash"]), "['a','it\\'s','back\\\\slash']");
  assert.equal(formatParameterValue([1, 2.5]), "[1,2.5]");
  assert.throws(() => formatParameterValue({ nested: 1 }), (error) => error.kind === "invalid_input");
  assert.throws(() => formatParameterValue([[1]]), (error) => error.kind === "invalid_input");
});

test("buildParameterQuery turns {name: value} into param_<name> entries; names must be identifiers", () => {
  assert.deepEqual(buildParameterQuery({ user_id: 7, tags: ["x"] }), { param_user_id: "7", param_tags: "['x']" });
  assert.deepEqual(buildParameterQuery(undefined), {});
  for (const badName of ["a-b", "1a", "x&readonly=0", ""]) {
    assert.throws(() => buildParameterQuery({ [badName]: 1 }), (error) => error.kind === "invalid_input", badName);
  }
});

test("mapClickHouseError maps exception codes in the message to kinds", () => {
  const cases = [
    ["Code: 516. DB::Exception: default: Authentication failed: password is incorrect. (AUTHENTICATION_FAILED)", "auth_error"],
    ["Code: 164. DB::Exception: default: Cannot execute query in readonly mode. (READONLY)", "permission_denied"],
    ["Code: 497. DB::Exception: u: Not enough privileges. (ACCESS_DENIED)", "permission_denied"],
    ["Code: 60. DB::Exception: Unknown table expression identifier 'nope'. (UNKNOWN_TABLE)", "not_found"],
    ["Code: 62. DB::Exception: Syntax error: failed at position 1. (SYNTAX_ERROR)", "invalid_input"],
    ["Code: 159. DB::Exception: Timeout exceeded: elapsed 30 seconds. (TIMEOUT_EXCEEDED)", "timeout"],
    ["Code: 202. DB::Exception: Too many simultaneous queries. (TOO_MANY_SIMULTANEOUS_QUERIES)", "rate_limited"],
  ];
  for (const [message, kind] of cases) {
    const mapped = mapClickHouseError(new PluginError(`API error 500: ${message}`, { kind: "api_error", retryable: true }));
    assert.equal(mapped.kind, kind, message);
    assert.equal(mapped.retryable, kind === "rate_limited", message);
    assert.equal(mapped.message, `API error 500: ${message}`);
  }
  const other = new PluginError("Network error: request timed out", { kind: "network_error", retryable: true });
  assert.equal(mapClickHouseError(other), other);
});
