/**
 * Recipient phone number validation: WhatsApp expects the international
 * number (country code, no leading zero). Formatting characters are allowed
 * in input and stripped; the API receives digits only.
 */
import { rejectInput } from "./client.mjs";

const FORMATTING_CHARACTERS = /[\s\-().]/g;
const E164_DIGITS = /^\+?[1-9]\d{6,14}$/;

/**
 * Normalizes a phone number to E.164 digits without the "+".
 *
 * @param rawNumber - Number such as "+62 812-3456-7890" (string)
 * @param argumentName - Argument name for the error message (string)
 * @returns Digits, e.g. "6281234567890" (string)
 * @throws PluginError kind `invalid_input` - When it is not an international (E.164) number
 *
 * @example
 * normalizePhoneNumber("+1 (650) 555-1234", "to"); // "16505551234"
 */
export function normalizePhoneNumber(rawNumber, argumentName) {
  const compactNumber = String(rawNumber).replace(FORMATTING_CHARACTERS, "");
  if (!E164_DIGITS.test(compactNumber)) {
    rejectInput(
      `\`${argumentName}\` must be an international E.164 number with country code and no leading 0 (7-15 digits, e.g. "6281234567890"), got "${rawNumber}"`,
    );
  }
  return compactNumber.replace(/^\+/, "");
}
