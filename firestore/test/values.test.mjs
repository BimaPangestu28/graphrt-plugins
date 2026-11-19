import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeDocument, decodeFields, encodeFields, encodeValue, quoteFieldPath } from "../lib/firestore-values.mjs";
import { checkCollectionPath, checkDocumentPath } from "../lib/document-paths.mjs";

test("encodeValue maps plain JSON and typed wrappers to Firestore values", () => {
  assert.deepEqual(encodeValue(null), { nullValue: null });
  assert.deepEqual(encodeValue(true), { booleanValue: true });
  assert.deepEqual(encodeValue(42), { integerValue: "42" });
  assert.deepEqual(encodeValue(1.5), { doubleValue: 1.5 });
  assert.deepEqual(encodeValue("x"), { stringValue: "x" });
  assert.deepEqual(encodeValue([1, "a"]), { arrayValue: { values: [{ integerValue: "1" }, { stringValue: "a" }] } });
  assert.deepEqual(encodeValue({ a: { b: false } }), { mapValue: { fields: { a: { mapValue: { fields: { b: { booleanValue: false } } } } } } });
  assert.deepEqual(encodeValue({ timestampValue: "2026-11-19T10:00:00Z" }), { timestampValue: "2026-11-19T10:00:00Z" });
  assert.deepEqual(encodeValue({ integerValue: "9007199254740993" }), { integerValue: "9007199254740993" });
  assert.deepEqual(encodeValue({ doubleValue: 2 }), { doubleValue: 2 });
  assert.deepEqual(encodeValue({ bytesValue: "AQID" }), { bytesValue: "AQID" });
  assert.deepEqual(encodeValue({ geoPointValue: { latitude: -6.2, longitude: 106.8 } }), { geoPointValue: { latitude: -6.2, longitude: 106.8 } });
  assert.deepEqual(encodeValue({ referenceValue: "projects/p/databases/(default)/documents/users/u1" }), { referenceValue: "projects/p/databases/(default)/documents/users/u1" });
});

test("encodeValue refuses values Firestore cannot store exactly", () => {
  assert.throws(() => encodeValue(2 ** 60), /exact/);
  assert.throws(() => encodeValue(Number.POSITIVE_INFINITY), /finite/);
  assert.throws(() => encodeValue({ timestampValue: "yesterday" }), /RFC 3339/);
  assert.throws(() => encodeValue({ integerValue: "1.5" }), /integer/);
  assert.throws(() => encodeValue({ geoPointValue: { latitude: 200, longitude: 0 } }), /latitude/);
  assert.throws(() => encodeValue({ bytesValue: "not base64!" }), /base64/);
  assert.throws(() => encodeValue([[1]]), /array.*array/i);
  assert.throws(() => encodeFields([1]), /object/);
});

test("typed format passes Firestore values through after checking their shape", () => {
  const typedFields = { n: { integerValue: "5" }, tags: { arrayValue: { values: [{ stringValue: "a" }] } } };
  assert.deepEqual(encodeFields(typedFields, "typed"), typedFields);
  assert.throws(() => encodeFields({ n: 5 }, "typed"), /Firestore value/);
  assert.throws(() => encodeFields({ n: { integerValue: "5", stringValue: "x" } }, "typed"), /Firestore value/);
});

test("decodeFields returns plain JSON; big integers stay exact strings", () => {
  const fields = {
    n: { integerValue: "42" },
    big: { integerValue: "9007199254740993" },
    d: { doubleValue: 0.5 },
    nan: { doubleValue: "NaN" },
    at: { timestampValue: "2026-11-19T10:00:00.123456Z" },
    blob: { bytesValue: "AQID" },
    ref: { referenceValue: "projects/p/databases/(default)/documents/users/u1" },
    geo: { geoPointValue: { latitude: 1, longitude: 2 } },
    list: { arrayValue: { values: [{ nullValue: null }, { booleanValue: true }] } },
    emptyList: { arrayValue: {} },
    map: { mapValue: { fields: { s: { stringValue: "x" } } } },
    emptyMap: { mapValue: {} },
  };
  assert.deepEqual(decodeFields(fields), {
    n: 42,
    big: "9007199254740993",
    d: 0.5,
    nan: "NaN",
    at: "2026-11-19T10:00:00.123456Z",
    blob: "AQID",
    ref: "projects/p/databases/(default)/documents/users/u1",
    geo: { latitude: 1, longitude: 2 },
    list: [null, true],
    emptyList: [],
    map: { s: "x" },
    emptyMap: {},
  });
  assert.deepEqual(decodeFields(fields, "typed"), fields);
});

test("decodeDocument names the document by id and relative path", () => {
  const document = { name: "projects/p/databases/(default)/documents/users/u%201/orders/o1", fields: { total: { integerValue: "3" } }, createTime: "c", updateTime: "u" };
  assert.deepEqual(decodeDocument(document), { id: "o1", path: "users/u 1/orders/o1", fields: { total: 3 }, create_time: "c", update_time: "u" });
});

test("quoteFieldPath backquotes segments that are not simple identifiers", () => {
  assert.equal(quoteFieldPath("status"), "status");
  assert.equal(quoteFieldPath("first name"), "`first name`");
  assert.equal(quoteFieldPath("a`b\\c"), "`a\\`b\\\\c`");
});

test("document and collection paths are checked segment by segment", () => {
  assert.equal(checkDocumentPath("users/u 1"), "users/u%201");
  assert.equal(checkCollectionPath("users/u1/orders"), "users/u1/orders");
  assert.throws(() => checkDocumentPath("users"), /document path/);
  assert.throws(() => checkCollectionPath("users/u1"), /collection path/);
  for (const badPath of ["users//u1", "users/../x", "/users/u1", "users/./u1", "users/u1/"]) {
    assert.throws(() => checkDocumentPath(badPath), /segment|path/, badPath);
  }
});
