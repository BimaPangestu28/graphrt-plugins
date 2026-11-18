import { test } from "node:test";
import assert from "node:assert/strict";
import { validateArguments } from "../lib/params.mjs";

const schema = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
    ratio: { type: "number" },
    published: { type: "boolean", default: true },
    visibility: { type: "string", enum: ["PUBLIC", "CONNECTIONS"] },
    media_urls: { type: "array", items: { type: "string" }, maxItems: 3 },
    extra: { type: "object" },
  },
  required: ["message"],
};

test("validateArguments applies defaults and keeps provided values", () => {
  assert.deepEqual(validateArguments(schema, { message: "hi" }), { message: "hi", limit: 25, published: true });
});

test("validateArguments coerces template strings to declared scalar types", () => {
  assert.deepEqual(validateArguments(schema, { message: "hi", limit: "10", ratio: "1.5", published: "false" }), {
    message: "hi",
    limit: 10,
    ratio: 1.5,
    published: false,
  });
});

test("validateArguments parses a JSON array string for array fields", () => {
  assert.deepEqual(validateArguments(schema, { message: "hi", media_urls: '["a","b"]' }).media_urls, ["a", "b"]);
});

test("validateArguments drops null and empty-string optional values", () => {
  assert.deepEqual(validateArguments(schema, { message: "hi", visibility: "", ratio: null }), {
    message: "hi",
    limit: 25,
    published: true,
  });
});

test("validateArguments ignores unknown properties", () => {
  assert.equal("title" in validateArguments(schema, { message: "hi", title: "node title" }), false);
});

for (const [label, invalidArguments, fieldName] of [
  ["missing required", {}, "message"],
  ["empty required string", { message: "" }, "message"],
  ["integer below minimum", { message: "x", limit: 0 }, "limit"],
  ["integer above maximum", { message: "x", limit: 101 }, "limit"],
  ["fractional integer", { message: "x", limit: "2.5" }, "limit"],
  ["not in enum", { message: "x", visibility: "SECRET" }, "visibility"],
  ["wrong array item type", { message: "x", media_urls: [1] }, "media_urls"],
  ["too many array items", { message: "x", media_urls: ["a", "b", "c", "d"] }, "media_urls"],
  ["object given a string", { message: "x", extra: "nope" }, "extra"],
  ["boolean given garbage", { message: "x", published: "maybe" }, "published"],
]) {
  test(`validateArguments rejects ${label}`, () => {
    assert.throws(
      () => validateArguments(schema, invalidArguments),
      (error) => error.kind === "invalid_input" && error.message.includes(fieldName),
    );
  });
}
