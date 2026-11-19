/**
 * Kemendagri region codes: parsing the cahyadsn/wilayah SQL dump, the code hierarchy and name search.
 *
 * Codes are dotted (Kepmendagri style): province "32", regency/city "32.73", district "32.73.07", village
 * "32.73.07.1001". The parent of a code is the code without its last segment. The first digit of a village's last
 * segment is 1 for a kelurahan and 2 for a desa.
 *
 * Everything here is pure: no I/O.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const LEVELS = ["province", "regency", "district", "village"];
const DOTTED_CODE_PATTERN = /^\d{2}(\.\d{2}(\.\d{2}(\.\d{4})?)?)?$/;
const DIGIT_SEGMENT_LENGTHS = { 2: [2], 4: [2, 2], 6: [2, 2, 2], 10: [2, 2, 2, 4] };
// One SQL tuple: ('32.73.07.1001','Pasteur'); a quote inside a name is doubled ('Ba''u').
const SQL_ROW_PATTERN = /\('(\d{2}(?:\.\d{2}){0,2}(?:\.\d{4})?)','((?:[^']|'')*)'\)/g;
const REGENCY_PREFIXES = ["kabupaten administrasi ", "kota administrasi ", "kabupaten ", "kota "];

/**
 * Parses the `INSERT INTO wilayah (kode, nama) VALUES (...)` rows of the dump.
 *
 * @param sqlText - Contents of db/wilayah.sql (string)
 * @returns Rows in file order (Array<{code: string, name: string}>)
 *
 * @example
 * parseRegionSql("('32','Jawa Barat'),\n('11.01.02.2018','Pasi Kuala Ba''u');");
 * // [{code: "32", name: "Jawa Barat"}, {code: "11.01.02.2018", name: "Pasi Kuala Ba'u"}]
 */
export function parseRegionSql(sqlText) {
  return [...String(sqlText).matchAll(SQL_ROW_PATTERN)].map(([, code, quotedName]) => ({ code, name: quotedName.replaceAll("''", "'").trim() }));
}

/**
 * Returns the level of a dotted code.
 *
 * @param code - Dotted code (string)
 * @returns "province" | "regency" | "district" | "village" (string)
 */
export function levelOfCode(code) {
  return LEVELS[code.split(".").length - 1];
}

/**
 * Normalizes a region code given with or without dots ("3273" or "32.73") to the dotted form.
 *
 * @param rawCode - Code from the caller (string | number)
 * @param parameterName - Name for the error message (string)
 * @returns Dotted code (string)
 * @throws PluginError kind `invalid_input` - When it is not a Kemendagri code shape
 *
 * @example
 * normalizeRegionCode("3273070001".slice(0, 6), "code"); // "32.73.07"
 */
export function normalizeRegionCode(rawCode, parameterName) {
  const trimmed = String(rawCode ?? "").trim();
  if (DOTTED_CODE_PATTERN.test(trimmed)) return trimmed;
  const segmentLengths = /^\d+$/.test(trimmed) ? DIGIT_SEGMENT_LENGTHS[trimmed.length] : undefined;
  if (!segmentLengths) {
    throw new PluginError(`\`${parameterName}\` must be a Kemendagri code such as 32, 32.73, 32.73.07 or 32.73.07.1001 (dots optional); got ${JSON.stringify(trimmed)}`, { kind: "invalid_input" });
  }
  let offset = 0;
  return segmentLengths.map((length) => trimmed.slice(offset, (offset += length))).join(".");
}

/**
 * Builds lookup structures over the rows.
 *
 * @param rows - Parsed rows (Array<{code, name}>)
 * @returns `{namesByCode: Map, childrenByParent: Map<string, string[]>, searchEntries: Array}` (object)
 */
export function buildRegionIndex(rows) {
  const namesByCode = new Map();
  const childrenByParent = new Map();
  for (const { code, name } of rows) {
    if (namesByCode.has(code)) continue;
    namesByCode.set(code, name);
    const parent = parentCode(code) ?? "";
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(code);
  }
  for (const children of childrenByParent.values()) children.sort();
  const searchEntries = [...namesByCode].map(([code, name]) => ({ code, name, searchName: normalizeSearchText(name) }));
  return { namesByCode, childrenByParent, searchEntries };
}

function parentCode(code) {
  const lastDot = code.lastIndexOf(".");
  return lastDot === -1 ? undefined : code.slice(0, lastDot);
}

/**
 * Describes one region for output.
 *
 * @param regionIndex - Index from buildRegionIndex (object)
 * @param code - Dotted code present in the index (string)
 * @returns `{code, name, level, ...(village) type}` (object)
 */
export function describeRegion(regionIndex, code) {
  const level = levelOfCode(code);
  const region = { code, name: regionIndex.namesByCode.get(code), level };
  if (level === "village") region.type = code.split(".")[3].startsWith("1") ? "kelurahan" : "desa";
  return region;
}

/**
 * Lists the parents of a code from the province down, without the code itself.
 *
 * @param regionIndex - Index (object)
 * @param code - Dotted code (string)
 * @returns Parent regions (Array<{code, name, level}>)
 */
export function listParents(regionIndex, code) {
  const parents = [];
  for (let parent = parentCode(code); parent !== undefined; parent = parentCode(parent)) {
    if (regionIndex.namesByCode.has(parent)) parents.unshift(describeRegion(regionIndex, parent));
  }
  return parents;
}

/**
 * Lowercases, strips diacritics and punctuation, and collapses whitespace.
 *
 * @param text - Any text (string)
 * @returns Normalized text (string)
 */
export function normalizeSearchText(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Finds regions whose name contains every word of the query, best matches first.
 *
 * @param regionIndex - Index (object)
 * @param searchOptions - Search options (object)
 * @param searchOptions.query - Name or part of a name, e.g. "coblong" or "kota bandung" (string)
 * @param searchOptions.level - Only this level (string, optional)
 * @param searchOptions.withinCode - Only codes under this dotted code (string, optional)
 * @param searchOptions.limit - Maximum results (number)
 * @returns `{matches: Array<{code, name, level, score}>, total: number}` (object)
 */
export function searchRegions(regionIndex, { query, level, withinCode, limit }) {
  const normalizedQuery = normalizeSearchText(query);
  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  if (queryWords.length === 0) throw new PluginError("`query` must contain letters or digits", { kind: "invalid_input" });
  const scored = [];
  for (const entry of regionIndex.searchEntries) {
    if (withinCode && !entry.code.startsWith(`${withinCode}.`)) continue;
    if (level && levelOfCode(entry.code) !== level) continue;
    const score = scoreName(entry.searchName, normalizedQuery, queryWords);
    if (score !== undefined) scored.push({ code: entry.code, score });
  }
  scored.sort((left, right) => left.score - right.score || left.code.split(".").length - right.code.split(".").length || left.code.localeCompare(right.code));
  return { matches: scored.slice(0, limit), total: scored.length };
}

// Lower is better: exact name (also without "Kabupaten"/"Kota"), prefix, word prefix, all words contained. Equal
// scores list higher levels first, so "bandung" gives Kabupaten and Kota Bandung before villages named Bandung.
function scoreName(searchName, normalizedQuery, queryWords) {
  if (!queryWords.every((word) => searchName.includes(word))) return undefined;
  const withoutPrefix = REGENCY_PREFIXES.reduce((name, prefix) => (name.startsWith(prefix) ? name.slice(prefix.length) : name), searchName);
  if (searchName === normalizedQuery || withoutPrefix === normalizedQuery) return 0;
  if (searchName.startsWith(normalizedQuery) || withoutPrefix.startsWith(normalizedQuery)) return 1;
  if (` ${searchName}`.includes(` ${normalizedQuery}`)) return 2;
  return 3;
}
