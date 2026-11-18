/**
 * Safe Airtable formula building for `find_records`.
 *
 * Values become literals that can never end early: strings are double-quoted with `\"`, `\n` and `\t` escapes,
 * and any other control character is refused. Backslashes are refused in values and field names: Airtable does
 * not document how its formula parser treats them, so an agent-supplied backslash is never sent. Field names
 * are wrapped in `{}`; Airtable has no escape for braces inside a reference, so names containing `{`, `}` or
 * control characters are refused too. For any of these, use `list_records` with `filter_by_formula` from a
 * workflow node.
 *
 * Types are never guessed: a boolean must be a JSON boolean (`true`, not `"true"`), a number a JSON number.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MATCH_MODES = ["exact", "case_insensitive", "contains"];
const MAX_CONDITIONS = 20;
const STRING_ESCAPES = { '"': '\\"', "\n": "\\n", "\t": "\\t" };
const BACKSLASH_REFUSAL =
  "find_records does not accept backslashes in values or field names; use list_records with filter_by_formula from a workflow node instead";
// Control characters other than \n and \t (incl. \r, which has no documented escape) are refused.
const UNESCAPABLE_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const PLAIN_DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Quotes text as an Airtable formula string literal.
 *
 * @param text - Any text (string)
 * @returns Double-quoted literal (string)
 * @throws PluginError kind `invalid_input` - Text with a backslash or a control character other than newline or tab
 *
 * @example
 * quoteFormulaString('Jon "J" Doe'); // "\"Jon \\\"J\\\" Doe\""
 */
export function quoteFormulaString(text) {
  if (text.includes("\\")) rejectFormulaInput(BACKSLASH_REFUSAL);
  if (UNESCAPABLE_CONTROL_PATTERN.test(text)) rejectFormulaInput("Values must not contain control characters other than newline and tab");
  return `"${text.replace(/["\n\t]/g, (character) => STRING_ESCAPES[character])}"`;
}

/**
 * Formats a value as a formula literal: string, plain decimal number, TRUE()/FALSE(), or BLANK() for null.
 *
 * @param value - Value to compare against (string | number | boolean | null)
 * @returns Formula literal (string)
 * @throws PluginError kind `invalid_input` - Objects, arrays, non-finite numbers or numbers needing an exponent
 */
export function formatFormulaLiteral(value) {
  if (value === null || value === undefined) return "BLANK()";
  if (typeof value === "string") return quoteFormulaString(value);
  if (typeof value === "boolean") return value ? "TRUE()" : "FALSE()";
  if (typeof value === "number" && PLAIN_DECIMAL_PATTERN.test(String(value))) return String(value);
  return rejectFormulaInput(`Cannot compare with ${JSON.stringify(value) ?? String(value)}: use a string, a plain number, true/false or null`);
}

/**
 * Formats a field name as a `{Field name}` reference.
 *
 * @param fieldName - Field name (string)
 * @returns Field reference (string)
 * @throws PluginError kind `invalid_input` - Empty names, or names with braces, backslashes or control characters
 */
export function formatFieldReference(fieldName) {
  if (typeof fieldName === "string" && fieldName.includes("\\")) rejectFormulaInput(BACKSLASH_REFUSAL);
  if (typeof fieldName !== "string" || fieldName === "" || /[{}\u0000-\u001f\u007f]/.test(fieldName)) {
    rejectFormulaInput(`Field name ${JSON.stringify(fieldName)} cannot be used in find_records (no braces or control characters); use list_records with filter_by_formula`);
  }
  return `{${fieldName}}`;
}

/**
 * Builds a formula that matches records where every field equals (or contains) its value.
 * Strings compare as text (`{Field} & ""`), so single-select, linked-record and lookup fields match their
 * display text; numbers and booleans compare exactly in every mode, and null matches an empty field
 * (`LEN({Field} & "") = 0`, which also covers empty linked-record and multi-select fields).
 *
 * @param conditions - `{fieldName: value}` (object)
 * @param matchMode - "exact", "case_insensitive" or "contains" (case-insensitive substring) (string)
 * @returns Formula for filterByFormula (string)
 * @throws PluginError kind `invalid_input` - No conditions, more than 20, an unusable field/value, or `contains` ""
 *
 * @example
 * buildMatchFormula({ Email: "a@b.co", Active: true }, "exact"); // 'AND({Email} & "" = "a@b.co", {Active} = TRUE())'
 */
export function buildMatchFormula(conditions, matchMode) {
  const entries = Object.entries(conditions ?? {});
  if (entries.length === 0) rejectFormulaInput("`where` needs at least one {field: value} condition");
  if (entries.length > MAX_CONDITIONS) rejectFormulaInput(`\`where\` takes at most ${MAX_CONDITIONS} conditions`);
  const comparisons = entries.map(([fieldName, value]) => buildComparison(formatFieldReference(fieldName), value, matchMode));
  return comparisons.length === 1 ? comparisons[0] : `AND(${comparisons.join(", ")})`;
}

function buildComparison(fieldReference, value, matchMode) {
  const fieldText = `${fieldReference} & ""`;
  if (value === null || value === undefined) return `LEN(${fieldText}) = 0`;
  const literal = formatFormulaLiteral(value);
  if (typeof value !== "string") return `${fieldReference} = ${literal}`;
  if (matchMode === "contains" && value === "") rejectFormulaInput("`match: contains` needs a non-empty text value (\"\" would match every record)");
  if (matchMode === "case_insensitive") return `LOWER(${fieldText}) = LOWER(${literal})`;
  if (matchMode === "contains") return `FIND(LOWER(${literal}), LOWER(${fieldText})) > 0`;
  return `${fieldText} = ${literal}`;
}

function rejectFormulaInput(message) {
  throw new PluginError(message, { kind: "invalid_input" });
}
