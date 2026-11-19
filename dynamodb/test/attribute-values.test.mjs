import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, encodeCursor, marshallItem, marshallValue, unmarshallItem } from "../lib/attribute-values.mjs";

test("marshallValue maps plain JSON to AttributeValues", () => {
  assert.deepEqual(marshallValue("a"), { S: "a" });
  assert.deepEqual(marshallValue(12.5), { N: "12.5" });
  assert.deepEqual(marshallValue(true), { BOOL: true });
  assert.deepEqual(marshallValue(null), { NULL: true });
  assert.deepEqual(marshallValue([1, "x"]), { L: [{ N: "1" }, { S: "x" }] });
  assert.deepEqual(marshallValue({ nested: { deep: false } }), { M: { nested: { M: { deep: { BOOL: false } } } } });
});

test("marshallItem refuses values DynamoDB cannot store exactly", () => {
  assert.throws(() => marshallItem({ value: Number.NaN }), /finite/);
  assert.throws(() => marshallItem({ value: 2 ** 60 }), /exact/);
  assert.throws(() => marshallItem([1]), /object/);
  assert.throws(() => marshallItem({ value: undefined }), /undefined/);
});

test("typed mode passes AttributeValues through after checking their shape", () => {
  const typedItem = { id: { S: "1" }, tags: { SS: ["a", "b"] }, big: { N: "123456789012345678901234567890" } };
  assert.deepEqual(marshallItem(typedItem, "typed"), typedItem);
  assert.throws(() => marshallItem({ id: { X: "1" } }, "typed"), /AttributeValue/);
  assert.throws(() => marshallItem({ id: { S: "1", N: "2" } }, "typed"), /AttributeValue/);
  assert.throws(() => marshallItem({ id: "plain" }, "typed"), /AttributeValue/);
});

test("unmarshallItem returns plain JSON; big numbers stay exact strings; sets become arrays", () => {
  const item = {
    id: { S: "1" },
    count: { N: "42" },
    ratio: { N: "0.25" },
    big: { N: "123456789012345678901234567890" },
    tags: { SS: ["a", "b"] },
    scores: { NS: ["1", "2"] },
    blob: { B: "AQID" },
    flags: { L: [{ BOOL: true }, { NULL: true }] },
    meta: { M: { nested: { S: "x" } } },
  };
  assert.deepEqual(unmarshallItem(item), {
    id: "1",
    count: 42,
    ratio: 0.25,
    big: "123456789012345678901234567890",
    tags: ["a", "b"],
    scores: [1, 2],
    blob: "AQID",
    flags: [true, null],
    meta: { nested: "x" },
  });
  assert.deepEqual(unmarshallItem(item, "typed"), item);
  assert.equal(unmarshallItem(undefined), null);
});

test("cursors round-trip LastEvaluatedKey and reject tampering", () => {
  const lastKey = { pk: { S: "user#1" }, sk: { N: "5" } };
  assert.deepEqual(decodeCursor(encodeCursor(lastKey)), lastKey);
  assert.equal(encodeCursor(undefined), null);
  assert.throws(() => decodeCursor("not-base64-json"), /cursor/);
  assert.throws(() => decodeCursor(Buffer.from(JSON.stringify({ pk: "plain" })).toString("base64url")), /cursor/);
});
