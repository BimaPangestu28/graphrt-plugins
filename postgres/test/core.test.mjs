import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyImportError, createRedactor } from "../lib/errors.mjs";
import { createResultCollector } from "../lib/result-collector.mjs";
import { convertValue, deduplicateColumnNames } from "../lib/value-conversion.mjs";
import { createTypeParsers, normalizeTimestampText } from "../lib/type-parsers.mjs";
import { mapPostgresError } from "../lib/error-mapping.mjs";

test("convertValue: bigint, binary, dates, non-finite numbers and nested JSON", () => {
  const state = { maxBinaryBytes: 3, valuesTruncated: false };
  assert.equal(convertValue(12n, state), 12);
  assert.equal(convertValue(9007199254740993n, state), "9007199254740993");
  assert.equal(convertValue(new Date("2026-11-19T01:02:03Z"), state), "2026-11-19T01:02:03.000Z");
  assert.equal(convertValue(new Date("nope"), state), null);
  assert.equal(convertValue(Number.POSITIVE_INFINITY, state), "Infinity");
  assert.deepEqual(convertValue({ nested: [1n, Buffer.from("ab")] }, state), { nested: [1, "YWI="] });
  assert.equal(state.valuesTruncated, false);
  assert.equal(convertValue(Buffer.from("abcdef"), state), Buffer.from("abc").toString("base64"));
  assert.equal(state.valuesTruncated, true);
});

test("deduplicateColumnNames keeps every column", () => {
  assert.deepEqual(deduplicateColumnNames(["id", "id", "", "id_2"]), ["id", "id_2", "column", "id_2_2"]);
});

test("result collector: row cap only reports truncated when more rows existed", () => {
  const exact = createResultCollector({ columnNames: ["n"], maxRows: 2, maxBytes: 1000 });
  assert.equal(exact.addRow([1]), true);
  assert.equal(exact.addRow([2]), true);
  assert.deepEqual(exact.finish(), { rows: [{ n: 1 }, { n: 2 }], row_count: 2, truncated: false });
  assert.equal(exact.addRow([3]), false);
  assert.equal(exact.finish().truncated_reason, "max_rows");
});

test("result collector: byte cap and cut binary values are reported", () => {
  const collector = createResultCollector({ columnNames: ["b"], maxRows: 10, maxBytes: 40, maxBinaryBytes: 2 });
  assert.equal(collector.addRow([Buffer.from("abcdef")]), true);
  assert.equal(collector.addRow(["x".repeat(50)]), false);
  assert.deepEqual(collector.finish(), { rows: [{ b: "YWI=" }], row_count: 1, truncated: true, truncated_reason: "max_bytes", values_truncated: true });
});

test("result collector: markTruncated stops collection and keeps the rows so far", () => {
  const collector = createResultCollector({ columnNames: ["n"], maxRows: 10, maxBytes: 1000 });
  collector.addRow([1]);
  collector.markTruncated("max_bytes");
  assert.equal(collector.addRow([2]), false);
  assert.deepEqual(collector.finish(), { rows: [{ n: 1 }], row_count: 1, truncated: true, truncated_reason: "max_bytes" });
  collector.markTruncated("max_rows");
  assert.equal(collector.finish().truncated_reason, "max_bytes", "the first reason wins");
});

test("result collector: bytesCollected reports the JSON size kept so far", () => {
  const collector = createResultCollector({ columnNames: ["t"], maxRows: 10, maxBytes: 1000 });
  collector.addRow(["abc"]);
  assert.equal(collector.bytesCollected(), 2 + Buffer.byteLength(JSON.stringify({ t: "abc" })) + 1);
});

test("redactor hides secrets, their URL-encoded form and any URL password", () => {
  const redact = createRedactor(["Sup3r:S3cret@pw"]);
  assert.equal(redact("bad Sup3r:S3cret@pw and Sup3r%3AS3cret%40pw"), "bad [redacted] and [redacted]");
  assert.equal(redact("failed for postgres://app:unknown-pass@db/x"), "failed for postgres://app:[redacted]@db/x");
});

test("classifyImportError turns a missing package into setup_required", () => {
  const missing = classifyImportError("pg", "postgres", Object.assign(new Error("Cannot find package 'pg'"), { code: "ERR_MODULE_NOT_FOUND" }));
  assert.equal(missing.kind, "setup_required");
  assert.match(missing.message, /npm install.*postgres/);
  const other = new Error("boom");
  assert.equal(classifyImportError("pg", "postgres", other), other);
});

test("timestamps keep their precision and offset in ISO form", () => {
  assert.equal(normalizeTimestampText("2026-11-19 10:00:00.123456"), "2026-11-19T10:00:00.123456");
  assert.equal(normalizeTimestampText("2026-11-19 10:00:00+07"), "2026-11-19T10:00:00+07:00");
  assert.equal(normalizeTimestampText("2026-11-19 10:00:00+05:30"), "2026-11-19T10:00:00+05:30");
  assert.equal(normalizeTimestampText("infinity"), "infinity");
  assert.equal(normalizeTimestampText("0044-03-15 00:00:00 BC"), "0044-03-15 00:00:00 BC");
});

test("type parsers: timestamp arrays are parsed with the same normalisation; others fall through", () => {
  const fallback = () => "fallback";
  const parsers = createTypeParsers({ getTypeParser: () => fallback, arrayParser: { create: (text, transform) => ({ parse: () => text.slice(1, -1).split(",").map(transform) }) } });
  assert.equal(parsers.getTypeParser(1082)("2026-11-19"), "2026-11-19");
  assert.deepEqual(parsers.getTypeParser(1185)("{2026-11-19 10:00:00+07}"), ["2026-11-19T10:00:00+07:00"]);
  assert.equal(parsers.getTypeParser(23), fallback);
});

test("mapPostgresError: SQLSTATE classes and network errors", () => {
  assert.equal(mapPostgresError({ code: "42P01", message: 'relation "x" does not exist' }).kind, "not_found");
  assert.equal(mapPostgresError({ code: "23505", message: "duplicate key" }).kind, "invalid_input");
  assert.equal(mapPostgresError({ code: "40P01", message: "deadlock detected" }).retryable, true);
  assert.equal(mapPostgresError({ code: "53300", message: "too many connections" }).kind, "rate_limited");
  const lost = mapPostgresError({ code: "ECONNRESET", message: "read ECONNRESET" }, { isWrite: true });
  assert.equal(lost.kind, "network_error");
  assert.equal(lost.retryable, false);
  assert.equal(mapPostgresError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }).retryable, true);
});
