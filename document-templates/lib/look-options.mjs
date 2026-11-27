/**
 * The look of a document, asked for in plain options instead of an edited
 * template: a logo, an accent colour, the document's title, its language,
 * other label texts, and which optional parts show.
 *
 * `readLook` checks the options and returns them in one shape; the three
 * `apply*` functions put them into a document's values and flags. Nothing
 * here touches a file: the logo is only a path, read later through the
 * allowed folders (see lib/logo-file.mjs).
 */
import { invalidInput } from "./errors.mjs";

export const LOOK_LANGUAGES = ["en", "id"];
/** Optional parts of the invoice that `show` can hide. */
export const SHOW_PARTS = ["period", "quantity", "payment_details", "notes"];
const LOOK_KEYS = ["logo", "accent_color", "title", "language", "labels", "show"];
const MAX_TITLE_LENGTH = 40;
const MAX_LABEL_LENGTH = 60;
const MAX_LABELS = 40;
const MAX_LOGO_PATH_LENGTH = 1000;
const LABEL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** The page is near white; an accent lighter than this could not be read on it (WCAG contrast for large text). */
const MIN_CONTRAST_ON_WHITE = 3;

/** Colour names people use, in English and Indonesian. Every one is dark enough to read on a white page. */
export const COLOR_NAMES = Object.freeze({
  black: "#1C1C1A", hitam: "#1C1C1A",
  grey: "#4B5563", gray: "#4B5563", "abu-abu": "#4B5563", abu: "#4B5563",
  navy: "#1F3A5F", "biru tua": "#1F3A5F", "biru dongker": "#1F3A5F",
  blue: "#1D4ED8", biru: "#1D4ED8",
  teal: "#0F766E", toska: "#0F766E", "hijau toska": "#0F766E",
  green: "#15803D", hijau: "#15803D",
  red: "#B91C1C", merah: "#B91C1C",
  maroon: "#7F1D1D", marun: "#7F1D1D", "merah marun": "#7F1D1D",
  purple: "#6D28D9", ungu: "#6D28D9",
  orange: "#C2410C", oranye: "#C2410C", jingga: "#C2410C",
  brown: "#78350F", cokelat: "#78350F", coklat: "#78350F",
  pink: "#BE185D", "merah muda": "#BE185D",
});

/** Schema of the `look` parameter. */
export const LOOK_PARAMETER = {
  type: "object",
  description: "How the document looks, without changing a template: {\"logo\": \"logo.png\" (a PNG or JPEG in your templates folder), \"accent_color\": \"navy\" or \"#1D4ED8\", \"title\": \"Tax Invoice\", \"language\": \"en\" or \"id\", \"labels\": {\"tax\": \"PPN\"} (other label texts), \"show\": {\"period\": false, \"quantity\": false, \"payment_details\": false, \"notes\": false} (false hides that part)}. Every part is optional",
};

/**
 * Checks look options.
 *
 * @param rawLook - Options as given: an object with any of logo, accent_color, title, language, labels, show (object, optional)
 * @param label - Parameter name for messages (string)
 * @returns Only the options that were given, checked: `{logo?, accent_color?, title?, language?, labels?, show?}`; accent_color is always a #RRGGBB or #RGB colour, show holds booleans (object)
 * @throws PluginError kind `invalid_input` - When an option is unknown or has an invalid value
 *
 * @example
 * readLook({ accent_color: "biru tua", show: { notes: "false" } }); // { accent_color: "#1F3A5F", show: { notes: false } }
 */
export function readLook(rawLook, label = "look") {
  if (rawLook === undefined || rawLook === null || rawLook === "") return {};
  if (!isPlainObject(rawLook)) throw invalidInput(`\`${label}\` must be an object such as {"accent_color": "navy", "title": "Tax Invoice"}`);
  const unknownKeys = Object.keys(rawLook).filter((key) => !LOOK_KEYS.includes(key));
  if (unknownKeys.length > 0) throw invalidInput(`\`${label}\` does not know ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}; it takes ${LOOK_KEYS.join(", ")}`);
  const look = {};
  if (isPresent(rawLook.logo)) look.logo = readLogoPath(rawLook.logo, `${label}.logo`);
  if (isPresent(rawLook.accent_color)) look.accent_color = readAccentColor(rawLook.accent_color, `${label}.accent_color`);
  if (isPresent(rawLook.title)) look.title = readShortText(rawLook.title, MAX_TITLE_LENGTH, `${label}.title`);
  if (isPresent(rawLook.language)) look.language = readLanguage(rawLook.language, `${label}.language`);
  if (isPresent(rawLook.labels)) look.labels = readLabels(rawLook.labels, `${label}.labels`);
  if (isPresent(rawLook.show)) look.show = readShow(rawLook.show, `${label}.show`);
  return look;
}

/**
 * Reads an accent colour: a hex colour or one of COLOR_NAMES.
 *
 * @param rawColor - e.g. "#1D4ED8", "1d4ed8", "navy" or "biru tua" (string)
 * @param label - Parameter name for messages (string)
 * @returns The colour as #RRGGBB or #RGB, upper case (string)
 * @throws PluginError kind `invalid_input` - When it is not a colour, or too light to read on a white page
 */
export function readAccentColor(rawColor, label) {
  const text = String(rawColor).trim().toLowerCase().replace(/\s+/g, " ");
  const named = Object.hasOwn(COLOR_NAMES, text) ? COLOR_NAMES[text] : null;
  const hex = named ?? (/^[0-9a-f]{6}$/.test(text) ? `#${text}` : text);
  if (!HEX_COLOR_PATTERN.test(hex)) throw invalidInput(`\`${label}\` must be a colour such as #1D4ED8, or one of these names: ${listColorNames()}; got ${JSON.stringify(rawColor)}`);
  if (contrastOnWhite(hex) < MIN_CONTRAST_ON_WHITE) throw invalidInput(`\`${label}\` ${JSON.stringify(rawColor)} is too light: the business name and the total are printed in this colour on a white page and could not be read. Choose a darker shade`);
  return hex.toUpperCase();
}

/**
 * Joins the look saved in a brand with the look of one call.
 *
 * @param savedLook - From a brand profile, already checked (object, optional)
 * @param callLook - From the call, already checked; wins over the saved look, part by part (object, optional)
 * @returns One look (object)
 */
export function mergeLooks(savedLook = {}, callLook = {}) {
  const merged = { ...savedLook, ...callLook };
  for (const key of ["labels", "show"]) {
    if (savedLook[key] || callLook[key]) merged[key] = { ...savedLook[key], ...callLook[key] };
  }
  return merged;
}

/**
 * Puts a look into a document's values before they are prepared.
 *
 * @param values - Values as given (object)
 * @param look - Checked look (object)
 * @param options - `{isDefault}`: true for a saved brand, which only fills what the values leave open; false for the look of this call, which wins (object)
 * @returns A copy of the values with `language`, `seller.logo` and `labels` set from the look, and hidden parts removed (object)
 */
export function applyLookToValues(values, look, { isDefault }) {
  const result = { ...values };
  const takes = (current) => !isDefault || !isPresent(current);
  if (look.language && takes(result.language)) result.language = look.language;
  if (look.logo && takes(result.seller?.logo)) result.seller = { ...(isPlainObject(result.seller) ? result.seller : {}), logo: look.logo };
  const lookLabels = { ...look.labels, ...(look.title ? { title: look.title } : {}) };
  if (Object.keys(lookLabels).length > 0) {
    const givenLabels = isPlainObject(result.labels) ? result.labels : {};
    result.labels = isDefault ? { ...lookLabels, ...givenLabels } : { ...givenLabels, ...lookLabels };
  }
  return result;
}

/**
 * Hides the parts a look switches off, after the values are prepared.
 *
 * @param values - Prepared values, with `flags` when they were calculated (object)
 * @param show - `{period?, quantity?, payment_details?, notes?}` booleans; only `false` changes anything (object, optional)
 * @returns A copy of the values (object)
 */
export function applyShowToValues(values, show = {}) {
  const result = { ...values };
  const flags = { ...(isPlainObject(values.flags) ? values.flags : {}) };
  if (show.period === false) flags.has_period = false;
  if (show.quantity === false) flags.has_quantity = false;
  if (Object.keys(flags).length > 0) result.flags = flags;
  if (show.payment_details === false && isPlainObject(result.payment)) result.payment = { ...result.payment, details: undefined };
  if (show.notes === false) result.notes = undefined;
  return result;
}

function readLogoPath(rawPath, label) {
  if (typeof rawPath !== "string" || rawPath.length > MAX_LOGO_PATH_LENGTH || rawPath.includes("\0")) throw invalidInput(`\`${label}\` must be the path of a PNG or JPEG file in your templates folder, e.g. "logo.png"`);
  return rawPath.trim();
}

function readShortText(rawText, maxLength, label) {
  const text = typeof rawText === "string" || typeof rawText === "number" ? String(rawText).replace(/\s+/g, " ").trim() : null;
  // Control characters have no place in a label and would break the PDF's own title.
  if (text === null || text.length > maxLength || /\p{Cc}/u.test(text)) throw invalidInput(`\`${label}\` must be a text of at most ${maxLength} characters`);
  return text;
}

function readLanguage(rawLanguage, label) {
  const language = String(rawLanguage).trim().toLowerCase();
  const byName = { english: "en", inggris: "en", indonesian: "id", indonesia: "id", "bahasa indonesia": "id" };
  const code = byName[language] ?? language;
  if (!LOOK_LANGUAGES.includes(code)) throw invalidInput(`\`${label}\` must be en (English) or id (Indonesian), got ${JSON.stringify(rawLanguage)}`);
  return code;
}

function readLabels(rawLabels, label) {
  const entries = isPlainObject(rawLabels) ? Object.entries(rawLabels).filter(([, text]) => isPresent(text)) : null;
  if (!entries || entries.length > MAX_LABELS) throw invalidInput(`\`${label}\` must be an object of label names and their texts, e.g. {"tax": "PPN", "bill_to": "Customer"}`);
  return Object.fromEntries(entries.map(([name, text]) => {
    if (!LABEL_NAME_PATTERN.test(name)) throw invalidInput(`\`${label}\` has the invalid label name ${JSON.stringify(name)}; describe_template lists the names, e.g. tax, bill_to, total_due`);
    return [name, readShortText(text, MAX_LABEL_LENGTH, `${label}.${name}`)];
  }));
}

function readShow(rawShow, label) {
  if (!isPlainObject(rawShow)) throw invalidInput(`\`${label}\` must be an object such as {"notes": false}; it takes ${SHOW_PARTS.join(", ")}`);
  const show = {};
  for (const [part, rawChoice] of Object.entries(rawShow)) {
    if (!SHOW_PARTS.includes(part)) throw invalidInput(`\`${label}\` does not know ${JSON.stringify(part)}; it takes ${SHOW_PARTS.join(", ")}`);
    if (!isPresent(rawChoice)) continue;
    const choice = typeof rawChoice === "boolean" ? rawChoice : { true: true, false: false }[String(rawChoice).trim().toLowerCase()];
    if (choice === undefined) throw invalidInput(`\`${label}.${part}\` must be true or false, got ${JSON.stringify(rawChoice)}`);
    show[part] = choice;
  }
  return show;
}

function listColorNames() {
  return Object.keys(COLOR_NAMES).join(", ");
}

// WCAG 2 contrast ratio between a colour and white.
function contrastOnWhite(hexColor) {
  const digits = hexColor.slice(1);
  const pairs = digits.length === 3 ? [...digits].map((digit) => digit + digit) : digits.match(/../g);
  const [red, green, blue] = pairs.map((pair) => {
    const channel = Number.parseInt(pair, 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * red + 0.7152 * green + 0.0722 * blue + 0.05);
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
