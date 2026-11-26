/**
 * graphrt UI blocks: the same checks as graphrt's `graphrt-ui` crate (`graphrt_ui::validate`), so an agent hears
 * about a bad card or chart from the tool call instead of the host silently showing nothing.
 *
 * A block is an object whose `$ui` key names its kind (`adaptive_card`, `chart`, `table`, `stats`) with
 * `version: 1`. Hosts validate again before rendering; test/fixtures is a copy of the crate's shared fixtures and
 * keeps both implementations in step.
 */

export const UI_KEY = "$ui";
export const VERSION = 1;
export const MAX_BLOCK_BYTES = 256 * 1024;
export const KINDS = ["adaptive_card", "chart", "table", "stats"];
export const CHART_TYPES = ["bar", "line", "area", "pie", "donut"];
export const NUMBER_FORMATS = ["number", "compact", "percent", "currency"];
export const COLUMN_FORMATS = ["text", "date", "status", ...NUMBER_FORMATS];
export const LIMITS = Object.freeze({
  categories: 10000, series: 20, slices: 50, values: 50000, columns: 20, rows: 1000, statItems: 12,
  cardNodes: 400, cardDepth: 12,
});

const MAX_SHORT_TEXT = 300;
const MAX_LONG_TEXT = 10000;
const MAX_URL = 200 * 1024;
const DATA_IMAGE_PREFIXES = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/gif;base64,", "data:image/webp;base64,"];
const CARD_VERSIONS = ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6"];

/** A rejected block: `path` is a JSON Pointer into it ("" for the block itself). */
export class UiBlockError extends Error {
  constructor(path, message) {
    super(path ? `at ${path}: ${message}` : message);
    this.name = "UiBlockError";
    this.path = path;
  }
}

const fail = (path, message) => {
  throw new UiBlockError(path, message);
};
const escapePointer = (segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
const child = (path, key) => `${path}/${escapePointer(key)}`;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const charCount = (text) => [...text].length;

function object(value, path) {
  if (!isObject(value)) fail(path, "must be an object");
  return value;
}

function onlyKnown(fields, path, allowed) {
  const unknown = Object.keys(fields).find((key) => !allowed.includes(key));
  if (unknown !== undefined) fail(child(path, unknown), `unknown field \`${unknown}\` (allowed: ${allowed.join(", ")})`);
}

function textOf(value, path, maxChars) {
  if (typeof value !== "string") fail(path, "must be a string");
  const count = charCount(value);
  if (count > maxChars) fail(path, `is ${count} characters long; at most ${maxChars} are allowed`);
  return value;
}

function optionalText(fields, key, path, maxChars) {
  const value = fields[key];
  return value === undefined || value === null ? undefined : textOf(value, child(path, key), maxChars);
}

function requiredText(fields, key, path, maxChars) {
  if (!(key in fields)) fail(path, `\`${key}\` is required`);
  return textOf(fields[key], child(path, key), maxChars);
}

function requiredName(fields, key, path) {
  const name = requiredText(fields, key, path, MAX_SHORT_TEXT);
  if (name.trim() === "") fail(child(path, key), "must not be empty");
  return name;
}

function optionalBool(fields, key, path) {
  const value = fields[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail(child(path, key), "must be true or false");
  return value;
}

function optionalNumber(fields, key, path) {
  const value = fields[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(child(path, key), "must be a number");
  return value;
}

function optionalChoice(fields, key, path, choices) {
  const value = optionalText(fields, key, path, MAX_SHORT_TEXT);
  if (value === undefined) return undefined;
  if (!choices.some((choice) => choice.toLowerCase() === value.toLowerCase())) {
    fail(child(path, key), `\`${value}\` is not one of: ${choices.join(", ")}`);
  }
  return value;
}

function array(fields, key, path, min, max) {
  const itemsPath = child(path, key);
  const items = fields[key];
  if ((items === undefined || items === null) && min === 0) return [];
  if (items === undefined) fail(path, `\`${key}\` is required`);
  if (!Array.isArray(items)) fail(itemsPath, "must be an array");
  if (items.length < min) fail(itemsPath, `needs at least ${min} item(s)`);
  if (items.length > max) fail(itemsPath, `has ${items.length} items; at most ${max} are allowed`);
  return items;
}

function optionalCurrency(fields, key, path) {
  const code = optionalText(fields, key, path, MAX_SHORT_TEXT);
  if (code !== undefined && !/^[A-Z]{3}$/.test(code)) fail(child(path, key), "must be a 3-letter ISO 4217 code such as IDR or USD");
}

function isHttps(url) {
  if (url.slice(0, 8).toLowerCase() !== "https://") return false;
  const host = url.slice(8).split(/[/?#]/)[0];
  return host !== "" && !host.includes("@") && !/[\s\p{Cc}]/u.test(url);
}

/** Images: https, or data: PNG/JPEG/GIF/WebP (no SVG: it can carry scripts). */
export function checkImageUrl(url, path) {
  if (charCount(url) > MAX_URL) fail(path, "the image URL is too long; use a smaller image");
  const lower = url.slice(0, 32).toLowerCase();
  if (!DATA_IMAGE_PREFIXES.some((prefix) => lower.startsWith(prefix)) && !isHttps(url)) {
    fail(path, "images must be https URLs or data:image/(png|jpeg|gif|webp);base64 URLs");
  }
}

/** Links: https and mailto. */
export function checkLinkUrl(url, path) {
  const isMailto = url.slice(0, 7).toLowerCase() === "mailto:" && url.length > 7;
  if (charCount(url) > 2048 || !(isHttps(url) || isMailto)) fail(path, "links must be https or mailto URLs");
}

// --- chart -------------------------------------------------------------------------------------------------------

function validateChart(fields) {
  onlyKnown(fields, "", ["title", "subtitle", "fallback_text", "type", "x", "y", "series", "stacked", "horizontal"]);
  commonTexts(fields);
  const chartType = requiredText(fields, "type", "", MAX_SHORT_TEXT);
  if (!CHART_TYPES.includes(chartType)) fail("/type", `\`${chartType}\` is not one of: ${CHART_TYPES.join(", ")}`);
  const isRound = chartType === "pie" || chartType === "donut";
  if (!("x" in fields)) fail("", "`x` is required");
  const x = object(fields.x, "/x");
  onlyKnown(x, "/x", ["label", "values"]);
  optionalText(x, "label", "/x", MAX_SHORT_TEXT);
  const categories = array(x, "values", "/x", 1, LIMITS.categories);
  categories.forEach((value, i) => {
    const ok = (typeof value === "string" && charCount(value) <= MAX_SHORT_TEXT) || (typeof value === "number" && Number.isFinite(value));
    if (!ok) fail(`/x/values/${i}`, "must be a short string or a number");
  });
  if ("y" in fields) {
    const y = object(fields.y, "/y");
    onlyKnown(y, "/y", ["label", "format", "currency", "min", "max"]);
    optionalText(y, "label", "/y", MAX_SHORT_TEXT);
    optionalChoice(y, "format", "/y", NUMBER_FORMATS);
    optionalCurrency(y, "currency", "/y");
    const min = optionalNumber(y, "min", "/y");
    const max = optionalNumber(y, "max", "/y");
    if (min !== undefined && max !== undefined && min >= max) fail("/y", "`min` must be below `max`");
  }
  if (optionalBool(fields, "stacked", "") === true && chartType !== "bar" && chartType !== "area") fail("/stacked", "only bar and area charts can be stacked");
  if (optionalBool(fields, "horizontal", "") === true && chartType !== "bar") fail("/horizontal", "only bar charts can be horizontal");
  if (isRound && categories.length > LIMITS.slices) fail("/x/values", `a ${chartType} chart has at most ${LIMITS.slices} slices`);
  const series = array(fields, "series", "", 1, LIMITS.series);
  if (isRound && series.length !== 1) fail("/series", `a ${chartType} chart has exactly one series`);
  if (series.length * categories.length > LIMITS.values) fail("/series", `at most ${LIMITS.values} values in all`);
  series.forEach((item, i) => {
    const path = `/series/${i}`;
    const one = object(item, path);
    onlyKnown(one, path, ["name", "values"]);
    requiredName(one, "name", path);
    const values = array(one, "values", path, 0, LIMITS.categories);
    if (values.length !== categories.length) {
      fail(`${path}/values`, `has ${values.length} values but \`x.values\` has ${categories.length}: give one value (or null) per category`);
    }
    values.forEach((value, j) => {
      const ok = typeof value === "number" ? Number.isFinite(value) && (!isRound || value >= 0) : value === null && !isRound;
      if (!ok) fail(`${path}/values/${j}`, `must be ${isRound ? "a number of 0 or more" : "a number or null"}`);
    });
  });
}

// --- table and stats ---------------------------------------------------------------------------------------------

function commonTexts(fields) {
  optionalText(fields, "title", "", MAX_SHORT_TEXT);
  optionalText(fields, "subtitle", "", MAX_SHORT_TEXT);
  optionalText(fields, "fallback_text", "", MAX_LONG_TEXT);
}

function validateTable(fields) {
  onlyKnown(fields, "", ["title", "subtitle", "fallback_text", "columns", "rows"]);
  commonTexts(fields);
  const keys = new Set();
  array(fields, "columns", "", 1, LIMITS.columns).forEach((item, i) => {
    const path = `/columns/${i}`;
    const column = object(item, path);
    onlyKnown(column, path, ["key", "label", "align", "format", "currency"]);
    const key = requiredName(column, "key", path);
    if (keys.has(key)) fail(`${path}/key`, `\`${key}\` is used by another column`);
    keys.add(key);
    requiredName(column, "label", path);
    optionalChoice(column, "align", path, ["left", "center", "right"]);
    optionalChoice(column, "format", path, COLUMN_FORMATS);
    optionalCurrency(column, "currency", path);
  });
  array(fields, "rows", "", 0, LIMITS.rows).forEach((item, i) => {
    const path = `/rows/${i}`;
    for (const [key, value] of Object.entries(object(item, path))) {
      const ok = typeof value === "string" ? charCount(value) <= MAX_LONG_TEXT : value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
      if (!ok) fail(child(path, key), "must be a string, number, boolean or null");
    }
  });
}

function validateStats(fields) {
  onlyKnown(fields, "", ["title", "subtitle", "fallback_text", "items"]);
  commonTexts(fields);
  array(fields, "items", "", 1, LIMITS.statItems).forEach((entry, i) => {
    const path = `/items/${i}`;
    const item = object(entry, path);
    onlyKnown(item, path, ["label", "value", "format", "currency", "delta", "delta_format", "trend", "good", "caption"]);
    requiredName(item, "label", path);
    const value = item.value;
    const ok = (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && charCount(value) <= 60);
    if (!ok) fail(`${path}/value`, "must be a number or a string of at most 60 characters");
    optionalChoice(item, "format", path, NUMBER_FORMATS);
    optionalCurrency(item, "currency", path);
    optionalNumber(item, "delta", path);
    optionalChoice(item, "delta_format", path, ["number", "percent"]);
    optionalChoice(item, "trend", path, ["up", "down", "flat"]);
    optionalChoice(item, "good", path, ["up", "down"]);
    optionalText(item, "caption", path, MAX_SHORT_TEXT);
  });
}

// --- adaptive_card -----------------------------------------------------------------------------------------------

const ELEMENT_COMMON = ["type", "id", "isVisible", "separator", "spacing", "height", "fallback", "requires", "targetWidth", "lang", "grid.area"];
const CONTAINER_LIKE = ["selectAction", "style", "verticalContentAlignment", "bleed", "backgroundImage", "minHeight", "rtl", "showBorder", "roundedCorners"];
const INPUT_COMMON = ["label", "isRequired", "errorMessage", "value", "placeholder"];
const ACTION_COMMON = ["type", "id", "title", "iconUrl", "style", "fallback", "tooltip", "isEnabled", "mode", "requires"];
const CARD_FIELDS = ["type", "version", "body", "actions", "selectAction", "fallbackText", "backgroundImage", "minHeight", "rtl", "speak", "lang", "verticalContentAlignment", "$schema", "msteams", "metadata"];
const TEXT_RUN_FIELDS = ["type", "text", "color", "fontType", "highlight", "isSubtle", "italic", "selectAction", "size", "strikethrough", "underline", "weight", "lang"];
const ELEMENT_FIELDS = {
  TextBlock: ["text", "color", "fontType", "horizontalAlignment", "isSubtle", "maxLines", "size", "weight", "wrap", "style"],
  RichTextBlock: ["inlines", "horizontalAlignment"],
  Image: ["url", "altText", "backgroundColor", "horizontalAlignment", "selectAction", "size", "style", "width"],
  ImageSet: ["images", "imageSize", "style", "horizontalAlignment"],
  Container: ["items"],
  ColumnSet: ["columns", "horizontalAlignment"],
  Column: ["items", "width"],
  FactSet: ["facts"],
  ActionSet: ["actions", "horizontalAlignment"],
  Table: ["columns", "rows", "firstRowAsHeader", "showGridLines", "gridStyle", "horizontalCellContentAlignment", "verticalCellContentAlignment"],
  "Input.Text": ["isMultiline", "maxLength", "regex", "style", "inlineAction"],
  "Input.Number": ["min", "max"],
  "Input.Date": ["min", "max"],
  "Input.Time": ["min", "max"],
  "Input.Toggle": ["title", "valueOn", "valueOff", "wrap"],
  "Input.ChoiceSet": ["choices", "isMultiSelect", "style", "wrap"],
};
const ACTION_FIELDS = {
  "Action.Submit": ["data", "associatedInputs"],
  "Action.Execute": ["verb", "data", "associatedInputs"],
  "Action.OpenUrl": ["url"],
  "Action.ShowCard": ["card"],
  "Action.ToggleVisibility": ["targetElements"],
};
const usesContainerFields = (type) => ["Container", "ColumnSet", "Column", "Table"].includes(type);

class CardWalk {
  nodes = 0;
  inputIds = new Set();

  enter(path, depth) {
    this.nodes += 1;
    if (this.nodes > LIMITS.cardNodes) fail(path, `the card has more than ${LIMITS.cardNodes} elements and actions`);
    if (depth > LIMITS.cardDepth) fail(path, `the card is nested more than ${LIMITS.cardDepth} levels deep`);
  }
}

function validateAdaptiveCard(fields) {
  onlyKnown(fields, "", ["title", "fallback_text", "card"]);
  optionalText(fields, "title", "", MAX_SHORT_TEXT);
  optionalText(fields, "fallback_text", "", MAX_LONG_TEXT);
  if (!("card" in fields)) fail("", "`card` is required");
  validateCard(fields.card, "/card", 0, new CardWalk());
}

function validateCard(value, path, depth, walk) {
  const card = object(value, path);
  onlyKnown(card, path, CARD_FIELDS);
  if (card.type !== "AdaptiveCard") fail(child(path, "type"), 'must be "AdaptiveCard"');
  if (depth === 0 || "version" in card) {
    const version = requiredText(card, "version", path, 8);
    if (!CARD_VERSIONS.includes(version)) fail(child(path, "version"), `\`${version}\` is not one of: ${CARD_VERSIONS.join(", ")}`);
  }
  optionalText(card, "fallbackText", path, MAX_LONG_TEXT);
  optionalText(card, "speak", path, MAX_LONG_TEXT);
  checkBackgroundImage(card, path);
  checkSelectAction(card, path, depth, walk);
  validateElements(card, "body", path, depth, walk);
  validateActions(card, "actions", path, depth, walk);
}

function validateElements(parent, key, path, depth, walk) {
  array(parent, key, path, 0, LIMITS.cardNodes).forEach((element, i) => validateElement(element, `${child(path, key)}/${i}`, depth + 1, walk));
}

function validateElement(value, path, depth, walk) {
  walk.enter(path, depth);
  const element = object(value, path);
  const type = requiredText(element, "type", path, MAX_SHORT_TEXT);
  const own = ELEMENT_FIELDS[type];
  if (!own) {
    if (!("fallback" in element)) fail(child(path, "type"), `element type \`${type}\` is not supported; give it a \`fallback\` element or "drop"`);
    validateFallback(element.fallback, child(path, "fallback"), depth, walk);
    return;
  }
  const allowed = [...ELEMENT_COMMON, ...own, ...(usesContainerFields(type) ? CONTAINER_LIKE : []), ...(type.startsWith("Input.") ? INPUT_COMMON : [])];
  onlyKnown(element, path, allowed);
  if ("fallback" in element) validateFallback(element.fallback, child(path, "fallback"), depth, walk);
  if (usesContainerFields(type)) checkBackgroundImage(element, path);
  if (own.includes("selectAction") || usesContainerFields(type)) checkSelectAction(element, path, depth, walk);
  switch (type) {
    case "TextBlock":
      cardText(element, "text", path, true);
      optionalChoice(element, "style", path, ["default", "heading", "columnHeader"]);
      break;
    case "RichTextBlock":
      array(element, "inlines", path, 1, 200).forEach((inline, i) => {
        const inlinePath = `${child(path, "inlines")}/${i}`;
        walk.enter(inlinePath, depth + 1);
        if (typeof inline === "string") return;
        const run = object(inline, inlinePath);
        if (run.type !== "TextRun") fail(child(inlinePath, "type"), "inlines are strings or TextRun objects");
        onlyKnown(run, inlinePath, TEXT_RUN_FIELDS);
        cardText(run, "text", inlinePath, true);
        checkSelectAction(run, inlinePath, depth + 1, walk);
      });
      break;
    case "Image":
      validateImage(element, path);
      break;
    case "ImageSet":
      array(element, "images", path, 1, 100).forEach((image, i) => {
        const imagePath = `${child(path, "images")}/${i}`;
        walk.enter(imagePath, depth + 1);
        onlyKnown(object(image, imagePath), imagePath, [...ELEMENT_COMMON, ...ELEMENT_FIELDS.Image]);
        validateImage(image, imagePath);
      });
      break;
    case "Container":
    case "Column":
      validateElements(element, "items", path, depth, walk);
      break;
    case "ColumnSet":
      array(element, "columns", path, 0, 50).forEach((column, i) => {
        const columnPath = `${child(path, "columns")}/${i}`;
        const columnType = isObject(column) && typeof column.type === "string" ? column.type : "Column";
        if (columnType !== "Column") fail(child(columnPath, "type"), "a ColumnSet holds only Column elements");
        validateElement(isObject(column) ? { type: "Column", ...column } : column, columnPath, depth + 1, walk);
      });
      break;
    case "FactSet":
      array(element, "facts", path, 1, 100).forEach((fact, i) => {
        const factPath = `${child(path, "facts")}/${i}`;
        onlyKnown(object(fact, factPath), factPath, ["title", "value"]);
        cardText(fact, "title", factPath, false);
        cardText(fact, "value", factPath, true);
      });
      break;
    case "ActionSet":
      validateActions(element, "actions", path, depth, walk);
      break;
    case "Table":
      validateCardTable(element, path, depth, walk);
      break;
    default:
      validateInput(element, type, path, depth, walk);
  }
}

function validateFallback(value, path, depth, walk) {
  if (value === "drop") return;
  if (!isObject(value)) fail(path, 'must be an element or "drop"');
  validateElement(value, path, depth, walk);
}

function cardText(fields, key, path, long) {
  const text = requiredText(fields, key, path, long ? MAX_LONG_TEXT : MAX_SHORT_TEXT);
  if (text.includes("${")) fail(child(path, key), "template expressions (${...}) are not supported; put the values into the text");
}

function validateImage(image, path) {
  checkImageUrl(requiredText(image, "url", path, MAX_URL), child(path, "url"));
  optionalText(image, "altText", path, MAX_SHORT_TEXT);
}

function checkBackgroundImage(fields, path) {
  const imagePath = child(path, "backgroundImage");
  const image = fields.backgroundImage;
  if (image === undefined || image === null) return;
  if (typeof image === "string") return checkImageUrl(image, imagePath);
  if (!isObject(image)) fail(imagePath, "must be a URL or an object with `url`");
  onlyKnown(image, imagePath, ["url", "fillMode", "horizontalAlignment", "verticalAlignment"]);
  checkImageUrl(requiredText(image, "url", imagePath, MAX_URL), child(imagePath, "url"));
}

function checkSelectAction(fields, path, depth, walk) {
  if (!("selectAction" in fields)) return;
  const actionPath = child(path, "selectAction");
  if (fields.selectAction?.type === "Action.ShowCard") fail(actionPath, "a selectAction cannot be Action.ShowCard");
  validateAction(fields.selectAction, actionPath, depth + 1, walk);
}

function validateCardTable(table, path, depth, walk) {
  const columns = array(table, "columns", path, 1, 30);
  columns.forEach((column, i) => {
    const columnPath = `${child(path, "columns")}/${i}`;
    onlyKnown(object(column, columnPath), columnPath, ["type", "width", "horizontalCellContentAlignment", "verticalCellContentAlignment"]);
  });
  array(table, "rows", path, 0, 200).forEach((rowValue, r) => {
    const rowPath = `${child(path, "rows")}/${r}`;
    walk.enter(rowPath, depth + 1);
    const row = object(rowValue, rowPath);
    onlyKnown(row, rowPath, ["type", "cells", "style", "horizontalCellContentAlignment", "verticalCellContentAlignment"]);
    array(row, "cells", rowPath, 0, columns.length).forEach((cellValue, c) => {
      const cellPath = `${child(rowPath, "cells")}/${c}`;
      walk.enter(cellPath, depth + 2);
      const cell = object(cellValue, cellPath);
      onlyKnown(cell, cellPath, ["type", "items", ...CONTAINER_LIKE]);
      checkBackgroundImage(cell, cellPath);
      checkSelectAction(cell, cellPath, depth + 2, walk);
      validateElements(cell, "items", cellPath, depth + 2, walk);
    });
  });
}

function validateInput(input, type, path, depth, walk) {
  const id = requiredName(input, "id", path);
  if (walk.inputIds.has(id)) fail(child(path, "id"), `input id \`${id}\` is used twice`);
  walk.inputIds.add(id);
  optionalText(input, "label", path, MAX_SHORT_TEXT);
  optionalText(input, "placeholder", path, MAX_SHORT_TEXT);
  optionalText(input, "errorMessage", path, MAX_SHORT_TEXT);
  if (type === "Input.Toggle") optionalText(input, "title", path, MAX_SHORT_TEXT);
  if (type === "Input.ChoiceSet") {
    optionalChoice(input, "style", path, ["compact", "expanded", "filtered"]);
    array(input, "choices", path, 1, 200).forEach((choice, i) => {
      const choicePath = `${child(path, "choices")}/${i}`;
      onlyKnown(object(choice, choicePath), choicePath, ["title", "value"]);
      cardText(choice, "title", choicePath, false);
      requiredText(choice, "value", choicePath, MAX_SHORT_TEXT);
    });
  }
  if (type === "Input.Text" && "inlineAction" in input) {
    const actionPath = child(path, "inlineAction");
    if (input.inlineAction?.type === "Action.ShowCard") fail(actionPath, "an inlineAction cannot be Action.ShowCard");
    validateAction(input.inlineAction, actionPath, depth + 1, walk);
  }
}

function validateActions(parent, key, path, depth, walk) {
  array(parent, key, path, 0, 20).forEach((action, i) => validateAction(action, `${child(path, key)}/${i}`, depth + 1, walk));
}

function validateAction(value, path, depth, walk) {
  walk.enter(path, depth);
  const action = object(value, path);
  const type = requiredText(action, "type", path, MAX_SHORT_TEXT);
  const own = ACTION_FIELDS[type];
  if (!own) {
    if (action.fallback === "drop") return;
    if (isObject(action.fallback)) return validateAction(action.fallback, child(path, "fallback"), depth, walk);
    fail(child(path, "type"), `action type \`${type}\` is not supported; give it a \`fallback\` action or "drop"`);
  }
  onlyKnown(action, path, [...ACTION_COMMON, ...own]);
  optionalText(action, "title", path, MAX_SHORT_TEXT);
  optionalText(action, "tooltip", path, MAX_SHORT_TEXT);
  optionalChoice(action, "style", path, ["default", "positive", "destructive"]);
  optionalChoice(action, "associatedInputs", path, ["auto", "none"]);
  const icon = optionalText(action, "iconUrl", path, MAX_URL);
  if (icon !== undefined) checkImageUrl(icon, child(path, "iconUrl"));
  if ("fallback" in action && action.fallback !== "drop" && !isObject(action.fallback)) fail(child(path, "fallback"), 'must be an action or "drop"');
  if (type === "Action.OpenUrl") checkLinkUrl(requiredText(action, "url", path, 2048), child(path, "url"));
  if (type === "Action.ShowCard") {
    if (!("card" in action)) fail(path, "`card` is required");
    validateCard(action.card, child(path, "card"), depth + 1, walk);
  }
  if (type === "Action.Execute") optionalText(action, "verb", path, MAX_SHORT_TEXT);
  if (type === "Action.ToggleVisibility") {
    array(action, "targetElements", path, 1, 50).forEach((target, i) => {
      if (typeof target === "string") return;
      const targetPath = `${child(path, "targetElements")}/${i}`;
      onlyKnown(object(target, targetPath), targetPath, ["elementId", "isVisible"]);
      requiredName(target, "elementId", targetPath);
    });
  }
  const data = action.data;
  if (!(data === undefined || data === null || typeof data === "string" || isObject(data))) fail(child(path, "data"), "must be an object or a string");
}

// --- envelope ----------------------------------------------------------------------------------------------------

const VALIDATORS = { adaptive_card: validateAdaptiveCard, chart: validateChart, table: validateTable, stats: validateStats };

/**
 * Checks a UI block like graphrt's `graphrt_ui::validate`.
 *
 * @param block - The block, with `$ui` and `version` (object)
 * @returns The block, unchanged (object)
 * @throws UiBlockError - With a JSON Pointer `path` and a message an LLM can act on
 *
 * @example
 * validateUiBlock({ $ui: "stats", version: 1, items: [{ label: "Orders", value: 12 }] }); // returns the block
 */
export function validateUiBlock(block) {
  if (!isObject(block)) fail("", "a UI block must be a JSON object");
  const kind = block[UI_KEY];
  if (typeof kind !== "string") fail("", `a UI block needs a string \`${UI_KEY}\` naming its kind`);
  if (!KINDS.includes(kind)) fail(`/${UI_KEY}`, `unknown kind \`${kind}\` (known: ${KINDS.join(", ")})`);
  if (block.version !== VERSION) fail("/version", `\`version\` must be ${VERSION}`);
  const size = Buffer.byteLength(JSON.stringify(block));
  if (size > MAX_BLOCK_BYTES) fail("", `the block is ${size} bytes; at most ${MAX_BLOCK_BYTES} are allowed`);
  const { [UI_KEY]: _kind, version: _version, ...body } = block;
  VALIDATORS[kind](body);
  return block;
}
