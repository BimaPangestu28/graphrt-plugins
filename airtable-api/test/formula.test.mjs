import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatchFormula, formatFieldReference, formatFormulaLiteral, quoteFormulaString } from "../lib/formula.mjs";

/**
 * Reads one Airtable double-quoted string literal starting at `startIndex` (which must be `"`), the way the
 * formula parser does: backslash escapes \" \\ \n \t. Returns the decoded text and the index after the closing quote.
 */
function readStringLiteral(formula, startIndex) {
  assert.equal(formula[startIndex], '"');
  const escapes = { '"': '"', "\\": "\\", n: "\n", t: "\t" };
  let decoded = "";
  for (let index = startIndex + 1; index < formula.length; index += 1) {
    const character = formula[index];
    if (character === '"') return { decoded, endIndex: index + 1 };
    if (character === "\\") {
      index += 1;
      assert.ok(formula[index] in escapes, `unknown escape \\${formula[index]}`);
      decoded += escapes[formula[index]];
    } else {
      assert.ok(character !== "\n" && character !== "\r", "raw line break inside a literal");
      decoded += character;
    }
  }
  throw new Error("unterminated string literal");
}

const INJECTION_ATTEMPTS = [
  'Budi"',
  '", TRUE()) & ("',
  '" = "" , 1=1, "',
  "back\\slash",
  'ends with backslash\\',
  '\\"); DELETE',
  '\\\\"',
  "{Secret Field}",
  "}{",
  "line one\nline two",
  'new"\nline\\',
  "tab\there",
  "'single' quotes",
  "emoji 😀 and ümlaut",
  "",
];

const isBackslashRefusal = (error) => error.kind === "invalid_input" && /backslash/.test(error.message) && /list_records/.test(error.message);

// Every attempt is either refused (backslashes) or kept inside exactly one literal.
for (const attempt of INJECTION_ATTEMPTS) {
  const isRefused = attempt.includes("\\");
  test(`quoteFormulaString ${isRefused ? "refuses" : "keeps inside one literal"} ${JSON.stringify(attempt)}`, () => {
    if (isRefused) return assert.throws(() => quoteFormulaString(attempt), isBackslashRefusal);
    const literal = quoteFormulaString(attempt);
    const { decoded, endIndex } = readStringLiteral(literal, 0);
    assert.equal(decoded, attempt);
    assert.equal(endIndex, literal.length, "the literal must end exactly at its closing quote");
  });

  test(`buildMatchFormula with ${JSON.stringify(attempt)} is refused or compares one field to exactly that value`, () => {
    if (isRefused) return assert.throws(() => buildMatchFormula({ Name: attempt }, "exact"), isBackslashRefusal);
    const formula = buildMatchFormula({ Name: attempt }, "exact");
    const prefix = '{Name} & "" = ';
    assert.ok(formula.startsWith(prefix));
    const { decoded, endIndex } = readStringLiteral(formula, prefix.length);
    assert.equal(decoded, attempt);
    assert.equal(endIndex, formula.length);
  });
}

test("the injection list still contains backslash attempts (refused) and quote attempts (escaped)", () => {
  assert.ok(INJECTION_ATTEMPTS.filter((attempt) => attempt.includes("\\")).length >= 4);
  assert.ok(INJECTION_ATTEMPTS.filter((attempt) => !attempt.includes("\\") && attempt.includes('"')).length >= 3);
});

test("buildMatchFormula refuses `contains` with an empty string (it would match every record)", () => {
  assert.throws(() => buildMatchFormula({ Name: "" }, "contains"), (error) => error.kind === "invalid_input" && /contains/.test(error.message));
});

test("quoteFormulaString rejects control characters that have no formula escape", () => {
  for (const badValue of ["carriage\rreturn", "nul\u0000byte", "bell\u0007", "del\u007f"]) {
    assert.throws(() => quoteFormulaString(badValue), (error) => error.kind === "invalid_input" && /control character/.test(error.message));
  }
});

// Each case: value -> literal.
const LITERAL_CASES = [
  ["Acme", '"Acme"'],
  [42, "42"],
  [-3.5, "-3.5"],
  [true, "TRUE()"],
  [false, "FALSE()"],
  [null, "BLANK()"],
];

for (const [value, expectedLiteral] of LITERAL_CASES) {
  test(`formatFormulaLiteral(${JSON.stringify(value)}) is ${expectedLiteral}`, () => {
    assert.equal(formatFormulaLiteral(value), expectedLiteral);
  });
}

test("formatFormulaLiteral rejects numbers it cannot write exactly and objects", () => {
  for (const badValue of [Number.NaN, Infinity, 1e21, 1e-7, { a: 1 }, ["a"]]) {
    assert.throws(() => formatFormulaLiteral(badValue), (error) => error.kind === "invalid_input");
  }
});

test("formatFieldReference wraps names in braces and refuses names that could break out", () => {
  assert.equal(formatFieldReference("Email Address"), "{Email Address}");
  assert.equal(formatFieldReference('Jon\'s "Notes"'), '{Jon\'s "Notes"}');
  for (const badName of ["", "a}b", "a{b", "} & TRUE() & {", "line\nbreak"]) {
    assert.throws(() => formatFieldReference(badName), (error) => error.kind === "invalid_input");
  }
  assert.throws(() => formatFieldReference("back\\slash"), isBackslashRefusal);
});

// Each case: conditions, match mode -> formula.
const FORMULA_CASES = [
  [{ Email: "a@b.co" }, "exact", '{Email} & "" = "a@b.co"'],
  [{ Email: "A@B.co" }, "case_insensitive", 'LOWER({Email} & "") = LOWER("A@B.co")'],
  [{ Name: "acme" }, "contains", 'FIND(LOWER("acme"), LOWER({Name} & "")) > 0'],
  [{ Qty: 3 }, "contains", "{Qty} = 3"],
  [{ Done: true, Owner: null }, "exact", 'AND({Done} = TRUE(), LEN({Owner} & "") = 0)'],
  [{ Owner: null }, "contains", 'LEN({Owner} & "") = 0'],
  [{ Name: "" }, "exact", '{Name} & "" = ""'],
  [{ Status: "Open", Region: "ID" }, "exact", 'AND({Status} & "" = "Open", {Region} & "" = "ID")'],
];

for (const [conditions, matchMode, expectedFormula] of FORMULA_CASES) {
  test(`buildMatchFormula ${JSON.stringify(conditions)} ${matchMode}`, () => {
    assert.equal(buildMatchFormula(conditions, matchMode), expectedFormula);
  });
}

test("buildMatchFormula needs at least one condition and at most 20", () => {
  assert.throws(() => buildMatchFormula({}, "exact"), (error) => error.kind === "invalid_input" && /at least one/.test(error.message));
  const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`F${index}`, index]));
  assert.throws(() => buildMatchFormula(tooMany, "exact"), (error) => error.kind === "invalid_input" && /at most 20/.test(error.message));
});
