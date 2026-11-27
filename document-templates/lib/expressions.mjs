/**
 * The placeholder language of every template format: `{{client.name}}`,
 * `{{totals.total | money}}`, `{{date | date:long}}`.
 *
 * A placeholder is a value (a dotted path into the document's values, or a
 * quoted text, number, true or false), optionally compared with `==` or `!=`
 * or negated with `not`, followed by filters. There is no arithmetic, no
 * function call and no access to anything but the values: a template is
 * data, never code. Paths read own properties only, so `__proto__` and
 * `constructor` lead nowhere.
 */
import { invalidInput } from "./errors.mjs";
import { formatDate, formatMoney, formatNumber } from "./formatting.mjs";

const PLACEHOLDER_PATTERN = /\{\{([\s\S]*?)\}\}/g;
const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const MAX_EXPRESSION_LENGTH = 300;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

const FILTERS = {
  money: (value, [style], settings) => formatMoney(value, settings, style ?? settings.currencyStyle),
  amount: (value, _args, settings) => formatNumber(value, settings, settings.decimals),
  number: (value, [digits], settings) => formatNumber(value, settings, digits === undefined ? undefined : readDigits(digits)),
  percent: (value, _args, settings) => (isBlank(value) ? "" : `${formatNumber(value, settings)}%`),
  date: (value, [style], settings) => (isBlank(value) ? "" : formatDate(value, settings, style ?? "long")),
  upper: (value) => toDisplayText(value).toUpperCase(),
  lower: (value) => toDisplayText(value).toLowerCase(),
  default: (value, [fallback]) => (isBlank(value) ? (fallback ?? "") : value),
  join: (value, [separator]) => (Array.isArray(value) ? value.map(toDisplayText).filter(Boolean).join(separator ?? ", ") : value),
};

/** Names of the filters a placeholder may use. */
export const FILTER_NAMES = Object.freeze(Object.keys(FILTERS));

/**
 * A chain of variable scopes: a loop adds its item on top of the document's values.
 */
export class Scope {
  /**
   * @param variables - Names visible in this scope (object)
   * @param parent - Enclosing scope (Scope, optional)
   */
  constructor(variables, parent = null) {
    this.variables = variables;
    this.parent = parent;
  }

  /**
   * Creates a scope on top of this one.
   *
   * @param variables - Names added by the inner scope (object)
   * @returns The inner scope (Scope)
   */
  child(variables) {
    return new Scope(variables, this);
  }

  /**
   * Looks a name up, innermost scope first.
   *
   * @param name - First segment of a path (string)
   * @returns The value, or undefined (any)
   */
  lookup(name) {
    for (let scope = this; scope; scope = scope.parent) {
      if (isOwn(scope.variables, name)) return scope.variables[name];
    }
    return undefined;
  }
}

/**
 * Parses one placeholder body.
 *
 * @param source - Text between `{{` and `}}`, e.g. "totals.total | money:code" (string)
 * @returns `{source, isNegated, left, operator, right, filters}` (object)
 * @throws PluginError kind `invalid_input` - When the placeholder is malformed or names an unknown filter
 */
export function parseExpression(source) {
  const trimmed = String(source).trim();
  if (trimmed === "" || trimmed.length > MAX_EXPRESSION_LENGTH) throw templateError(source, "is empty or too long");
  const [valuePart, ...filterParts] = splitOutsideQuotes(trimmed, "|");
  const isNegated = /^not\s+/.test(valuePart.trim());
  const comparison = splitComparison(isNegated ? valuePart.trim().replace(/^not\s+/, "") : valuePart.trim());
  return {
    source: trimmed,
    isNegated,
    left: parseOperand(comparison.left, source),
    operator: comparison.operator,
    right: comparison.operator ? parseOperand(comparison.right, source) : null,
    filters: filterParts.map((filterPart) => parseFilter(filterPart, source)),
  };
}

function splitComparison(text) {
  for (const operator of ["==", "!="]) {
    const parts = splitOutsideQuotes(text, operator);
    if (parts.length === 2) return { left: parts[0].trim(), operator, right: parts[1].trim() };
  }
  return { left: text, operator: null, right: null };
}

function parseOperand(text, source) {
  const literal = parseLiteral(text);
  if (literal) return literal;
  if (!PATH_PATTERN.test(text)) throw templateError(source, `has an invalid name ${JSON.stringify(text)} (use letters, digits, _ and dots, e.g. client.name)`);
  const segments = text.split(".");
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) throw templateError(source, "uses a name that is not allowed");
  return { kind: "path", segments };
}

function parseLiteral(text) {
  const quoted = /^"([^"]*)"$/.exec(text) ?? /^'([^']*)'$/.exec(text);
  if (quoted) return { kind: "literal", value: quoted[1] };
  if (/^-?\d+(\.\d+)?$/.test(text)) return { kind: "literal", value: Number(text) };
  if (text === "true" || text === "false") return { kind: "literal", value: text === "true" };
  return null;
}

function parseFilter(filterPart, source) {
  const [name, ...rawArguments] = splitOutsideQuotes(filterPart.trim(), ":").map((part) => part.trim());
  if (!isOwn(FILTERS, name)) throw templateError(source, `uses the unknown filter ${JSON.stringify(name)} (filters: ${FILTER_NAMES.join(", ")})`);
  return { name, args: rawArguments.map((argument) => parseLiteral(argument)?.value ?? argument) };
}

// Splits on a separator, leaving separators inside "..." or '...' alone.
function splitOutsideQuotes(text, separator) {
  const parts = [];
  let current = "";
  let openQuote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (openQuote) {
      if (character === openQuote) openQuote = null;
    } else if (character === '"' || character === "'") {
      openQuote = character;
    } else if (text.startsWith(separator, index)) {
      parts.push(current);
      current = "";
      index += separator.length - 1;
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/**
 * Evaluates a parsed placeholder.
 *
 * @param expression - From parseExpression (object)
 * @param scope - Variables (Scope)
 * @param settings - Format settings from readFormatSettings (object)
 * @returns The value after comparison, negation and filters (any)
 */
export function evaluateExpression(expression, scope, settings) {
  let value = readOperand(expression.left, scope);
  if (expression.operator) {
    const isEqual = toComparable(value) === toComparable(readOperand(expression.right, scope));
    value = expression.operator === "==" ? isEqual : !isEqual;
  }
  if (expression.isNegated) value = !isTruthy(value);
  for (const filter of expression.filters) value = FILTERS[filter.name](value, filter.args, settings);
  return value;
}

function readOperand(operand, scope) {
  if (operand.kind === "literal") return operand.value;
  let value = scope.lookup(operand.segments[0]);
  for (const segment of operand.segments.slice(1)) {
    if (value === null || typeof value !== "object" || !isOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function toComparable(value) {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * Replaces every `{{...}}` in a text.
 *
 * @param text - Template text (string)
 * @param scope - Variables (Scope)
 * @param settings - Format settings (object)
 * @returns The text with placeholders filled; missing values become "" and lists become lines (string)
 * @throws PluginError kind `invalid_input` - When a placeholder is malformed or resolves to an object
 *
 * @example
 * interpolate("Dear {{client.name}}", new Scope({ client: { name: "PT Maju" } }), settings); // "Dear PT Maju"
 */
export function interpolate(text, scope, settings) {
  if (!text.includes("{{")) return text;
  // Checked on the template text, not the result: a value may itself contain "{{".
  if (text.replace(PLACEHOLDER_PATTERN, "").includes("{{")) throw invalidInput(`The template text ${JSON.stringify(text.slice(0, 80))} has a \`{{\` without a closing \`}}\``);
  return text.replace(PLACEHOLDER_PATTERN, (_match, body) => toDisplayText(evaluateExpression(parseExpression(body), scope, settings), body));
}

/**
 * Lists the placeholders of a text.
 *
 * @param text - Template text (string)
 * @returns Placeholder bodies, trimmed (string[])
 */
export function listPlaceholders(text) {
  return [...String(text).matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1].trim());
}

/**
 * Turns a value into the text shown in a document.
 *
 * @param value - Any JSON value (any)
 * @param source - Placeholder body, for the message (string, optional)
 * @returns "" for null and undefined, lines for a list, the text otherwise (string)
 * @throws PluginError kind `invalid_input` - When the value is an object
 */
export function toDisplayText(value, source = "") {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((entry) => toDisplayText(entry, source)).join("\n");
  if (typeof value === "object") throw invalidInput(`The placeholder {{${String(source).trim()}}} is a group of fields, not a text; name one field of it (for example ${String(source).trim().split("|")[0].trim()}.name)`);
  return String(value);
}

/**
 * Truth of a value for `$if` and `not`: empty text, 0, false, null, empty lists and empty objects are false.
 *
 * @param value - Any JSON value (any)
 * @returns Whether the value counts as present (boolean)
 */
export function isTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function isBlank(value) {
  return value === undefined || value === null || value === "";
}

function readDigits(rawDigits) {
  const digits = Number(rawDigits);
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) throw invalidInput(`The number filter takes 0 to 10 decimals, got ${JSON.stringify(rawDigits)}`);
  return digits;
}

function isOwn(target, key) {
  return target !== null && typeof target === "object" && Object.prototype.hasOwnProperty.call(target, key);
}

function templateError(source, problem) {
  return invalidInput(`The placeholder {{${String(source).trim().slice(0, 80)}}} ${problem}`);
}
