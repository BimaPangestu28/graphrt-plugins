/**
 * Validation of `extract` field specs and shaping of their results (pure functions).
 *
 * A field is either a CSS selector string (first match's text) or
 * `{selector, attribute?, all?}`. Selectors are run with `querySelectorAll`
 * inside a fixed in-page function: CSS only, never script.
 */
import { invalidInput } from "./errors.mjs";

export const MAX_FIELDS = 30;
export const MAX_SELECTOR_LENGTH = 500;
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z_:][-A-Za-z0-9_:.]{0,63}$/;

/**
 * Validates and normalises the `fields` argument.
 *
 * @param fields - `{name: "css" | {selector, attribute?, all?}}` (object)
 * @returns `[{name, selector, attribute, all}]` (object[])
 * @throws PluginError kind `invalid_input` - Empty, too many, or malformed fields
 *
 * @example
 * normalizeFieldSpecs({ title: "h1", links: { selector: "a.more", attribute: "href", all: true } });
 */
export function normalizeFieldSpecs(fields) {
  const entries = Object.entries(fields ?? {});
  if (entries.length === 0) throw invalidInput("`fields` must name at least one field, e.g. {\"title\": \"h1\"}");
  if (entries.length > MAX_FIELDS) throw invalidInput(`\`fields\` may have at most ${MAX_FIELDS} entries`);
  return entries.map(([name, spec]) => normalizeFieldSpec(name, spec));
}

function normalizeFieldSpec(name, spec) {
  if (!FIELD_NAME_PATTERN.test(name)) throw invalidInput(`Field name ${JSON.stringify(name)} must be letters, digits or _ (at most 64)`);
  const objectSpec = typeof spec === "string" ? { selector: spec } : spec;
  if (typeof objectSpec !== "object" || objectSpec === null || Array.isArray(objectSpec)) {
    throw invalidInput(`\`fields.${name}\` must be a CSS selector string or {selector, attribute?, all?}`);
  }
  const selector = String(objectSpec.selector ?? "").trim();
  if (!selector) throw invalidInput(`\`fields.${name}.selector\` is required`);
  if (selector.length > MAX_SELECTOR_LENGTH) throw invalidInput(`\`fields.${name}.selector\` must be at most ${MAX_SELECTOR_LENGTH} characters`);
  const attribute = objectSpec.attribute === undefined || objectSpec.attribute === null || objectSpec.attribute === "" ? null : String(objectSpec.attribute).trim();
  if (attribute !== null && !ATTRIBUTE_NAME_PATTERN.test(attribute)) throw invalidInput(`\`fields.${name}.attribute\` is not a valid attribute name`);
  return { name, selector, attribute, all: parseBoolean(objectSpec.all, `fields.${name}.all`) };
}

function parseBoolean(value, label) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  throw invalidInput(`\`${label}\` must be true or false`);
}

/**
 * Turns raw in-page results into the operation output.
 *
 * @param fieldSpecs - From normalizeFieldSpecs (object[])
 * @param rawResults - From extractFieldsInPage (object)
 * @returns `{fields: {name: value}, match_counts: {name: n}, errors: {name: message}}`; a single field's value is a
 *   string or null, an `all` field's value is a string array (object)
 */
export function shapeFieldResults(fieldSpecs, rawResults) {
  const shaped = { fields: {}, match_counts: {}, errors: {} };
  for (const fieldSpec of fieldSpecs) {
    const rawResult = rawResults?.[fieldSpec.name];
    if (!rawResult || rawResult.error) {
      shaped.fields[fieldSpec.name] = fieldSpec.all ? [] : null;
      shaped.errors[fieldSpec.name] = rawResult?.error ?? "no result";
      continue;
    }
    shaped.fields[fieldSpec.name] = fieldSpec.all ? rawResult.values : (rawResult.values[0] ?? null);
    shaped.match_counts[fieldSpec.name] = rawResult.matchCount;
  }
  return shaped;
}
