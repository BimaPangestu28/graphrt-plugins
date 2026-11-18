import { test } from "node:test";
import assert from "node:assert/strict";
import { buildA1Range, columnLetters, quoteSheetName } from "../lib/a1-notation.mjs";
import { isInvalidInput } from "./helpers.mjs";

test("quoteSheetName wraps in single quotes and doubles apostrophes", () => {
  assert.equal(quoteSheetName("Sheet1"), "'Sheet1'");
  assert.equal(quoteSheetName("My Sheet"), "'My Sheet'");
  assert.equal(quoteSheetName("Jon's Data"), "'Jon''s Data'");
  assert.equal(quoteSheetName("''"), "''''''");
  assert.equal(quoteSheetName("A1"), "'A1'");
});

for (const [input, expectedRange] of [
  [{ sheet: "My Sheet", range: "A1:C" }, "'My Sheet'!A1:C"],
  [{ sheet: "Jon's", range: "$A$1" }, "'Jon''s'!$A$1"],
  [{ sheet: "Data" }, "'Data'"],
  [{ sheet: "Data", range: "A:A" }, "'Data'!A:A"],
  [{ sheet: "Data", range: "2:5" }, "'Data'!2:5"],
  [{ range: "A1:B2" }, "A1:B2"],
  [{ range: "MyNamedRange" }, "MyNamedRange"],
  [{ range: "My Sheet!B2" }, "'My Sheet'!B2"],
  [{ range: "Sheet1!A1:C10" }, "'Sheet1'!A1:C10"],
  [{ range: "Q&A!A1" }, "'Q&A'!A1"],
  [{ range: "'My Sheet'!A1:C" }, "'My Sheet'!A1:C"],
  [{ range: "'Jon''s Data'!A1" }, "'Jon''s Data'!A1"],
  [{ range: "'Wow!'!A1" }, "'Wow!'!A1"],
  [{ range: "'Only Sheet'" }, "'Only Sheet'"],
]) {
  test(`buildA1Range ${JSON.stringify(input)} -> ${expectedRange}`, () => {
    assert.equal(buildA1Range(input), expectedRange);
  });
}

for (const input of [
  {},
  { sheet: "" },
  { sheet: "S", range: "X!A1" },
  { range: "Sheet1!" },
  { range: "Sheet1!A1:B2:C3" },
  { range: "Sheet1!A1:" },
  { range: "Sheet1!ABCD1" },
  { range: "'Jon's'!A1" },
  { range: "'Unclosed!A1" },
  { range: "A1\nB2" },
]) {
  test(`buildA1Range rejects ${JSON.stringify(input)}`, () => {
    assert.throws(() => buildA1Range(input), isInvalidInput);
  });
}

test("columnLetters converts zero-based indexes", () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetters), ["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
});
