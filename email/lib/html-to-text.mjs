/**
 * Converts an HTML mail body to plain text without ever interpreting it:
 * no DOM, no scripts, no remote resources, just bounded string scanning.
 *
 * Script, style, head and similar blocks are dropped with their content,
 * block elements become line breaks, links keep their http(s)/mailto target,
 * tags are stripped and entities decoded. Input is capped first, and every
 * step is linear in the input size (no backtracking-prone regexes on
 * unbounded spans).
 */

/** Longest HTML input looked at; the rest is ignored. */
export const MAX_HTML_INPUT_CHARS = 2 * 1024 * 1024;

const DROPPED_ELEMENTS = ["script", "style", "head", "noscript", "template", "svg", "math", "iframe", "object"];
const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "ul", "ol", "blockquote", "section", "article", "header", "footer", "pre", "hr", "address", "center"]);
const NAMED_ENTITIES = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "], ["copy", "©"], ["reg", "®"],
  ["trade", "™"], ["hellip", "…"], ["mdash", "—"], ["ndash", "–"], ["lsquo", "‘"], ["rsquo", "’"], ["ldquo", "“"],
  ["rdquo", "”"], ["bull", "•"], ["middot", "·"], ["euro", "€"], ["pound", "£"], ["yen", "¥"], ["cent", "¢"],
  ["deg", "°"], ["times", "×"], ["divide", "÷"], ["laquo", "«"], ["raquo", "»"], ["zwnj", ""], ["zwj", ""], ["shy", ""],
]);

/**
 * Converts HTML to readable plain text.
 *
 * @param html - HTML source (string)
 * @returns Plain text with collapsed whitespace (string)
 *
 * @example
 * convertHtmlToText('<p>Hi <b>Budi</b></p><script>alert(1)</script><a href="https://x.id">link</a>');
 * // "Hi Budi\nlink (https://x.id)"
 */
export function convertHtmlToText(html) {
  let text = removeComments(String(html ?? "").slice(0, MAX_HTML_INPUT_CHARS));
  for (const elementName of DROPPED_ELEMENTS) text = removeElementBlocks(text, elementName);
  const output = [];
  let openLink = null;
  for (const token of tokenizeHtml(text)) {
    if (token.text !== undefined) {
      output.push(token.text);
      if (openLink) openLink.text += token.text;
      continue;
    }
    const { tagName, isClosing } = readTagName(token.tag);
    if (tagName === "a") {
      if (isClosing && openLink) output.push(formatLinkTarget(openLink));
      openLink = isClosing ? null : { href: readAttribute(token.tag, "href"), text: "" };
      continue;
    }
    output.push(renderTag(tagName, isClosing, token.tag));
  }
  return collapseWhitespace(decodeEntities(output.join("")));
}

// Single pass: every character is looked at once; an unclosed "<" ends the text.
function* tokenizeHtml(text) {
  let position = 0;
  while (position < text.length) {
    const tagStart = text.indexOf("<", position);
    if (tagStart === -1) {
      yield { text: text.slice(position) };
      return;
    }
    if (tagStart > position) yield { text: text.slice(position, tagStart) };
    const tagEnd = text.indexOf(">", tagStart + 1);
    if (tagEnd === -1) return;
    yield { tag: text.slice(tagStart + 1, tagEnd) };
    position = tagEnd + 1;
  }
}

function readTagName(tagSource) {
  const match = /^\s*(\/?)\s*([a-z][a-z0-9]{0,15})/i.exec(tagSource.slice(0, 40));
  return match ? { tagName: match[2].toLowerCase(), isClosing: match[1] === "/" } : { tagName: "", isClosing: false };
}

function renderTag(tagName, isClosing, tagSource) {
  if (tagName === "br" || BLOCK_TAGS.has(tagName)) return "\n";
  if (tagName === "li" && !isClosing) return "\n- ";
  if ((tagName === "td" || tagName === "th") && isClosing) return "\t";
  if (tagName === "img") {
    const altText = readAttribute(tagSource, "alt");
    return altText ? `[${altText}]` : "";
  }
  return "";
}

function formatLinkTarget({ href, text }) {
  if (!href || !/^(https?:|mailto:)/i.test(href)) return "";
  const decodedHref = decodeEntities(href);
  return decodeEntities(text).trim() === decodedHref ? "" : ` (${decodedHref})`;
}

/**
 * Collapses runs of spaces and blank lines.
 *
 * @param text - Any text (string)
 * @returns Trimmed text with at most one blank line in a row (string)
 */
export function collapseWhitespace(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeComments(text) {
  let result = "";
  let position = 0;
  while (position < text.length) {
    const commentStart = text.indexOf("<!--", position);
    if (commentStart === -1) return result + text.slice(position);
    result += text.slice(position, commentStart);
    const commentEnd = text.indexOf("-->", commentStart + 4);
    if (commentEnd === -1) return result;
    position = commentEnd + 3;
  }
  return result;
}

// Drops <name ...>...</name> blocks with indexOf scanning; an unclosed block drops the rest.
function removeElementBlocks(text, elementName) {
  // ASCII-only lowercasing keeps every index aligned with `text` (full Unicode lowercasing can change the length).
  const lowerText = text.replace(/[A-Z]+/g, (upperRun) => upperRun.toLowerCase());
  const openTag = `<${elementName}`;
  const closeTag = `</${elementName}`;
  let result = "";
  let position = 0;
  while (position < text.length) {
    const blockStart = findTagStart(lowerText, openTag, position);
    if (blockStart === -1) return result + text.slice(position);
    result += `${text.slice(position, blockStart)} `;
    const closeStart = lowerText.indexOf(closeTag, blockStart + openTag.length);
    if (closeStart === -1) return result;
    const closeEnd = lowerText.indexOf(">", closeStart);
    if (closeEnd === -1) return result;
    position = closeEnd + 1;
  }
  return result;
}

// Finds "<name" followed by whitespace, ">" or "/" so "<header" does not match "<head".
function findTagStart(lowerText, openTag, fromPosition) {
  let candidate = lowerText.indexOf(openTag, fromPosition);
  while (candidate !== -1) {
    const nextCharacter = lowerText[candidate + openTag.length] ?? ">";
    if (/[\s>/]/.test(nextCharacter)) return candidate;
    candidate = lowerText.indexOf(openTag, candidate + 1);
  }
  return -1;
}

function readAttribute(attributes, attributeName) {
  const match = new RegExp(`\\b${attributeName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes);
  return match ? (match[2] ?? match[3] ?? match[4] ?? "").trim() : "";
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, body) => {
    if (body[0] === "#") return decodeCodePoint(body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10), entity);
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? entity;
  });
}

function decodeCodePoint(codePoint, fallback) {
  const isUsable = Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
  return isUsable ? String.fromCodePoint(codePoint) : fallback;
}
