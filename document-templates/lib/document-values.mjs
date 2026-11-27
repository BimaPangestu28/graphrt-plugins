/**
 * Reads the values of a document (from the call or from a JSON file) and
 * prepares them: defaults for date, currency and language, format settings,
 * and the invoice calculation.
 */
import { invalidInput } from "./errors.mjs";
import { formatMoney, readFormatSettings } from "./formatting.mjs";
import { calculateInvoice, hasLineItems } from "./invoice-totals.mjs";

export const CALCULATE_CHOICES = ["auto", "invoice", "none"];
const MAX_VALUES_BYTES = 2 * 1024 * 1024;

/** Schemas of the parameters that carry a document's values. */
export const VALUES_PARAMETERS = {
  values: { type: "object", description: "The document's values as an object (or JSON text), e.g. {\"number\": \"INV-2026-0001\", \"client\": {\"name\": \"PT Maju\"}, \"items\": [...]}. describe_template lists what a template uses" },
  values_file: { type: "string", description: "Instead of `values`: a .json file with the values, in your templates folder" },
};

/** Schema of the `calculate` parameter. */
export const CALCULATE_PARAMETER = {
  type: "string",
  enum: CALCULATE_CHOICES,
  default: "auto",
  description: "invoice: calculate line amounts, subtotal, discount, taxes and totals from `items` (exact decimals) and add them as `totals`; none: use the values as given; auto (default): a layout template decides (the built-in invoice calculates), a Word or PDF form template calculates when the values have `items`",
};

/**
 * Reads `values` or `values_file`.
 *
 * @param client - From createDocumentClient (object)
 * @param args - Validated arguments with `values` and `values_file` (object)
 * @param options - `{isRequired}` (object)
 * @returns The values (object)
 * @throws PluginError kind `invalid_input` - When both or neither are given, or the content is not a JSON object within the size cap
 */
export async function readValues(client, args, { isRequired = true } = {}) {
  if (args.values !== undefined && args.values_file !== undefined) throw invalidInput("Pass `values` or `values_file`, not both");
  if (args.values_file !== undefined) {
    const file = await client.fileAccess.readInputFile(args.values_file, { parameterName: "values_file", extensions: ["json"] });
    return parseValuesText(file.bytes.toString("utf8"), "`values_file`");
  }
  if (args.values === undefined) {
    if (isRequired) throw invalidInput("`values` is required: the document's values as an object, or `values_file` for a .json file");
    return {};
  }
  if (JSON.stringify(args.values).length > MAX_VALUES_BYTES) throw invalidInput(`\`values\` is larger than ${MAX_VALUES_BYTES} bytes`);
  return structuredClone(args.values);
}

function parseValuesText(text, label) {
  if (text.length > MAX_VALUES_BYTES) throw invalidInput(`${label} is larger than ${MAX_VALUES_BYTES} bytes`);
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch (parseError) {
    throw invalidInput(`${label} is not valid JSON: ${parseError.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalidInput(`${label} must be a JSON object such as {"number": "INV-2026-0001"}`);
  return parsed;
}

/**
 * Adds defaults and, when asked, the invoice calculation.
 *
 * @param rawValues - Values as given (object)
 * @param options - `{calculate, templateCalculates, now}`; templateCalculates is whether a layout template declares "calculate": "invoice", or null for formats that cannot say (object)
 * @returns `{values, settings, isCalculated}` (object)
 * @throws PluginError kind `invalid_input` - When a setting or an amount is invalid
 */
export function prepareValues(rawValues, { calculate, templateCalculates, now }) {
  const settings = readFormatSettings(rawValues);
  const today = toLocalIsoDate(now);
  const values = { ...rawValues, date: isPresent(rawValues.date) ? rawValues.date : today, currency: settings.currency, language: settings.language };
  const isCalculated = calculate === "invoice" || (calculate === "auto" && (templateCalculates ?? hasLineItems(values)));
  return { values: isCalculated ? calculateInvoice(values, settings.decimals) : values, settings, isCalculated, today };
}

/**
 * Summarises calculated totals for an operation's result.
 *
 * @param values - Calculated values (object)
 * @param settings - Format settings (object)
 * @returns `{currency, subtotal, discount, tax_total, total, amount_paid, balance_due, total_text, balance_due_text}` (object)
 */
export function summariseTotals(values, settings) {
  const { subtotal, discount, tax_total: taxTotal, total, amount_paid: amountPaid, balance_due: balanceDue } = values.totals;
  return { currency: settings.currency, subtotal, discount, tax_total: taxTotal, total, amount_paid: amountPaid, balance_due: balanceDue, total_text: formatMoney(total, settings), balance_due_text: formatMoney(balanceDue, settings) };
}

function toLocalIsoDate(now) {
  const pad = (numericValue) => String(numericValue).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}
