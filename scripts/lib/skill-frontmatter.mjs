/**
 * Reads the `SKILL.md` of a catalog skill: YAML frontmatter between two `---` lines, then Markdown instructions
 * (the Agent Skills specification, https://agentskills.io/specification).
 *
 * This is NOT a YAML parser. Catalog skills must write their frontmatter in a small subset that every YAML reader
 * understands the same way, so that what is validated and listed here is exactly what graphrt (graphrt-skill, a
 * real YAML parser) reads after the install:
 *
 *   name: refund-policy                       plain value on one line
 *   description: "Use when: a refund is asked" a value holding `: ` or ` #` is quoted
 *   license: Apache-2.0
 *   compatibility: Needs the orders plugin
 *   metadata:                                 a map of `key: value` lines, indented by two spaces
 *     version: "1.0.0"                        anything YAML would read as a number, boolean or date is quoted
 *     display_name: Refund policy
 *   allowed-tools: orders/lookup mail/send    space-separated, or a list of `  - item` lines
 *
 * Everything else is refused with the line number: unknown or repeated keys, comments, block scalars (`|`, `>`),
 * flow collections, anchors, tags, multi-line values, tabs, carriage returns and a byte order mark.
 */

export const SKILL_FILE_NAME = "SKILL.md";
const FRONTMATTER_FENCE = "---";
const SCALAR_KEYS = new Set(["name", "description", "license", "compatibility"]);
const METADATA_KEY = "metadata";
const ALLOWED_TOOLS_KEY = "allowed-tools";
const TOP_LEVEL_LINE_PATTERN = /^([a-z][a-z0-9-]*):(?: (.*))?$/;
const METADATA_LINE_PATTERN = /^ {2}([A-Za-z][A-Za-z0-9_-]*): (.+)$/;
const LIST_ITEM_PATTERN = /^ {2}- (.+)$/;
const DOUBLE_QUOTED_PATTERN = /^"((?:[^"\\]|\\["\\])*)"$/;
const SINGLE_QUOTED_PATTERN = /^'((?:[^']|'')*)'$/;
/** First characters that give a plain YAML scalar another meaning (collections, anchors, tags, block scalars, ...). */
const PLAIN_SCALAR_FORBIDDEN_START_PATTERN = /^[[\]{}&*!|>'"%@`#,?:-]/;
/** Plain scalars some YAML version reads as null, a boolean, a number or a date instead of text. */
const NON_TEXT_SCALAR_PATTERNS = [
  /^(~|null|true|false|yes|no|on|off|y|n)$/i,
  /^[-+]?(\.\d+|\d[\d_]*(\.[\d_]*)?)([eE][-+]?\d+)?$/,
  /^[-+]?0[xob][0-9a-f_]+$/i,
  /^[-+]?\.(inf|nan)$/i,
  /^\d{4}-\d{1,2}-\d{1,2}([Tt ].*)?$/,
];

/**
 * Parses the text of a `SKILL.md`.
 *
 * @param skillText - The file's text (string)
 * @returns `{frontmatter: {name, description, license, compatibility, metadata, allowedTools}, body}`: scalar
 *   fields are strings or undefined when absent, metadata is an object of strings, allowedTools a string[], body
 *   the Markdown after the frontmatter, trimmed (object)
 * @throws Error - When the frontmatter is missing or uses anything outside the subset described above
 */
export function parseSkillFile(skillText) {
  if (skillText.includes("\r")) throw new Error(`${SKILL_FILE_NAME} must use LF line endings (found a carriage return)`);
  if (skillText.startsWith("\uFEFF")) throw new Error(`${SKILL_FILE_NAME} must not start with a byte order mark`);
  const lines = skillText.split("\n");
  if (lines[0] !== FRONTMATTER_FENCE) throw new Error(`${SKILL_FILE_NAME} must start with frontmatter between two \`---\` lines`);
  const closingIndex = lines.indexOf(FRONTMATTER_FENCE, 1);
  if (closingIndex === -1) throw new Error(`${SKILL_FILE_NAME} frontmatter has no closing \`---\` line`);
  const frontmatter = parseFrontmatterLines(lines.slice(1, closingIndex));
  return { frontmatter, body: lines.slice(closingIndex + 1).join("\n").trim() };
}

function parseFrontmatterLines(frontmatterLines) {
  const frontmatter = { name: undefined, description: undefined, license: undefined, compatibility: undefined, metadata: {}, allowedTools: [] };
  const seenKeys = new Set();
  let index = 0;
  // Line 1 of the file is the opening fence, so frontmatter line `index` is file line `index + 2`.
  const fail = (lineIndex, message) => {
    throw new Error(`${SKILL_FILE_NAME} line ${lineIndex + 2}: ${message}`);
  };
  while (index < frontmatterLines.length) {
    const line = frontmatterLines[index];
    const lineIndex = index;
    index += 1;
    if (line === "") continue;
    if (line.includes("\t")) fail(lineIndex, "tabs are not allowed in the frontmatter");
    const topLevelMatch = TOP_LEVEL_LINE_PATTERN.exec(line);
    if (!topLevelMatch) fail(lineIndex, `expected \`key: value\` (found ${JSON.stringify(line)}); comments, multi-line values and extra indentation are not supported`);
    const [, key, rawValue = ""] = topLevelMatch;
    if (seenKeys.has(key)) fail(lineIndex, `\`${key}\` is given twice`);
    seenKeys.add(key);
    const indentedLines = [];
    while (index < frontmatterLines.length && frontmatterLines[index].startsWith(" ")) {
      indentedLines.push({ text: frontmatterLines[index], lineIndex: index });
      index += 1;
    }
    if (SCALAR_KEYS.has(key)) {
      if (indentedLines.length > 0) fail(indentedLines[0].lineIndex, `\`${key}\` must be written on one line`);
      frontmatter[key] = parseScalar(rawValue, (message) => fail(lineIndex, `\`${key}\`: ${message}`));
    } else if (key === METADATA_KEY) {
      if (rawValue.trim() !== "") fail(lineIndex, "`metadata` must be followed by indented `key: value` lines");
      frontmatter.metadata = parseMetadataLines(indentedLines, fail);
    } else if (key === ALLOWED_TOOLS_KEY) {
      frontmatter.allowedTools = parseAllowedTools(rawValue, indentedLines, lineIndex, fail);
    } else {
      fail(lineIndex, `unknown field \`${key}\` (known: name, description, license, compatibility, metadata, allowed-tools)`);
    }
  }
  return frontmatter;
}

function parseMetadataLines(indentedLines, fail) {
  const metadata = {};
  for (const { text, lineIndex } of indentedLines) {
    const metadataMatch = METADATA_LINE_PATTERN.exec(text);
    if (!metadataMatch) fail(lineIndex, `expected a metadata line \`  key: value\` indented by two spaces (found ${JSON.stringify(text)})`);
    const [, key, rawValue] = metadataMatch;
    if (Object.hasOwn(metadata, key)) fail(lineIndex, `metadata \`${key}\` is given twice`);
    metadata[key] = parseScalar(rawValue, (message) => fail(lineIndex, `metadata \`${key}\`: ${message}`));
  }
  return metadata;
}

function parseAllowedTools(rawValue, indentedLines, lineIndex, fail) {
  if (rawValue.trim() !== "") {
    if (indentedLines.length > 0) fail(indentedLines[0].lineIndex, "`allowed-tools` is either one line or a list, not both");
    return parseScalar(rawValue, (message) => fail(lineIndex, `\`allowed-tools\`: ${message}`)).split(/\s+/).filter(Boolean);
  }
  return indentedLines.map(({ text, lineIndex: itemLineIndex }) => {
    const itemMatch = LIST_ITEM_PATTERN.exec(text);
    if (!itemMatch) fail(itemLineIndex, `expected a list item \`  - provider/tool\` indented by two spaces (found ${JSON.stringify(text)})`);
    return parseScalar(itemMatch[1], (message) => fail(itemLineIndex, `\`allowed-tools\` item: ${message}`));
  });
}

/**
 * Reads one value: double-quoted (only `\"` and `\\` escapes), single-quoted (`''` for a quote) or plain.
 *
 * @param rawValue - The text after `key: ` (string)
 * @param fail - Called with a message for a value outside the subset; must throw (function)
 * @returns The value as text (string)
 */
function parseScalar(rawValue, fail) {
  const value = rawValue.trim();
  if (value === "") return fail("the value is empty");
  const doubleQuoted = DOUBLE_QUOTED_PATTERN.exec(value);
  if (doubleQuoted) return doubleQuoted[1].replace(/\\(["\\])/g, "$1");
  const singleQuoted = SINGLE_QUOTED_PATTERN.exec(value);
  if (singleQuoted) return singleQuoted[1].replaceAll("''", "'");
  if (PLAIN_SCALAR_FORBIDDEN_START_PATTERN.test(value)) {
    return fail(`a value starting with ${JSON.stringify(value[0])} must be a complete quoted string ("..." with only \\" and \\\\ escapes, or '...')`);
  }
  if (value.includes(": ") || value.endsWith(":") || value.includes(" #")) return fail("a value containing `: ` or ` #` must be quoted");
  if (NON_TEXT_SCALAR_PATTERNS.some((pattern) => pattern.test(value))) return fail(`\`${value}\` would be read as a number, boolean, null or date; quote it`);
  return value;
}
