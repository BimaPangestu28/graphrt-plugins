/**
 * Generates every `<plugin>/icon.svg` from `icons.json` (see docs/icons.md).
 *
 * Usage: node scripts/generate-icons.mjs [--check]
 *   --check  change nothing; exit 1 when an icon or icons.json is out of date
 *
 * Each `icons.json` entry names a source and a slug:
 *   - `{"source": "simple-icons", "slug": "github"}`: the brand mark from Simple Icons (CC0),
 *     filled with the brand colour Simple Icons publishes,
 *   - `{"source": "lucide", "slug": "database"}`: a Lucide glyph (ISC), stroked with `color`
 *     (default: the neutral accent below).
 * The script fills in `version` (the pinned package version) and `color`, rewrites icons.json
 * sorted by plugin, and writes each icon. Output depends only on icons.json and the package
 * versions pinned in the root package-lock.json, so reruns are byte-identical.
 * Needs the root devDependencies: run `npm ci` at the repo root first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listPluginNames } from "./lib/plugin-package.mjs";
import { ICON_FILE_NAME, ICON_SOURCES, ICON_SOURCES_FILE_NAME, MAX_ICON_BYTES, SVG_NAMESPACE, findIconProblems, readIconSources } from "./lib/plugin-icons.mjs";
import { REPO_ROOT } from "./plugins.mjs";

/** Stroke colour of Lucide glyphs (Tailwind slate-500): readable on light and dark backgrounds. */
export const NEUTRAL_ACCENT_COLOR = "#64748B";
const LUCIDE_SHAPE_ATTRIBUTES = new Set(["d", "cx", "cy", "r", "x", "y", "width", "height", "rx", "ry", "x1", "y1", "x2", "y2", "points"]);

const NODE_MODULES_DIRECTORY = join(REPO_ROOT, "node_modules");

function readInstalledVersion(packageName) {
  return JSON.parse(readFileSync(join(NODE_MODULES_DIRECTORY, packageName, "package.json"), "utf8")).version;
}

/** Loads both icon sets: `{simpleIcons: Map<slug, icon>, lucideNodes: {name: node[]}, versions}`. */
async function loadIconSets() {
  try {
    const simpleIconsModule = await import(pathToFileURL(join(NODE_MODULES_DIRECTORY, "simple-icons", "index.mjs")).href);
    const simpleIcons = new Map(Object.values(simpleIconsModule).filter((icon) => icon?.slug).map((icon) => [icon.slug, icon]));
    const lucideNodes = JSON.parse(readFileSync(join(NODE_MODULES_DIRECTORY, "lucide-static", "icon-nodes.json"), "utf8"));
    return { simpleIcons, lucideNodes, versions: { "simple-icons": readInstalledVersion("simple-icons"), lucide: readInstalledVersion("lucide-static") } };
  } catch (error) {
    throw new Error(`cannot load simple-icons / lucide-static (run \`npm ci\` at the repo root): ${error.message}`);
  }
}

/**
 * Renders a Simple Icons brand mark as a single filled path.
 *
 * @param brandIcon - A simple-icons export (`{path, hex}`) (object)
 * @returns SVG text (string)
 */
export function renderSimpleIcon(brandIcon) {
  return `<svg xmlns="${SVG_NAMESPACE}" width="24" height="24" viewBox="0 0 24 24" fill="#${brandIcon.hex}"><path d="${brandIcon.path}"/></svg>\n`;
}

/**
 * Renders a Lucide icon node as a stroked SVG. `ellipse` (not on the icon allowlist) becomes an
 * equivalent two-arc `path`, `fill="currentColor"` takes the stroke colour, and any other
 * attribute that is not geometry is dropped.
 *
 * @param iconNode - Lucide `[tag, attributes][]` (array)
 * @param strokeColor - Hex stroke colour (string)
 * @returns SVG text (string)
 */
export function renderLucideIcon(iconNode, strokeColor) {
  const children = iconNode.map(([tagName, attributes]) => renderLucideChild(tagName, attributes, strokeColor)).join("");
  return `<svg xmlns="${SVG_NAMESPACE}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</svg>\n`;
}

function renderLucideChild(tagName, attributes, strokeColor) {
  if (tagName === "ellipse") return renderLucideChild("path", { d: ellipseToPathData(attributes) }, strokeColor);
  const attributeText = Object.entries(attributes)
    .map(([attributeName, attributeValue]) => [attributeName, renderLucideAttributeValue(attributeName, attributeValue, strokeColor)])
    .filter(([, attributeValue]) => attributeValue !== null)
    .map(([attributeName, attributeValue]) => ` ${attributeName}="${attributeValue}"`)
    .join("");
  return `<${tagName}${attributeText}/>`;
}

// Geometry is kept; `fill="currentColor"` (dots) takes the stroke colour, since an <img> has no current colour.
function renderLucideAttributeValue(attributeName, attributeValue, strokeColor) {
  if (LUCIDE_SHAPE_ATTRIBUTES.has(attributeName)) return attributeValue;
  if (attributeName === "fill" && attributeValue === "currentColor") return strokeColor;
  if (attributeName === "fill" && attributeValue === "none") return attributeValue;
  return null;
}

function ellipseToPathData({ cx, cy, rx, ry }) {
  const [centerX, centerY, radiusX, radiusY] = [cx, cy, rx, ry].map(Number);
  return `M${centerX - radiusX} ${centerY}a${radiusX} ${radiusY} 0 1 0 ${2 * radiusX} 0a${radiusX} ${radiusY} 0 1 0 ${-2 * radiusX} 0`;
}

/**
 * Resolves one icons.json entry into its normalised entry and SVG text.
 *
 * @param pluginName - Plugin name (string)
 * @param sourceEntry - The icons.json entry (object)
 * @param iconSets - From loadIconSets (object)
 * @returns `{entry, svgText}` (object)
 * @throws Error - On an unknown source or slug, or an icon that fails the allowlist or size cap
 */
export function resolveIcon(pluginName, sourceEntry, { simpleIcons, lucideNodes, versions }) {
  const { source, slug } = sourceEntry ?? {};
  if (!ICON_SOURCES.includes(source)) throw new Error(`${pluginName}: source must be one of ${ICON_SOURCES.join(", ")}`);
  let entry;
  let svgText;
  if (source === "simple-icons") {
    const brandIcon = simpleIcons.get(slug);
    if (!brandIcon) throw new Error(`${pluginName}: simple-icons ${versions[source]} has no slug \`${slug}\` (removed brands fall back to lucide)`);
    // Simple Icons is CC0 as a project, but marks with their own `license` data come under other terms.
    if (brandIcon.license) throw new Error(`${pluginName}: simple-icons \`${slug}\` has its own licence (${brandIcon.license.type}); use a lucide glyph instead`);
    entry = { source, slug, version: versions[source], color: `#${brandIcon.hex}` };
    svgText = renderSimpleIcon(brandIcon);
  } else {
    if (!Object.hasOwn(lucideNodes, slug)) throw new Error(`${pluginName}: lucide ${versions[source]} has no icon \`${slug}\``);
    const color = sourceEntry.color ?? NEUTRAL_ACCENT_COLOR;
    entry = { source, slug, version: versions[source], color };
    svgText = renderLucideIcon(lucideNodes[slug], color);
  }
  const problems = findIconProblems(svgText);
  if (problems.length > 0) throw new Error(`${pluginName}: generated icon fails the allowlist: ${problems.join("; ")}`);
  if (Buffer.byteLength(svgText) > MAX_ICON_BYTES) throw new Error(`${pluginName}: generated icon is larger than ${MAX_ICON_BYTES} bytes`);
  return { entry, svgText };
}

function assertSourcesCoverPlugins(iconSources, pluginNames) {
  const missing = pluginNames.filter((pluginName) => !Object.hasOwn(iconSources, pluginName));
  const unknown = Object.keys(iconSources).filter((pluginName) => !pluginNames.includes(pluginName));
  if (missing.length > 0) throw new Error(`${ICON_SOURCES_FILE_NAME} has no entry for: ${missing.join(", ")}`);
  if (unknown.length > 0) throw new Error(`${ICON_SOURCES_FILE_NAME} names unknown plugins: ${unknown.join(", ")}`);
}

/** Writes (or, with checkOnly, compares) one file; returns true when it was out of date. */
function syncFile(filePath, expectedText, checkOnly) {
  const isCurrent = existsSync(filePath) && readFileSync(filePath, "utf8") === expectedText;
  if (!isCurrent && !checkOnly) writeFileSync(filePath, expectedText);
  return !isCurrent;
}

/** Resolves every plugin's icon, reporting all bad entries at once; writes nothing. */
function resolveAllIcons(pluginNames, iconSources, iconSets) {
  const resolvedIcons = [];
  const errors = [];
  for (const pluginName of pluginNames) {
    try {
      resolvedIcons.push({ pluginName, ...resolveIcon(pluginName, iconSources[pluginName], iconSets) });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length > 0) throw new Error(`${errors.length} bad ${ICON_SOURCES_FILE_NAME} entries:\n${errors.join("\n")}`);
  return resolvedIcons;
}

async function main() {
  const checkOnly = process.argv.slice(2).includes("--check");
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (unknownArguments.length > 0) throw new Error(`unknown argument \`${unknownArguments[0]}\``);
  const pluginNames = listPluginNames();
  const iconSources = readIconSources();
  assertSourcesCoverPlugins(iconSources, pluginNames);
  const resolvedIcons = resolveAllIcons(pluginNames, iconSources, await loadIconSets());
  const staleFiles = resolvedIcons
    .filter(({ pluginName, svgText }) => syncFile(join(REPO_ROOT, pluginName, ICON_FILE_NAME), svgText, checkOnly))
    .map(({ pluginName }) => `${pluginName}/${ICON_FILE_NAME}`);
  const normalisedSources = Object.fromEntries(resolvedIcons.map(({ pluginName, entry }) => [pluginName, entry]));
  if (syncFile(join(REPO_ROOT, ICON_SOURCES_FILE_NAME), `${JSON.stringify(normalisedSources, null, 2)}\n`, checkOnly)) staleFiles.push(ICON_SOURCES_FILE_NAME);
  if (checkOnly && staleFiles.length > 0) throw new Error(`out of date (run node scripts/generate-icons.mjs): ${staleFiles.join(", ")}`);
  const sourceCounts = ICON_SOURCES.map((source) => `${source}: ${resolvedIcons.filter(({ entry }) => entry.source === source).length}`);
  console.error(`${checkOnly ? "checked" : "generated"} ${pluginNames.length} icons (${sourceCounts.join(", ")}); ${staleFiles.length} file(s) ${checkOnly ? "stale" : "updated"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`generate-icons: ${error.message}`);
    process.exit(1);
  });
}
