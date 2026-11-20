/**
 * Plugin icons: each plugin has one `<plugin>/icon.svg`, generated from `icons.json` by
 * scripts/generate-icons.mjs (see docs/icons.md).
 *
 * Icons are shown by the graphrt-builder-desktop Plugins screen, so they are treated as
 * untrusted markup: only a small allowlist of shape elements and presentation attributes is
 * accepted (no scripts, links, styles, external references or text). They are published as
 * content-addressed assets of the `catalog` release (`icon-<plugin>-<sha256 prefix>.svg`), so a
 * catalog `icon_url` never changes meaning, and they are never packed into plugin tarballs.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";

export const ICON_FILE_NAME = "icon.svg";
export const ICON_SOURCES_FILE_NAME = "icons.json";
/** Largest accepted icon. Most are under 2 KB; a few detailed brand marks (Ollama, PostgreSQL) reach ~5 KB. */
export const MAX_ICON_BYTES = 8 * 1024;
export const ICON_HASH_LENGTH = 12;
export const ICON_SOURCES = ["simple-icons", "lucide"];
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const ALLOWED_ELEMENTS = new Set(["svg", "g", "path", "circle", "rect", "line", "polyline", "polygon"]);
const ROOT_ONLY_ATTRIBUTES = new Set(["xmlns", "viewBox"]);
// The icon's own size on <svg>, a rectangle's size on <rect>.
const SIZE_ATTRIBUTES = new Set(["width", "height"]);
const SHAPE_ATTRIBUTES = new Set(["d", "cx", "cy", "r", "x", "y", "rx", "ry", "x1", "y1", "x2", "y2", "points"]);
const PRESENTATION_ATTRIBUTES = new Set([
  "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-opacity", "opacity", "clip-rule",
]);
const COLOR_ATTRIBUTES = new Set(["fill", "stroke"]);
const COLOR_VALUE_PATTERN = /^(none|currentColor|#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6})$/;
// Numbers, path commands, separators: nothing that could name a URL, a function or an entity.
const GEOMETRY_VALUE_PATTERN = /^[0-9A-Za-z.,\s+-]*$/;
const KEYWORD_VALUE_PATTERN = /^[a-z-]+$|^[0-9.]+$/;
// One tag: `<name attr="value" ...>`, `</name>` or `<name ... />`, with only double-quoted values.
const TAG_PATTERN = /\s*<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:\s+[A-Za-z][A-Za-z0-9:-]*="[^"<>&]*")*)\s*(\/?)>/y;
const ATTRIBUTE_PATTERN = /([A-Za-z][A-Za-z0-9:-]*)="([^"]*)"/g;

/**
 * Checks an icon against the SVG allowlist.
 *
 * Accepts only `svg`, `g`, `path`, `circle`, `rect`, `line`, `polyline` and `polygon` elements with
 * geometry and presentation attributes (colours as hex, `none` or `currentColor`). Anything else
 * fails: scripts, `foreignObject`, `style`, `href`/`xlink:href`, event handlers, `url(...)`
 * references, comments, doctypes, entities, processing instructions and text content.
 *
 * @param svgText - The SVG file contents (string)
 * @returns Problems found; empty when the icon is safe (string[])
 *
 * @example
 * findIconProblems('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'); // []
 */
export function findIconProblems(svgText) {
  const problems = [];
  const openElements = [];
  let rootCount = 0;
  let position = 0;
  TAG_PATTERN.lastIndex = 0;
  while (position < svgText.length && svgText.slice(position).trim() !== "") {
    TAG_PATTERN.lastIndex = position;
    const tagMatch = TAG_PATTERN.exec(svgText);
    if (!tagMatch) return [...problems, `unexpected content at offset ${position}: ${JSON.stringify(svgText.slice(position, position + 40))}`];
    position = TAG_PATTERN.lastIndex;
    const [, closingSlash, elementName, attributeText, selfClosingSlash] = tagMatch;
    if (closingSlash) {
      if (attributeText || selfClosingSlash || openElements.pop() !== elementName) problems.push(`unbalanced </${elementName}>`);
      continue;
    }
    if (openElements.length === 0) rootCount += 1;
    problems.push(...findElementProblems(elementName, attributeText, openElements.length === 0));
    if (!selfClosingSlash) openElements.push(elementName);
  }
  if (openElements.length > 0) problems.push(`unclosed <${openElements.at(-1)}>`);
  if (rootCount !== 1) problems.push(`expected exactly one root <svg>, found ${rootCount} top-level elements`);
  return problems;
}

function findElementProblems(elementName, attributeText, isRoot) {
  if (!ALLOWED_ELEMENTS.has(elementName)) return [`element <${elementName}> is not allowed`];
  if (isRoot !== (elementName === "svg")) return [isRoot ? `root element must be <svg>, not <${elementName}>` : "<svg> may only be the root element"];
  const problems = [];
  const seenAttributes = new Set();
  for (const [, attributeName, attributeValue] of attributeText.matchAll(ATTRIBUTE_PATTERN)) {
    if (seenAttributes.has(attributeName)) problems.push(`<${elementName}> repeats ${attributeName}`);
    seenAttributes.add(attributeName);
    const problem = findAttributeProblem(attributeName, attributeValue, isRoot);
    if (problem) problems.push(`<${elementName}> ${problem}`);
  }
  if (isRoot && !seenAttributes.has("viewBox")) problems.push("<svg> needs a viewBox");
  return problems;
}

function findAttributeProblem(attributeName, attributeValue, isRoot) {
  if (attributeName === "xmlns") return isRoot && attributeValue === SVG_NAMESPACE ? null : `xmlns must be ${SVG_NAMESPACE} on the root`;
  if (ROOT_ONLY_ATTRIBUTES.has(attributeName) && !isRoot) return `${attributeName} is only allowed on the root <svg>`;
  if (ROOT_ONLY_ATTRIBUTES.has(attributeName) || SIZE_ATTRIBUTES.has(attributeName)) {
    return /^[0-9.\s-]+$/.test(attributeValue) ? null : `${attributeName}="${attributeValue}" is not numeric`;
  }
  if (COLOR_ATTRIBUTES.has(attributeName)) {
    return COLOR_VALUE_PATTERN.test(attributeValue) ? null : `${attributeName}="${attributeValue}" must be a hex colour, none or currentColor`;
  }
  if (SHAPE_ATTRIBUTES.has(attributeName)) {
    return GEOMETRY_VALUE_PATTERN.test(attributeValue) ? null : `${attributeName} holds characters that are not geometry`;
  }
  if (PRESENTATION_ATTRIBUTES.has(attributeName)) {
    return KEYWORD_VALUE_PATTERN.test(attributeValue) ? null : `${attributeName}="${attributeValue}" is not a plain keyword or number`;
  }
  return `attribute ${attributeName} is not allowed`;
}

/**
 * Release asset name of an icon, content-addressed so the URL is immutable.
 *
 * @param pluginName - Plugin name (string)
 * @param svgBytes - The icon file bytes (Buffer)
 * @returns e.g. `icon-meta-api-1a2b3c4d5e6f.svg` (string)
 */
export function iconAssetNameFor(pluginName, svgBytes) {
  const contentHash = createHash("sha256").update(svgBytes).digest("hex");
  return `icon-${pluginName}-${contentHash.slice(0, ICON_HASH_LENGTH)}.svg`;
}

/**
 * Reads and validates a plugin's `icon.svg` from the repository.
 *
 * @param pluginName - Plugin directory name (string)
 * @param repositoryRoot - Repository root (string, default: this repo)
 * @returns `{pluginName, filePath, bytes, sha256, assetName}` (object)
 * @throws Error - When the icon is missing, too large or fails the allowlist
 */
export function readPluginIcon(pluginName, repositoryRoot = REPO_ROOT) {
  const filePath = join(repositoryRoot, pluginName, ICON_FILE_NAME);
  if (!existsSync(filePath)) throw new Error(`${pluginName}: no ${ICON_FILE_NAME} (add it to ${ICON_SOURCES_FILE_NAME} and run scripts/generate-icons.mjs)`);
  const bytes = readFileSync(filePath);
  if (bytes.length > MAX_ICON_BYTES) throw new Error(`${pluginName}: ${ICON_FILE_NAME} is ${bytes.length} bytes; the limit is ${MAX_ICON_BYTES}`);
  const problems = findIconProblems(bytes.toString("utf8"));
  if (problems.length > 0) throw new Error(`${pluginName}: unsafe ${ICON_FILE_NAME}: ${problems.join("; ")}`);
  return {
    pluginName,
    filePath,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    assetName: iconAssetNameFor(pluginName, bytes),
  };
}

/**
 * Reads `icons.json`, the source of every plugin icon.
 *
 * @param filePath - Path to icons.json (string, default: the repo's)
 * @returns `{plugin: {source, slug, version, color}}` (object)
 * @throws Error - When the file is missing or not valid JSON
 */
export function readIconSources(filePath = join(REPO_ROOT, ICON_SOURCES_FILE_NAME)) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${ICON_SOURCES_FILE_NAME}: ${error.message}`);
  }
}
