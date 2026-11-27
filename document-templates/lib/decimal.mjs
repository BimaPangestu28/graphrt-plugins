/**
 * Exact decimal arithmetic for money, on BigInt scaled by 10^10.
 *
 * Invoice totals must not depend on binary floating point (0.1 + 0.2), so
 * every amount, quantity and rate is parsed into a scaled BigInt, calculated
 * there and rounded half away from zero to the currency's decimals.
 */
import { invalidInput } from "./errors.mjs";

const SCALE_DIGITS = 10;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const MAX_INTEGER_DIGITS = 18;
const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses a number or a plain decimal string ("1500000.50") into a scaled BigInt.
 *
 * @param rawValue - Number or decimal string; no thousands separators, no currency symbol (number | string)
 * @param label - Field name for the message, e.g. "items[0].unit_price" (string)
 * @returns The value scaled by 10^10 (bigint)
 * @throws PluginError kind `invalid_input` - When the value is not a plain decimal number
 *
 * @example
 * parseDecimal("0.1", "x") + parseDecimal("0.2", "x") === parseDecimal("0.3", "x"); // true
 */
export function parseDecimal(rawValue, label) {
  const text = typeof rawValue === "number" ? numberToPlainText(rawValue, label) : typeof rawValue === "string" ? rawValue.trim() : null;
  const match = text === null ? null : DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw invalidInput(`\`${label}\` must be a plain number such as 1500000 or 1500000.50 (no thousands separators or currency symbols), got ${JSON.stringify(rawValue)}`);
  }
  const [, sign, integerDigits, fractionDigits = ""] = match;
  if (integerDigits.replace(/^0+/, "").length > MAX_INTEGER_DIGITS) throw invalidInput(`\`${label}\` is too large`);
  const fraction = fractionDigits.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, "0");
  const scaled = BigInt(integerDigits) * SCALE + BigInt(fraction);
  return sign === "-" ? -scaled : scaled;
}

function numberToPlainText(numericValue, label) {
  if (!Number.isFinite(numericValue)) throw invalidInput(`\`${label}\` must be a finite number`);
  const text = String(numericValue);
  return /e/i.test(text) ? numericValue.toFixed(SCALE_DIGITS) : text;
}

/**
 * Multiplies two scaled values, rounding half away from zero at the internal scale.
 *
 * @param left - Scaled value (bigint)
 * @param right - Scaled value (bigint)
 * @returns Scaled product (bigint)
 */
export function multiplyDecimal(left, right) {
  return divideRounded(left * right, SCALE);
}

/**
 * Takes a percentage of a scaled value.
 *
 * @param base - Scaled value (bigint)
 * @param ratePercent - Scaled percentage, e.g. parseDecimal("11") for 11% (bigint)
 * @returns Scaled result (bigint)
 */
export function percentOf(base, ratePercent) {
  return divideRounded(base * ratePercent, SCALE * 100n);
}

/**
 * Rounds a scaled value half away from zero to `digits` decimals.
 *
 * @param scaledValue - Scaled value (bigint)
 * @param digits - Decimals to keep, 0-10 (number)
 * @returns Scaled value with the remaining decimals zero (bigint)
 *
 * @example
 * formatDecimal(roundDecimal(parseDecimal("2.345", "x"), 2), 2); // "2.35"
 */
export function roundDecimal(scaledValue, digits) {
  const unit = 10n ** BigInt(SCALE_DIGITS - digits);
  return divideRounded(scaledValue, unit) * unit;
}

/**
 * Writes a scaled value as a plain decimal string with exactly `digits` decimals.
 *
 * @param scaledValue - Scaled value (bigint)
 * @param digits - Decimals, 0-10 (number)
 * @returns e.g. "-1050.00" (string)
 */
export function formatDecimal(scaledValue, digits) {
  const rounded = roundDecimal(scaledValue, digits);
  const absolute = rounded < 0n ? -rounded : rounded;
  const integerPart = absolute / SCALE;
  const fractionPart = (absolute % SCALE).toString().padStart(SCALE_DIGITS, "0").slice(0, digits);
  const sign = rounded < 0n ? "-" : "";
  return digits > 0 ? `${sign}${integerPart}.${fractionPart}` : `${sign}${integerPart}`;
}

function divideRounded(numerator, denominator) {
  const isNegative = numerator < 0n;
  const absolute = isNegative ? -numerator : numerator;
  const quotient = (absolute + denominator / 2n) / denominator;
  return isNegative ? -quotient : quotient;
}
