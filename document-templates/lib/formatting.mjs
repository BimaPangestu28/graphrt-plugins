/**
 * Locale-aware text for money, numbers and dates, from exact decimal strings.
 *
 * `Intl.NumberFormat` takes decimal strings without converting them to
 * binary floating point, so "1500000.50" is formatted digit for digit.
 * Settings come from the document's own values (`currency`, `language`,
 * `locale`, `decimals`, `currency_style`).
 */
import { invalidInput } from "./errors.mjs";

const DEFAULT_LOCALES = { en: "en-GB", id: "id-ID" };
const DEFAULT_CURRENCIES = { en: "USD", id: "IDR" };
const CURRENCY_STYLES = ["auto", "code", "symbol"];
const DATE_STYLES = {
  long: { day: "numeric", month: "long", year: "numeric" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  short: { day: "2-digit", month: "2-digit", year: "numeric" },
};
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/;
const MAX_DECIMALS = 4;
// Symbols shared by several currencies ("$" is USD, SGD, AUD...; "¥" is JPY and CNY) read wrongly on an invoice.
const AMBIGUOUS_SYMBOL_PATTERN = /[$¥]/;

/**
 * Reads the formatting settings from a document's values.
 *
 * @param values - Document values (object)
 * @returns `{language, locale, currency, decimals, currencyStyle}` (object)
 * @throws PluginError kind `invalid_input` - When `language`, `locale`, `currency`, `decimals` or `currency_style` is invalid
 *
 * @example
 * readFormatSettings({ language: "id" }); // { language: "id", locale: "id-ID", currency: "IDR", decimals: 0, currencyStyle: "auto" }
 */
export function readFormatSettings(values = {}) {
  const language = readChoice(values.language, Object.keys(DEFAULT_LOCALES), "en", "language");
  const locale = readLocale(values.locale, DEFAULT_LOCALES[language]);
  const currency = readCurrency(values.currency, DEFAULT_CURRENCIES[language]);
  return {
    language,
    locale,
    currency,
    decimals: readDecimals(values.decimals, currency),
    currencyStyle: readChoice(values.currency_style, CURRENCY_STYLES, "auto", "currency_style"),
  };
}

function readChoice(rawValue, choices, defaultChoice, label) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return defaultChoice;
  const choice = String(rawValue).trim().toLowerCase();
  if (!choices.includes(choice)) throw invalidInput(`\`${label}\` must be one of ${choices.join(", ")}, got ${JSON.stringify(rawValue)}`);
  return choice;
}

function readLocale(rawValue, defaultLocale) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return defaultLocale;
  try {
    return Intl.getCanonicalLocales(String(rawValue).trim())[0];
  } catch {
    throw invalidInput(`\`locale\` must be a language tag such as en-GB or id-ID, got ${JSON.stringify(rawValue)}`);
  }
}

function readCurrency(rawValue, defaultCurrency) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return defaultCurrency;
  const currency = String(rawValue).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw invalidInput(`\`currency\` must be a three-letter code such as IDR or USD, got ${JSON.stringify(rawValue)}`);
  return currency;
}

function readDecimals(rawValue, currency) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  const decimals = Number(rawValue);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) throw invalidInput(`\`decimals\` must be an integer from 0 to ${MAX_DECIMALS}, got ${JSON.stringify(rawValue)}`);
  return decimals;
}

/**
 * Formats an amount with its currency: "USD 1,050.00", "Rp 1.500.000".
 *
 * @param amount - Plain decimal string or number (string | number)
 * @param settings - From readFormatSettings (object)
 * @param style - "code", "symbol" or "auto" (string, default: the settings' style)
 * @returns Formatted text, or the input as text when it is not a number (string)
 */
export function formatMoney(amount, settings, style = settings.currencyStyle) {
  const numericText = toNumericText(amount);
  if (numericText === null) return String(amount ?? "");
  const digits = { minimumFractionDigits: settings.decimals, maximumFractionDigits: settings.decimals };
  const symbolText = plainSpaces(new Intl.NumberFormat(settings.locale, { style: "currency", currency: settings.currency, currencyDisplay: "narrowSymbol", ...digits }).format(numericText));
  const isSymbolUsable = style === "symbol" || (style === "auto" && !AMBIGUOUS_SYMBOL_PATTERN.test(symbolText) && !symbolText.includes(settings.currency));
  if (isSymbolUsable) return symbolText;
  const isNegative = numericText.startsWith("-");
  const absoluteText = plainSpaces(new Intl.NumberFormat(settings.locale, digits).format(isNegative ? numericText.slice(1) : numericText));
  return `${isNegative ? "-" : ""}${settings.currency} ${absoluteText}`;
}

/**
 * Formats a number with the locale's separators.
 *
 * @param value - Plain decimal string or number (string | number)
 * @param settings - From readFormatSettings (object)
 * @param fixedDigits - Exact decimals; omitted keeps up to 4 of the value's own (number, optional)
 * @returns Formatted text, or the input as text when it is not a number (string)
 *
 * @example
 * formatNumber("1050", { locale: "en-GB" }, 2); // "1,050.00"
 */
export function formatNumber(value, settings, fixedDigits) {
  const numericText = toNumericText(value);
  if (numericText === null) return String(value ?? "");
  const digits = fixedDigits === undefined ? { minimumFractionDigits: 0, maximumFractionDigits: MAX_DECIMALS } : { minimumFractionDigits: fixedDigits, maximumFractionDigits: fixedDigits };
  return plainSpaces(new Intl.NumberFormat(settings.locale, digits).format(numericText));
}

/**
 * Formats an ISO date ("2026-07-31") for the locale.
 *
 * @param value - ISO date or date-time; anything else is returned unchanged (string)
 * @param settings - From readFormatSettings (object)
 * @param style - "long" (31 July 2026), "medium", "short" or "iso" (string, default "long")
 * @returns Formatted date (string)
 * @throws PluginError kind `invalid_input` - When the style is unknown
 */
export function formatDate(value, settings, style = "long") {
  const parsed = parseIsoDate(value);
  if (!parsed) return String(value ?? "");
  if (style === "iso") return parsed.toISOString().slice(0, 10);
  if (!DATE_STYLES[style]) throw invalidInput(`Unknown date style ${JSON.stringify(style)}; use long, medium, short or iso`);
  return plainSpaces(new Intl.DateTimeFormat(settings.locale, { ...DATE_STYLES[style], timeZone: "UTC" }).format(parsed));
}

/**
 * Parses the date part of an ISO date string.
 *
 * @param value - e.g. "2026-07-31" or "2026-07-31T10:00:00Z" (any)
 * @returns The date at UTC midnight, or null when the value is not a valid ISO date (Date | null)
 */
export function parseIsoDate(value) {
  const match = typeof value === "string" ? ISO_DATE_PATTERN.exec(value.trim()) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDate = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return isRealDate ? date : null;
}

function toNumericText(value) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[+-]?\d+(\.\d+)?$/.test(trimmed) ? trimmed.replace(/^\+/, "") : null;
}

// Intl separates with no-break and narrow no-break spaces; plain spaces are in every font and copy cleanly.
function plainSpaces(text) {
  return text.replace(/[  ]/g, " ");
}
