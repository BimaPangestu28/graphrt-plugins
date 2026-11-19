/**
 * Hex colour validation.
 */
import { invalidInput } from "./errors.mjs";

/**
 * Checks a colour given as #rgb or #rrggbb.
 *
 * @param color - Colour text (string)
 * @param parameterName - For the message (string, default "color")
 * @returns Lower-case #rrggbb (string)
 * @throws PluginError kind `invalid_input` - When the colour is not a hex colour
 *
 * @example
 * normalizeHexColor("#F00"); // "#ff0000"
 */
export function normalizeHexColor(color, parameterName = "color") {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
  if (!match) throw invalidInput(`\`${parameterName}\` must be a hex colour such as #ffffff or #fff`);
  const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return `#${hex.toLowerCase()}`;
}
