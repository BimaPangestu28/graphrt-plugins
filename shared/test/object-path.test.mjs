import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPathValues, readPath, writePath } from "../lib/object-path.mjs";

test("readPath follows dotted keys and numeric indexes, and returns the value itself for an empty path", () => {
  const response = { data: { items: [{ id: "a" }, { id: "b" }] }, "x-y": 1 };
  assert.equal(readPath(response, "data.items.1.id"), "b");
  assert.equal(readPath(response, "x-y"), 1);
  assert.equal(readPath(response, ""), response);
  assert.equal(readPath(response, undefined), response);
});

test("readPath returns undefined for missing segments and non-objects instead of throwing", () => {
  assert.equal(readPath({ a: null }, "a.b"), undefined);
  assert.equal(readPath("text", "length"), undefined);
  assert.equal(readPath(undefined, "a"), undefined);
});

test("readPath never reads inherited properties such as __proto__ or constructor", () => {
  assert.equal(readPath({}, "constructor"), undefined);
  assert.equal(readPath({}, "__proto__"), undefined);
});

test("writePath creates nested objects and keeps siblings", () => {
  const body = { message: { chat: 1 } };
  writePath(body, "message.text", "hi");
  writePath(body, "options.notify.sound", false);
  assert.deepEqual(body, { message: { chat: 1, text: "hi" }, options: { notify: { sound: false } } });
});

test("writePath refuses prototype-polluting segments", () => {
  assert.throws(() => writePath({}, "__proto__.polluted", 1), /__proto__/);
  assert.throws(() => writePath({}, "a.constructor.prototype", 1), /constructor/);
  assert.equal({}.polluted, undefined);
});

test("collectPathValues flattens [] segments and drops missing values", () => {
  const result = { data: [{ url: "u1" }, { url: "u2" }, { b64: "x" }], output: ["o1", "o2"], single: "s" };
  assert.deepEqual(collectPathValues(result, "data[].url"), ["u1", "u2"]);
  assert.deepEqual(collectPathValues(result, "output[]"), ["o1", "o2"]);
  assert.deepEqual(collectPathValues(result, "output"), ["o1", "o2"]);
  assert.deepEqual(collectPathValues(result, "single"), ["s"]);
  assert.deepEqual(collectPathValues(result, "missing[].url"), []);
});
