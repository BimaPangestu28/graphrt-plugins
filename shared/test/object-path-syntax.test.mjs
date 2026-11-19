import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPathValues, parsePath, readPath, replacePathValues, writePath } from "../lib/object-path.mjs";

test("readPath supports escaped dots and bracket-quoted keys such as @odata.nextLink", () => {
  const body = { "@odata.nextLink": "https://n", meta: { "a.b": 1 } };
  assert.equal(readPath(body, '["@odata.nextLink"]'), "https://n");
  assert.equal(readPath(body, "@odata\\.nextLink"), "https://n");
  assert.equal(readPath(body, 'meta["a.b"]'), 1);
  assert.equal(readPath(body, "meta.a\\.b"), 1);
});

test("writePath and collectPathValues use the same path syntax", () => {
  assert.deepEqual(writePath({}, '["x.y"].z', 1), { "x.y": { z: 1 } });
  assert.deepEqual(collectPathValues({ "a.b": [{ u: 1 }, { u: 2 }] }, '["a.b"][].u'), [1, 2]);
});

test("writePath creates objects, not arrays, for numeric segments", () => {
  assert.deepEqual(writePath({}, "items.0.id", "a"), { items: { 0: { id: "a" } } });
});

test("replacePathValues maps every value at a path, including [] segments, without mutating the input", () => {
  const result = { data: [{ b64: "AAA" }, { b64: "BBB" }, { url: "u" }] };
  const replaced = replacePathValues(result, "data[].b64", (value) => `saved:${value}`);
  assert.deepEqual(replaced, { data: [{ b64: "saved:AAA" }, { b64: "saved:BBB" }, { url: "u" }] });
  assert.equal(result.data[0].b64, "AAA");
  assert.deepEqual(replacePathValues({ a: "x" }, "a", (value) => value.toUpperCase()), { a: "X" });
});

test("parsePath splits keys, quoted keys and [] flatten markers, and rejects malformed brackets", () => {
  assert.deepEqual(parsePath('a["b.c"][].d'), ["a", "b.c", parsePath.FLATTEN, "d"]);
  assert.throws(() => parsePath('a["b'), /path/);
});
