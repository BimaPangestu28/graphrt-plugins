import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPropertyValues, readPropertyTypes } from "../lib/property-values.mjs";
import { buildParagraphBlocks, splitIntoRichText, MAX_TEXT_CONTENT_LENGTH } from "../lib/rich-text.mjs";

const SCHEMA_TYPES = {
  Name: "title",
  Notes: "rich_text",
  Price: "number",
  Stage: "select",
  Tags: "multi_select",
  Progress: "status",
  Due: "date",
  Done: "checkbox",
  Website: "url",
  Email: "email",
  Phone: "phone_number",
  Owner: "people",
};
const text = (content) => ({ type: "text", text: { content } });

// Each case: property name, convenience value -> expected Notion property value.
const MAPPING_CASES = [
  ["Name", "Acme Corp", { title: [text("Acme Corp")] }],
  ["Name", "", { title: [] }],
  ["Notes", "Called on Monday", { rich_text: [text("Called on Monday")] }],
  ["Notes", null, { rich_text: [] }],
  ["Notes", 42, { rich_text: [text("42")] }],
  ["Price", 1500.5, { number: 1500.5 }],
  ["Price", "1500", { number: 1500 }],
  ["Price", null, { number: null }],
  ["Stage", "Won", { select: { name: "Won" } }],
  ["Stage", null, { select: null }],
  ["Stage", "", { select: null }],
  ["Tags", "vip, jakarta ,vvip", { multi_select: [{ name: "vip" }, { name: "jakarta" }, { name: "vvip" }] }],
  ["Tags", [" vip "], { multi_select: [{ name: "vip" }] }],
  ["Tags", "", { multi_select: [] }],
  ["Price", " -12.5 ", { number: -12.5 }],
  ["Done", null, { checkbox: false }],
  ["Website", "", { url: null }],
  ["Email", "", { email: null }],
  ["Phone", "", { phone_number: null }],
  ["Tags", ["vip", "jakarta"], { multi_select: [{ name: "vip" }, { name: "jakarta" }] }],
  ["Tags", "vip", { multi_select: [{ name: "vip" }] }],
  ["Tags", null, { multi_select: [] }],
  ["Progress", "In progress", { status: { name: "In progress" } }],
  ["Due", "2026-11-20", { date: { start: "2026-11-20" } }],
  ["Due", { start: "2026-11-20T09:00:00", end: "2026-11-20T10:00:00", time_zone: "Asia/Jakarta" }, { date: { start: "2026-11-20T09:00:00", end: "2026-11-20T10:00:00", time_zone: "Asia/Jakarta" } }],
  ["Due", null, { date: null }],
  ["Done", true, { checkbox: true }],
  ["Done", "false", { checkbox: false }],
  ["Website", "https://example.com", { url: "https://example.com" }],
  ["Website", null, { url: null }],
  ["Email", "a@example.com", { email: "a@example.com" }],
  ["Phone", "+62 812 0000", { phone_number: "+62 812 0000" }],
];

for (const [propertyName, convenienceValue, expectedValue] of MAPPING_CASES) {
  test(`${SCHEMA_TYPES[propertyName]} ${JSON.stringify(convenienceValue)} maps to ${JSON.stringify(expectedValue)}`, () => {
    assert.deepEqual(buildPropertyValues({ [propertyName]: convenienceValue }, SCHEMA_TYPES), { [propertyName]: expectedValue });
  });
}

// Each case: property name, bad value, message pattern.
const REJECTED_CASES = [
  ["Price", "lots", /Price.*number/],
  ["Price", true, /Price.*number/],
  ["Price", "0x10", /Price.*number/],
  ["Price", "1e3", /Price.*number/],
  ["Price", "Infinity", /Price.*number/],
  ["Tags", "vip,,jakarta", /Tags.*empty/],
  ["Tags", ["vip", "  "], /Tags.*empty/],
  ["Stage", ["a", "b"], /Stage.*string/],
  ["Stage", "x".repeat(101), /Stage.*100 characters/],
  ["Tags", [1, { name: "x" }], /Tags.*strings/],
  ["Due", "next week", /Due.*ISO 8601/],
  ["Due", { end: "2026-11-20" }, /Due.*start/],
  ["Done", "maybe", /Done.*boolean/],
  ["Website", "x".repeat(2001), /Website.*2000/],
  ["Email", 5, /Email.*string/],
  ["Owner", "someone", /Owner.*people.*`properties`/],
  ["Unknown", "x", /Unknown property "Unknown".*Name, Notes/],
];

for (const [propertyName, badValue, messagePattern] of REJECTED_CASES) {
  test(`${propertyName} ${JSON.stringify(badValue).slice(0, 40)} is rejected as invalid_input`, () => {
    assert.throws(
      () => buildPropertyValues({ [propertyName]: badValue }, SCHEMA_TYPES),
      (error) => error.kind === "invalid_input" && messagePattern.test(error.message),
    );
  });
}

test("readPropertyTypes reads {name: {type}} from a data source or page", () => {
  const types = readPropertyTypes({ properties: { Name: { id: "title", type: "title", title: {} }, Price: { id: "a%3Db", type: "number" } } });
  assert.deepEqual(types, { Name: "title", Price: "number" });
  assert.deepEqual(readPropertyTypes({}), {});
});

test("splitIntoRichText cuts text at the 2000-character limit without splitting surrogate pairs", () => {
  const longText = "a".repeat(MAX_TEXT_CONTENT_LENGTH - 1) + "😀" + "b".repeat(10);
  const parts = splitIntoRichText(longText);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text.content, "a".repeat(MAX_TEXT_CONTENT_LENGTH - 1));
  assert.equal(parts[1].text.content, "😀" + "b".repeat(10));
  assert.equal(parts.map((part) => part.text.content).join(""), longText);
  assert.ok(parts.every((part) => part.text.content.length <= MAX_TEXT_CONTENT_LENGTH));
  assert.deepEqual(splitIntoRichText(""), []);
  assert.equal(splitIntoRichText("x".repeat(4000)).length, 2);
});

test("splitIntoRichText refuses text over 100 rich text items (200,000 characters)", () => {
  assert.throws(() => splitIntoRichText("x".repeat(200001), "Notes"), (error) => error.kind === "invalid_input" && /Notes.*200000/.test(error.message));
});

test("buildParagraphBlocks makes one paragraph block per string", () => {
  assert.deepEqual(buildParagraphBlocks(["Hello", ""]), [
    { object: "block", type: "paragraph", paragraph: { rich_text: [text("Hello")] } },
    { object: "block", type: "paragraph", paragraph: { rich_text: [] } },
  ]);
});
