/**
 * The fonts a document is drawn with, and per-character fallback between them.
 *
 * Two families ship with the plugin so a document looks the same on Linux,
 * Windows and macOS: `sans` (Inter) and `serif` (EB Garamond), both under the
 * SIL Open Font License (see fonts/). They cover Latin, Vietnamese, Cyrillic
 * and Greek. Other scripts (Chinese, Japanese, Korean, Arabic, Thai, ...)
 * need a font file named in DOCUMENT_TEMPLATES_FONTS.
 *
 * A PDF font draws only the characters it has. Text is therefore split into
 * runs: characters the node's own font lacks go to the first extra font that
 * has them. A character that no font has is an error, because the
 * alternative is an empty box on an invoice.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { invalidInput, setupRequired } from "./errors.mjs";

const FONT_DIRECTORY = new URL("../fonts/", import.meta.url);
const BUNDLED_FAMILIES = {
  sans: { normal: "Inter-Regular.ttf", bold: "Inter-SemiBold.ttf" },
  serif: { normal: "EBGaramond-Regular.ttf", bold: "EBGaramond-SemiBold.ttf" },
};
const MAX_REPORTED_CHARACTERS = 12;

/**
 * Loads the bundled families and the extra font files.
 *
 * @param extraFontPaths - Absolute paths of .ttf, .otf or .ttc files from DOCUMENT_TEMPLATES_FONTS (string[])
 * @returns `{families, files}`: families maps a name to `{normal, bold, covers(codePoint), isExtra}`, files maps a file name to its bytes (object)
 * @throws PluginError kind `setup_required` - When an extra font cannot be read or parsed
 */
export async function loadFonts(extraFontPaths = []) {
  const fontkit = await import("fontkit");
  const files = {};
  const families = {};
  for (const [familyName, family] of Object.entries(BUNDLED_FAMILIES)) {
    for (const fileName of Object.values(family)) files[fileName] = await readFile(fileURLToPath(new URL(fileName, FONT_DIRECTORY)));
    families[familyName] = { ...family, covers: createCoverageCheck(fontkit.create(files[family.normal])), isExtra: false };
  }
  for (const fontPath of extraFontPaths) {
    const familyName = basename(fontPath, extname(fontPath));
    const fileName = `extra-${Object.keys(files).length}${extname(fontPath).toLowerCase()}`;
    files[fileName] = await readFile(fontPath).catch((readError) => {
      throw setupRequired(`The font ${basename(fontPath)} from DOCUMENT_TEMPLATES_FONTS could not be read: ${readError.code ?? readError.message}`);
    });
    const { font, faceName } = parseExtraFont(fontkit, files[fileName], fontPath);
    // A collection (.ttc) holds several faces; pdfmake picks one by its PostScript name.
    const fontFile = faceName ? [fileName, faceName] : fileName;
    families[familyName] = { normal: fontFile, bold: fontFile, covers: createCoverageCheck(font), isExtra: true };
  }
  return { families, files };
}

function parseExtraFont(fontkit, bytes, fontPath) {
  try {
    const parsed = fontkit.create(bytes);
    const isCollection = Array.isArray(parsed.fonts);
    const font = isCollection ? parsed.fonts[0] : parsed;
    if (typeof font?.hasGlyphForCodePoint !== "function") throw new Error("no font face found");
    return { font, faceName: isCollection ? font.postscriptName : null };
  } catch (parseError) {
    throw setupRequired(`The font ${basename(fontPath)} from DOCUMENT_TEMPLATES_FONTS is not a usable .ttf, .otf or .ttc file: ${parseError.message}`);
  }
}

function createCoverageCheck(font) {
  const known = new Map();
  return (codePoint) => {
    if (!known.has(codePoint)) known.set(codePoint, font.hasGlyphForCodePoint(codePoint));
    return known.get(codePoint);
  };
}

/**
 * Builds pdfmake's font table from loaded families.
 *
 * @param families - From loadFonts (object)
 * @returns `{name: {normal, bold, italics, bolditalics}}` with file names (object)
 */
export function buildFontTable(families) {
  return Object.fromEntries(Object.entries(families).map(([name, family]) => [name, { normal: family.normal, bold: family.bold, italics: family.normal, bolditalics: family.bold }]));
}

/**
 * Splits a text into runs by the font that can draw each character.
 *
 * @param text - Text to draw (string)
 * @param familyName - The node's own font family (string)
 * @param families - From loadFonts (object)
 * @param missing - Collects characters no font has (Set<string>)
 * @returns The text unchanged when its own font covers it, else runs `[{text, font?}]` (string | object[])
 *
 * @example
 * splitByFont("PT 株式会社", "sans", families, new Set()); // [{ text: "PT " }, { text: "株式会社", font: "NotoSansJP-Regular" }]
 */
export function splitByFont(text, familyName, families, missing) {
  const ownFamily = families[familyName];
  const runs = [];
  for (const character of text) {
    const runFont = pickFont(character, familyName, ownFamily, families, missing);
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.font === runFont) lastRun.text += character;
    else runs.push({ text: character, font: runFont });
  }
  if (runs.every((run) => run.font === familyName)) return text;
  return runs.map((run) => (run.font === familyName ? { text: run.text } : run));
}

function pickFont(character, familyName, ownFamily, families, missing) {
  const codePoint = character.codePointAt(0);
  if (isAlwaysDrawable(codePoint) || ownFamily.covers(codePoint)) return familyName;
  const fallback = Object.entries(families).find(([, family]) => family.isExtra && family.covers(codePoint));
  if (fallback) return fallback[0];
  missing.add(character);
  return familyName;
}

// Line breaks, tabs, joiners and variation selectors have no glyph of their own.
function isAlwaysDrawable(codePoint) {
  return codePoint < 0x20 || codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0xfeff || (codePoint >= 0xfe00 && codePoint <= 0xfe0f);
}

/**
 * Reports characters that no available font can draw.
 *
 * @param missing - Characters collected by splitByFont (Set<string>)
 * @throws PluginError kind `invalid_input` - When the set is not empty
 */
export function assertAllCharactersDrawable(missing) {
  if (missing.size === 0) return;
  const shown = [...missing].slice(0, MAX_REPORTED_CHARACTERS).map((character) => `${character} (U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")})`);
  const more = missing.size > shown.length ? ` and ${missing.size - shown.length} more` : "";
  throw invalidInput(`No available font has these characters: ${shown.join(", ")}${more}. The built-in fonts cover Latin, Vietnamese, Cyrillic and Greek; for other scripts set DOCUMENT_TEMPLATES_FONTS to a font file (.ttf, .otf or .ttc) that has them`);
}
