/**
 * Convenience property mapping: `{name: plainValue}` to Notion property values, using the property types
 * of the target data source (or page).
 *
 * Supported types: title, rich_text, number, select, multi_select, status, date, checkbox, url, email,
 * phone_number. null (and "" for select, multi_select, url, email, phone_number) clears; a cleared checkbox is
 * unchecked. Any other type (people, relation, files, ...) must be sent as raw Notion JSON in `properties`.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { splitIntoRichText } from "./rich-text.mjs";

const MAX_OPTION_NAME_LENGTH = 100;
const MAX_URL_LENGTH = 2000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// Plain decimal only: Number() would also accept "0x10", "1e3", "Infinity" or "0b1".
const PLAIN_DECIMAL_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const BOOLEAN_TEXT = new Map([["true", true], ["false", false]]);

const VALUE_BUILDERS = {
  title: (value, name) => ({ title: buildRichText(value, name) }),
  rich_text: (value, name) => ({ rich_text: buildRichText(value, name) }),
  number: (value, name) => ({ number: buildNumber(value, name) }),
  select: (value, name) => ({ select: value === null || value === "" ? null : { name: buildOptionName(value, name) } }),
  status: (value, name) => ({ status: value === null ? null : { name: buildOptionName(value, name) } }),
  multi_select: (value, name) => ({ multi_select: buildMultiSelect(value, name) }),
  date: (value, name) => ({ date: buildDate(value, name) }),
  checkbox: (value, name) => ({ checkbox: buildCheckbox(value, name) }),
  url: (value, name) => ({ url: buildShortString(value, name, MAX_URL_LENGTH) }),
  email: (value, name) => ({ email: buildShortString(value, name, MAX_URL_LENGTH) }),
  phone_number: (value, name) => ({ phone_number: buildShortString(value, name, MAX_URL_LENGTH) }),
};

/**
 * Maps plain values to Notion property values.
 *
 * @param plainValues - `{propertyName: value}`; null clears a property (object)
 * @param propertyTypes - `{propertyName: notionType}` from readPropertyTypes (object)
 * @returns `{propertyName: notionPropertyValue}` ready for `properties` (object)
 * @throws PluginError kind `invalid_input` - Unknown property, unsupported type or a value of the wrong shape
 *
 * @example
 * buildPropertyValues({ Price: 10 }, { Price: "number" }); // { Price: { number: 10 } }
 */
export function buildPropertyValues(plainValues, propertyTypes) {
  return Object.fromEntries(
    Object.entries(plainValues).map(([propertyName, plainValue]) => [propertyName, buildOneValue(propertyName, plainValue, propertyTypes)]),
  );
}

/**
 * Reads `{name: type}` from a data source or page object's `properties`.
 *
 * @param notionObject - Data source or page (object)
 * @returns `{propertyName: type}` (object)
 */
export function readPropertyTypes(notionObject) {
  const properties = notionObject?.properties ?? {};
  return Object.fromEntries(Object.entries(properties).map(([propertyName, property]) => [propertyName, property?.type]));
}

function buildOneValue(propertyName, plainValue, propertyTypes) {
  if (!Object.hasOwn(propertyTypes, propertyName)) {
    const knownNames = Object.keys(propertyTypes).join(", ");
    rejectValue(`Unknown property ${JSON.stringify(propertyName)}; properties are: ${knownNames}`);
  }
  const propertyType = propertyTypes[propertyName];
  const buildValue = VALUE_BUILDERS[propertyType];
  if (!buildValue) {
    rejectValue(`Property ${JSON.stringify(propertyName)} has type ${propertyType}, which \`values\` cannot set; send it as Notion JSON in \`properties\``);
  }
  return buildValue(plainValue ?? null, propertyName);
}

function buildRichText(value, propertyName) {
  if (value === null) return [];
  if (!["string", "number", "boolean"].includes(typeof value)) rejectValue(`\`${propertyName}\` must be text`);
  return splitIntoRichText(String(value), propertyName);
}

function buildNumber(value, propertyName) {
  if (value === null) return null;
  const numericValue = typeof value === "string" && PLAIN_DECIMAL_PATTERN.test(value.trim()) ? Number(value) : value;
  if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) rejectValue(`\`${propertyName}\` must be a number`);
  return numericValue;
}

function buildOptionName(value, propertyName) {
  if (typeof value !== "string") rejectValue(`\`${propertyName}\` must be a string (the option name)`);
  if (value.length > MAX_OPTION_NAME_LENGTH) rejectValue(`\`${propertyName}\` option names are at most ${MAX_OPTION_NAME_LENGTH} characters`);
  return value;
}

// A string is a comma-separated list ("vip, jakarta"); Notion option names cannot contain commas.
function buildMultiSelect(value, propertyName) {
  if (value === null || value === "") return [];
  const optionNames = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(optionNames) || !optionNames.every((optionName) => typeof optionName === "string")) {
    rejectValue(`\`${propertyName}\` must be a string or an array of strings`);
  }
  const trimmedNames = optionNames.map((optionName) => optionName.trim());
  if (trimmedNames.some((optionName) => optionName === "")) rejectValue(`\`${propertyName}\` has an empty option name`);
  return trimmedNames.map((optionName) => ({ name: buildOptionName(optionName, propertyName) }));
}

function buildDate(value, propertyName) {
  if (value === null) return null;
  const dateValue = typeof value === "string" ? { start: value } : value;
  if (typeof dateValue !== "object" || Array.isArray(dateValue) || typeof dateValue.start !== "string") {
    rejectValue(`\`${propertyName}\` must be an ISO 8601 date string or {start, end?, time_zone?} with a start`);
  }
  for (const dateText of [dateValue.start, dateValue.end].filter((candidate) => candidate !== undefined && candidate !== null)) {
    if (typeof dateText !== "string" || !ISO_DATE_PATTERN.test(dateText)) rejectValue(`\`${propertyName}\` must use ISO 8601 dates, e.g. 2026-11-20 or 2026-11-20T09:00:00+07:00`);
  }
  return dateValue;
}

// null clears a checkbox, which in Notion means unchecked (a checkbox has no empty state).
function buildCheckbox(value, propertyName) {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  const parsedValue = typeof value === "string" ? BOOLEAN_TEXT.get(value.trim().toLowerCase()) : undefined;
  if (parsedValue === undefined) rejectValue(`\`${propertyName}\` must be a boolean`);
  return parsedValue;
}

function buildShortString(value, propertyName, maxLength) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") rejectValue(`\`${propertyName}\` must be a string`);
  if (value.length > maxLength) rejectValue(`\`${propertyName}\` is at most ${maxLength} characters`);
  return value;
}

function rejectValue(message) {
  throw new PluginError(message, { kind: "invalid_input" });
}
