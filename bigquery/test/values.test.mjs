import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQueryParameters } from "../lib/query-parameters.mjs";
import { decodeRows, summarizeSchema } from "../lib/row-decoding.mjs";

const SCHEMA = {
  fields: [
    { name: "id", type: "INTEGER" },
    { name: "big", type: "INT64" },
    { name: "price", type: "NUMERIC" },
    { name: "ratio", type: "FLOAT" },
    { name: "odd", type: "FLOAT64" },
    { name: "ok", type: "BOOLEAN" },
    { name: "at", type: "TIMESTAMP" },
    { name: "day", type: "DATE" },
    { name: "raw", type: "BYTES" },
    { name: "doc", type: "JSON" },
    { name: "tags", type: "STRING", mode: "REPEATED" },
    { name: "address", type: "RECORD", fields: [{ name: "city", type: "STRING" }, { name: "zip", type: "INTEGER" }] },
    { name: "missing", type: "STRING" },
  ],
};

test("decodeRows maps BigQuery f/v rows to typed objects", () => {
  const row = {
    f: [
      { v: "42" },
      { v: "9007199254740993" },
      { v: "12.50" },
      { v: "0.25" },
      { v: "NaN" },
      { v: "true" },
      { v: "1763546400123456" },
      { v: "2026-11-19" },
      { v: "AQID" },
      { v: '{"a":1}' },
      { v: [{ v: "x" }, { v: "y" }] },
      { v: { f: [{ v: "Jakarta" }, { v: "10110" }] } },
      { v: null },
    ],
  };
  assert.deepEqual(decodeRows(SCHEMA, [row]), [
    {
      id: 42,
      big: "9007199254740993",
      price: "12.50",
      ratio: 0.25,
      odd: "NaN",
      ok: true,
      at: "2025-11-19T10:00:00.123456Z",
      day: "2026-11-19",
      raw: "AQID",
      doc: { a: 1 },
      tags: ["x", "y"],
      address: { city: "Jakarta", zip: 10110 },
      missing: null,
    },
  ]);
  assert.deepEqual(decodeRows(SCHEMA, undefined), []);
});

test("summarizeSchema flattens nested fields with their mode", () => {
  assert.deepEqual(summarizeSchema({ fields: [{ name: "a", type: "RECORD", mode: "REPEATED", fields: [{ name: "b", type: "STRING", description: "d" }] }] }), [
    { name: "a", type: "RECORD", mode: "REPEATED", description: null },
    { name: "a.b", type: "STRING", mode: "NULLABLE", description: "d" },
  ]);
});

test("buildQueryParameters infers named and positional parameter types", () => {
  assert.deepEqual(buildQueryParameters({ name: "Ana", n: 3, x: 1.5, ok: false, ids: [1, 2], day: { type: "DATE", value: "2026-11-19" } }), {
    parameterMode: "NAMED",
    queryParameters: [
      { name: "name", parameterType: { type: "STRING" }, parameterValue: { value: "Ana" } },
      { name: "n", parameterType: { type: "INT64" }, parameterValue: { value: "3" } },
      { name: "x", parameterType: { type: "FLOAT64" }, parameterValue: { value: "1.5" } },
      { name: "ok", parameterType: { type: "BOOL" }, parameterValue: { value: "false" } },
      { name: "ids", parameterType: { type: "ARRAY", arrayType: { type: "INT64" } }, parameterValue: { arrayValues: [{ value: "1" }, { value: "2" }] } },
      { name: "day", parameterType: { type: "DATE" }, parameterValue: { value: "2026-11-19" } },
    ],
  });
  assert.deepEqual(buildQueryParameters(["a", null]).queryParameters, [
    { parameterType: { type: "STRING" }, parameterValue: { value: "a" } },
    { parameterType: { type: "STRING" }, parameterValue: {} },
  ]);
  assert.deepEqual(buildQueryParameters(undefined), {});
  assert.deepEqual(buildQueryParameters({ tags: { type: "ARRAY<STRING>", value: ["a"] } }).queryParameters[0].parameterType, { type: "ARRAY", arrayType: { type: "STRING" } });
});

test("buildQueryParameters refuses what it cannot type", () => {
  assert.throws(() => buildQueryParameters({ "bad name": 1 }), /name/);
  assert.throws(() => buildQueryParameters({ mixed: [1, "a"] }), /same type/);
  assert.throws(() => buildQueryParameters({ empty: [] }), /empty array/);
  assert.throws(() => buildQueryParameters({ nested: { a: 1 } }), /type/);
  assert.throws(() => buildQueryParameters({ typed: { type: "DROP TABLE", value: "x" } }), /type/);
  assert.throws(() => buildQueryParameters({ huge: 2 ** 60 }), /exact/);
});
