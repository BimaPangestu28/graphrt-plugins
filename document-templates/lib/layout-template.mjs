/**
 * Layout templates: a JSON description of a page (text, columns, tables,
 * images, lines) with `{{placeholders}}`, `$each` loops and `$if` conditions.
 *
 * This module turns a template and a document's values into a render plan:
 * plain data with every placeholder filled and every loop unrolled. It runs
 * no template code. Every node property is checked against an allowlist, so
 * a template can only describe what goes on the page: it cannot name a font
 * file, a URL, an attachment or an SVG, and an image is only ever a path that
 * the caller then resolves inside the allowed directories.
 *
 * The node vocabulary follows pdfmake's document definition (text, stack,
 * columns, table, image, qr, canvas, ul, ol), which is what the worker draws
 * the plan with.
 */
import { invalidInput } from "./errors.mjs";
import { Scope, evaluateExpression, interpolate, isTruthy, listPlaceholders, parseExpression } from "./expressions.mjs";

export const TEMPLATE_FORMAT = "graphrt-document-template";
export const TEMPLATE_VERSION = 1;
/** Private-use markers a header or footer carries until the worker knows the page numbers. */
export const PAGE_NUMBER_MARKER = "page";
export const PAGE_COUNT_MARKER = "pages";

const MAX_NODES = 100000;
const MAX_DEPTH = 40;
const MAX_IMAGES = 20;
const MAX_TEXT_LENGTH = 100000;
const PAGE_SIZES = ["A3", "A4", "A5", "LETTER", "LEGAL"];
const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// pdfmake's own default is a dark, 60% opaque text across the page, which hides what is under it.
const WATERMARK_DEFAULTS = { color: "#808080", opacity: 0.12, bold: true };
const TOP_LEVEL_KEYS = ["format", "version", "name", "description", "calculate", "page", "defaults", "styles", "labels", "fields", "sample_values", "info", "watermark", "header", "footer", "content", "bottom"];

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const numberBetween = (minimum, maximum) => (value) => isNumber(value) && value >= minimum && value <= maximum;
const oneOf = (...choices) => (value) => choices.includes(value);
const isColor = (value) => typeof value === "string" && HEX_COLOR_PATTERN.test(value);
const isBoolean = (value) => typeof value === "boolean";
const isMargin = (value) => isNumber(value) || (Array.isArray(value) && (value.length === 2 || value.length === 4) && value.every(isNumber));
const isPoint = (value) => typeof value === "object" && value !== null && isNumber(value.x) && isNumber(value.y) && Object.keys(value).length === 2;
const isWidth = (value) => (isNumber(value) && value >= 0) || value === "*" || value === "auto" || (typeof value === "string" && /^\d{1,3}(\.\d+)?%$/.test(value));
const isBorder = (value) => Array.isArray(value) && value.length === 4 && value.every(isBoolean);
const isBorderColor = (value) => Array.isArray(value) && value.length === 4 && value.every(isColor);
const isFit = (value) => (isNumber(value) && value > 0) || (Array.isArray(value) && value.length === 2 && value.every((side) => isNumber(side) && side > 0));

/** Properties that style text; allowed on every node, in `styles` and in `defaults`. */
const STYLE_PROPERTIES = {
  font: (value) => typeof value === "string" && /^[A-Za-z0-9 _-]{1,80}$/.test(value),
  fontSize: numberBetween(1, 400),
  bold: isBoolean,
  italics: isBoolean,
  color: isColor,
  background: isColor,
  alignment: oneOf("left", "center", "right", "justify"),
  characterSpacing: numberBetween(-10, 50),
  lineHeight: numberBetween(0.5, 5),
  decoration: oneOf("underline", "lineThrough", "overline"),
  opacity: numberBetween(0, 1),
  noWrap: isBoolean,
  margin: isMargin,
  fillColor: isColor,
  fillOpacity: numberBetween(0, 1),
  columnGap: numberBetween(0, 500),
  fontFeatures: (value) => Array.isArray(value) && value.length <= 8 && value.every((feature) => typeof feature === "string" && /^[a-z0-9]{4}$/.test(feature)),
};

/** Properties that place a node; allowed on every block node. */
const BLOCK_PROPERTIES = {
  ...STYLE_PROPERTIES,
  width: isWidth,
  height: numberBetween(0, 5000),
  fit: isFit,
  pageBreak: oneOf("before", "after"),
  unbreakable: isBoolean,
  absolutePosition: isPoint,
  relativePosition: isPoint,
  colSpan: numberBetween(1, 50),
  rowSpan: numberBetween(1, 500),
  border: isBorder,
  borderColor: isBorderColor,
  foreground: isColor,
  eccLevel: oneOf("L", "M", "Q", "H"),
};

const TABLE_PROPERTIES = { headerRows: numberBetween(0, 20), keepWithHeaderRows: numberBetween(0, 20), dontBreakRows: isBoolean };
const LAYOUT_PROPERTIES = {
  lines: oneOf("none", "rows", "header", "grid"),
  line_width: numberBetween(0, 20),
  line_color: isColor,
  header_line_width: numberBetween(0, 20),
  header_line_color: isColor,
  padding: (value) => isNumber(value) || (Array.isArray(value) && value.length === 4 && value.every(isNumber)),
  column_gap: numberBetween(0, 200),
};
const VECTOR_PROPERTIES = {
  type: oneOf("line", "rect", "ellipse"),
  x: isNumber, y: isNumber, w: isNumber, h: isNumber, r: isNumber, r1: isNumber, r2: isNumber,
  x1: isNumber, y1: isNumber, x2: isNumber, y2: isNumber,
  lineWidth: numberBetween(0, 100), lineColor: isColor, color: isColor, fillOpacity: numberBetween(0, 1), strokeOpacity: numberBetween(0, 1),
};
const RULE_PROPERTIES = { color: isColor, thickness: numberBetween(0.1, 20), margin: isMargin };
const PAGE_PROPERTIES = {
  size: (value) => PAGE_SIZES.includes(value) || (typeof value === "object" && value !== null && numberBetween(72, 5000)(value.width) && numberBetween(72, 5000)(value.height)),
  orientation: oneOf("portrait", "landscape"),
  margins: (value) => Array.isArray(value) && value.length === 4 && value.every(numberBetween(0, 1000)),
  background_color: isColor,
  background_pdf: (value) => typeof value === "string" && value.trim() !== "",
};
/** Node properties whose value is other nodes or needs its own handling. */
const CONTENT_KEYS = ["text", "stack", "columns", "table", "layout", "image", "qr", "canvas", "rule", "ul", "ol", "style"];

/**
 * Parses and checks a layout template file.
 *
 * @param text - The file's JSON text (string)
 * @param label - Template name for messages (string)
 * @returns The template (object)
 * @throws PluginError kind `invalid_input` - When the text is not a version 1 layout template
 */
export function parseLayoutTemplate(text, label) {
  let template;
  try {
    template = JSON.parse(text);
  } catch (parseError) {
    throw invalidInput(`The template ${label} is not valid JSON: ${parseError.message}`);
  }
  if (!isPlainObject(template) || template.format !== TEMPLATE_FORMAT) throw invalidInput(`The template ${label} is not a layout template: it needs "format": "${TEMPLATE_FORMAT}"`);
  if (template.version !== TEMPLATE_VERSION) throw invalidInput(`The template ${label} is version ${JSON.stringify(template.version)}; this plugin reads version ${TEMPLATE_VERSION}`);
  const unknownKeys = Object.keys(template).filter((key) => !TOP_LEVEL_KEYS.includes(key));
  if (unknownKeys.length > 0) throw invalidInput(`The template ${label} has unknown top-level keys: ${unknownKeys.join(", ")} (allowed: ${TOP_LEVEL_KEYS.join(", ")})`);
  if (!Array.isArray(template.content)) throw invalidInput(`The template ${label} needs a "content" list`);
  if (template.calculate !== undefined && !["invoice", "none"].includes(template.calculate)) throw invalidInput(`The template ${label} has "calculate": ${JSON.stringify(template.calculate)}; use "invoice" or "none"`);
  return template;
}

/**
 * Names the required fields of a template that the values lack.
 *
 * @param template - Parsed template (object)
 * @param values - Document values (object)
 * @returns Field names, e.g. ["number", "client.name"] (string[])
 */
export function listMissingFields(template, values) {
  const scope = new Scope(values);
  return (Array.isArray(template.fields) ? template.fields : [])
    .filter((field) => field?.required === true && typeof field.name === "string")
    .filter((field) => !isTruthy(evaluateExpression(parseExpression(field.name), scope, {})))
    .map((field) => field.name);
}

/**
 * Lists the placeholders a template uses, for `describe_template`.
 *
 * @param template - Parsed template (object)
 * @returns Sorted, de-duplicated placeholder bodies and loop/condition expressions (string[])
 */
export function listTemplatePlaceholders(template) {
  const found = new Set();
  const visit = (value) => {
    if (typeof value === "string") listPlaceholders(value).forEach((placeholder) => found.add(placeholder));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isPlainObject(value)) {
      for (const directive of ["$if", "$each"]) if (typeof value[directive] === "string") found.add(value[directive]);
      Object.values(value).forEach(visit);
    }
  };
  for (const section of ["header", "footer", "content", "bottom", "watermark", "info"]) visit(template[section]);
  return [...found].sort();
}

/**
 * Fills a template with values.
 *
 * @param template - Parsed template (object)
 * @param values - Document values, already calculated (object)
 * @param settings - Format settings from readFormatSettings (object)
 * @param options - `{today}` ISO date exposed as `{{today}}` (object)
 * @returns Render plan `{page, defaultStyle, styles, content, header, footer, bottom, watermark, info, imagePaths}`; image nodes carry an index into imagePaths (object)
 * @throws PluginError kind `invalid_input` - When the template uses an unknown property, a bad value or a malformed placeholder
 */
export function expandLayout(template, values, settings, { today }) {
  const context = { settings, nodeCount: 0, imagePaths: [], styleNames: new Set(Object.keys(template.styles ?? {})) };
  const scope = new Scope({ ...values, labels: mergeLabels(template.labels, values.labels, settings.language), today, page: { number: PAGE_NUMBER_MARKER, count: PAGE_COUNT_MARKER } });
  const section = (name) => (template[name] === undefined ? null : expandBlock(template[name], scope, context, name, 0));
  return {
    page: checkProperties(template.page ?? {}, PAGE_PROPERTIES, "page"),
    defaultStyle: checkProperties(template.defaults ?? {}, STYLE_PROPERTIES, "defaults"),
    styles: expandStyles(template.styles),
    content: expandList(template.content, scope, context, "content", 0, expandBlock),
    header: section("header"),
    footer: section("footer"),
    bottom: section("bottom"),
    watermark: expandWatermark(template.watermark, scope, context),
    info: expandInfo(template.info, scope, context),
    imagePaths: context.imagePaths,
  };
}

// Labels of the document's language, falling back to the template's first language, with the values' own overrides on top.
function mergeLabels(templateLabels, valueLabels, language) {
  const byLanguage = isPlainObject(templateLabels) ? templateLabels : {};
  const base = byLanguage[language] ?? Object.values(byLanguage)[0] ?? {};
  return { ...(isPlainObject(base) ? base : {}), ...(isPlainObject(valueLabels) ? valueLabels : {}) };
}

function expandStyles(rawStyles) {
  if (rawStyles === undefined) return {};
  if (!isPlainObject(rawStyles)) throw templateError("styles", "must be an object of named styles");
  return Object.fromEntries(Object.entries(rawStyles).map(([name, style]) => [name, checkProperties(style, STYLE_PROPERTIES, `styles.${name}`)]));
}

function expandWatermark(rawWatermark, scope, context) {
  if (rawWatermark === undefined) return null;
  const watermark = typeof rawWatermark === "string" ? { text: rawWatermark } : rawWatermark;
  if (!isPlainObject(watermark) || typeof watermark.text !== "string") throw templateError("watermark", "must be a text or an object with `text`");
  const { text, ...rest } = watermark;
  const filled = interpolate(text, scope, context.settings).trim();
  return filled === "" ? null : { text: filled.slice(0, 80), ...WATERMARK_DEFAULTS, ...checkProperties(rest, { color: isColor, opacity: numberBetween(0, 1), bold: isBoolean, angle: numberBetween(-180, 180), fontSize: numberBetween(4, 400) }, "watermark") };
}

function expandInfo(rawInfo, scope, context) {
  if (rawInfo === undefined) return {};
  if (!isPlainObject(rawInfo)) throw templateError("info", "must be an object with title, author or subject");
  const info = {};
  for (const key of ["title", "author", "subject"]) {
    if (typeof rawInfo[key] === "string") info[key] = interpolate(rawInfo[key], scope, context.settings).replace(/\s+/g, " ").trim().slice(0, 300);
  }
  return info;
}

/**
 * Expands a list whose entries may be `$each` loops or `$if` conditions.
 * A loop adds one entry per item; a condition adds its entry or nothing.
 */
function expandList(rawList, scope, context, path, depth, expandEntry) {
  if (!Array.isArray(rawList)) throw templateError(path, "must be a list");
  const expanded = [];
  rawList.forEach((rawEntry, index) => {
    const entryPath = `${path}[${index}]`;
    if (isPlainObject(rawEntry) && "$each" in rawEntry) {
      for (const loopScope of iterateLoop(rawEntry, scope, context, entryPath)) expanded.push(...expandList([rawEntry.do], loopScope, context, `${entryPath}.do`, depth + 1, expandEntry));
    } else if (isPlainObject(rawEntry) && "$if" in rawEntry) {
      const chosen = chooseBranch(rawEntry, scope, context, entryPath);
      if (chosen !== undefined) expanded.push(...expandList([chosen], scope, context, entryPath, depth + 1, expandEntry));
    } else {
      expanded.push(expandEntry(rawEntry, scope, context, entryPath, depth));
    }
  });
  return expanded;
}

function iterateLoop(loop, scope, context, path) {
  const unknownKeys = Object.keys(loop).filter((key) => !["$each", "as", "chunk", "do"].includes(key));
  if (unknownKeys.length > 0 || loop.do === undefined) throw templateError(path, "is a loop and takes `$each`, `as`, `chunk` and `do` only");
  const variableName = loop.as ?? "item";
  if (typeof variableName !== "string" || !IDENTIFIER_PATTERN.test(variableName)) throw templateError(path, "has an invalid `as` name");
  const list = evaluateExpression(parseExpression(String(loop.$each)), scope, context.settings);
  if (isPlainObject(list)) throw templateError(path, `loops over ${JSON.stringify(loop.$each)}, which is a group of fields, not a list`);
  // One text where a list is expected (a single note, a single address line) is a list of one.
  const entries = chunkEntries(Array.isArray(list) ? list : list === undefined || list === null || list === "" ? [] : [list], loop.chunk, path);
  return entries.map((entry, index) => scope.child({ [variableName]: entry, loop: { index, number: index + 1, first: index === 0, last: index === entries.length - 1 } }));
}

function chunkEntries(list, chunkSize, path) {
  if (chunkSize === undefined) return list;
  if (!Number.isInteger(chunkSize) || chunkSize < 2 || chunkSize > 20) throw templateError(path, "has an invalid `chunk` (an integer from 2 to 20)");
  const chunks = [];
  for (let start = 0; start < list.length; start += chunkSize) chunks.push(list.slice(start, start + chunkSize));
  return chunks;
}

function chooseBranch(condition, scope, context, path) {
  const unknownKeys = Object.keys(condition).filter((key) => !["$if", "then", "else"].includes(key));
  if (unknownKeys.length > 0 || condition.then === undefined) throw templateError(path, "is a condition and takes `$if`, `then` and `else` only");
  return isTruthy(evaluateExpression(parseExpression(String(condition.$if)), scope, context.settings)) ? condition.then : condition.else;
}

function expandBlock(rawNode, scope, context, path, depth) {
  countNode(context, path, depth);
  if (typeof rawNode === "string" || typeof rawNode === "number") return { text: fillText(String(rawNode), scope, context, path) };
  if (!isPlainObject(rawNode)) throw templateError(path, "must be a text or an object");
  if ("$each" in rawNode) throw templateError(path, "is a loop; a loop must be an entry of a list");
  if ("$if" in rawNode) {
    const chosen = chooseBranch(rawNode, scope, context, path);
    return chosen === undefined ? { text: "" } : expandBlock(chosen, scope, context, path, depth + 1);
  }
  const node = {};
  for (const [key, value] of Object.entries(rawNode)) {
    if (CONTENT_KEYS.includes(key)) node[key] = expandContent(key, value, scope, context, `${path}.${key}`, depth);
    else if (key in BLOCK_PROPERTIES) node[key] = checkProperty(value, BLOCK_PROPERTIES[key], `${path}.${key}`);
    else throw templateError(`${path}.${key}`, `is not a known property (allowed: ${[...CONTENT_KEYS, ...Object.keys(BLOCK_PROPERTIES)].join(", ")})`);
  }
  return node;
}

function expandContent(key, value, scope, context, path, depth) {
  const expandBlocks = (list) => expandList(list, scope, context, path, depth + 1, expandBlock);
  switch (key) {
    case "text": return expandText(value, scope, context, path, depth);
    case "stack": case "columns": case "ul": case "ol": return expandBlocks(value);
    case "table": return expandTable(value, scope, context, path, depth);
    case "layout": return checkProperties(value, LAYOUT_PROPERTIES, path);
    case "image": return registerImage(value, scope, context, path);
    case "qr": return fillText(requireString(value, path), scope, context, path).slice(0, 2000);
    case "canvas": return expandList(value, scope, context, path, depth + 1, (vector, _scope, _context, vectorPath) => checkProperties(vector, VECTOR_PROPERTIES, vectorPath));
    case "rule": return checkProperties(value === true ? {} : value, RULE_PROPERTIES, path);
    default: return expandStyleNames(value, context, path);
  }
}

function expandText(value, scope, context, path, depth) {
  if (typeof value === "string" || typeof value === "number") return fillText(String(value), scope, context, path);
  return expandList(value, scope, context, path, depth + 1, expandInline);
}

function expandInline(rawInline, scope, context, path, depth) {
  countNode(context, path, depth);
  if (typeof rawInline === "string" || typeof rawInline === "number") return fillText(String(rawInline), scope, context, path);
  if (!isPlainObject(rawInline) || rawInline.text === undefined) throw templateError(path, "must be a text or an object with `text`");
  const inline = {};
  for (const [key, value] of Object.entries(rawInline)) {
    if (key === "text") inline.text = expandText(value, scope, context, `${path}.text`, depth);
    else if (key === "style") inline.style = expandStyleNames(value, context, `${path}.style`);
    else if (key in STYLE_PROPERTIES) inline[key] = checkProperty(value, STYLE_PROPERTIES[key], `${path}.${key}`);
    else throw templateError(`${path}.${key}`, "is not a known text property");
  }
  return inline;
}

function expandTable(rawTable, scope, context, path, depth) {
  if (!isPlainObject(rawTable) || !Array.isArray(rawTable.body)) throw templateError(path, "needs a `body` list of rows");
  const { body, widths, ...rest } = rawTable;
  const expandRow = (rawRow, rowScope, rowContext, rowPath, rowDepth) => expandList(rawRow, rowScope, rowContext, rowPath, rowDepth + 1, expandBlock);
  const table = { ...checkProperties(rest, TABLE_PROPERTIES, path), body: expandList(body, scope, context, `${path}.body`, depth + 1, expandRow) };
  if (widths !== undefined) table.widths = expandList(widths, scope, context, `${path}.widths`, depth + 1, (width, _scope, _context, widthPath) => checkProperty(width, isWidth, widthPath));
  const columnCount = table.widths?.length ?? table.body[0]?.length ?? 0;
  const unevenRow = table.body.findIndex((row) => row.length !== columnCount);
  if (unevenRow >= 0) throw templateError(`${path}.body[${unevenRow}]`, `has ${table.body[unevenRow].length} cells but the table has ${columnCount} columns`);
  return table;
}

function registerImage(value, scope, context, path) {
  const imagePath = fillText(requireString(value, path), scope, context, path).trim();
  if (imagePath === "") throw templateError(path, "is empty; wrap the image in a `$if` when the value is optional");
  const knownIndex = context.imagePaths.indexOf(imagePath);
  if (knownIndex >= 0) return knownIndex;
  if (context.imagePaths.length >= MAX_IMAGES) throw templateError(path, `is image number ${MAX_IMAGES + 1}; a document may use at most ${MAX_IMAGES} different images`);
  context.imagePaths.push(imagePath);
  return context.imagePaths.length - 1;
}

function expandStyleNames(value, context, path) {
  const names = Array.isArray(value) ? value : [value];
  for (const name of names) {
    if (typeof name !== "string" || !context.styleNames.has(name)) throw templateError(path, `names the style ${JSON.stringify(name)}, which the template's \`styles\` do not define`);
  }
  return value;
}

function fillText(text, scope, context, path) {
  const filled = interpolate(text, scope, context.settings);
  if (filled.length > MAX_TEXT_LENGTH) throw templateError(path, `is longer than ${MAX_TEXT_LENGTH} characters`);
  return filled;
}

function requireString(value, path) {
  if (typeof value !== "string") throw templateError(path, "must be a text");
  return value;
}

function countNode(context, path, depth) {
  context.nodeCount += 1;
  if (context.nodeCount > MAX_NODES) throw invalidInput(`The document has more than ${MAX_NODES} parts after its loops are unrolled; shorten the list it loops over`);
  if (depth > MAX_DEPTH) throw templateError(path, `is nested deeper than ${MAX_DEPTH} levels`);
}

function checkProperties(rawProperties, allowedProperties, path) {
  if (!isPlainObject(rawProperties)) throw templateError(path, "must be an object");
  for (const [key, value] of Object.entries(rawProperties)) {
    if (!(key in allowedProperties)) throw templateError(`${path}.${key}`, `is not a known property (allowed: ${Object.keys(allowedProperties).join(", ")})`);
    checkProperty(value, allowedProperties[key], `${path}.${key}`);
  }
  return structuredClone(rawProperties);
}

function checkProperty(value, isValid, path) {
  if (!isValid(value)) throw templateError(path, `has an invalid value ${JSON.stringify(value)?.slice(0, 60)}`);
  return structuredClone(value);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function templateError(path, problem) {
  return invalidInput(`Template: \`${path}\` ${problem}`);
}
