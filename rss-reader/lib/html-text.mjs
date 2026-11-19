/**
 * Readable plain text from the HTML in feed summaries and content.
 *
 * This is for reading, not sanitising: scripts, styles and tags are dropped,
 * block ends become line breaks, common HTML entities are decoded and
 * whitespace is collapsed. Callers that render `content_format: "html"` must
 * sanitise it themselves.
 */

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·",
};
const ENTITY_PATTERN = /&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,12});/g;

const TAG_PATTERN = /<(\/?)([A-Za-z][A-Za-z0-9-]*)[^<>]*>/y;
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "noscript"]);
const BLOCK_ELEMENTS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr", "section", "article"]);

/**
 * Converts an HTML fragment to plain text in one left-to-right pass (linear time, even for unclosed tags,
 * scripts or comments, which simply run to the end of the text).
 *
 * @param html - HTML fragment (string)
 * @returns Plain text with paragraphs separated by newlines (string)
 *
 * @example
 * htmlToPlainText("<p>Hi &amp; <b>bye</b></p><script>x()</script>"); // "Hi & bye"
 */
export function htmlToPlainText(html) {
  const source = String(html ?? "");
  const pieces = [];
  let position = 0;
  while (position < source.length) {
    const tagStart = source.indexOf("<", position);
    if (tagStart === -1) {
      pieces.push(source.slice(position));
      break;
    }
    pieces.push(source.slice(position, tagStart));
    position = skipMarkup(source, tagStart, pieces);
  }
  return collapseWhitespace(decodeHtmlEntities(pieces.join("")));
}

// Returns the position after the markup at `tagStart`, pushing the whitespace it stands for.
function skipMarkup(source, tagStart, pieces) {
  if (source.startsWith("<!--", tagStart)) {
    const commentEnd = source.indexOf("-->", tagStart + 4);
    pieces.push(" ");
    return commentEnd === -1 ? source.length : commentEnd + 3;
  }
  TAG_PATTERN.lastIndex = tagStart;
  const match = TAG_PATTERN.exec(source);
  if (!match) {
    pieces.push("<");
    return tagStart + 1;
  }
  const [whole, closingSlash, rawName] = match;
  const name = rawName.toLowerCase();
  const afterTag = tagStart + whole.length;
  if (!closingSlash && RAW_TEXT_ELEMENTS.has(name)) {
    pieces.push(" ");
    return skipRawText(source, name, afterTag);
  }
  pieces.push(name === "br" || (closingSlash && BLOCK_ELEMENTS.has(name)) ? "\n" : " ");
  return afterTag;
}

function skipRawText(source, name, from) {
  const closingPattern = new RegExp(`</${name}`, "gi");
  closingPattern.lastIndex = from;
  const closing = closingPattern.exec(source);
  if (!closing) return source.length;
  const closeEnd = source.indexOf(">", closing.index);
  return closeEnd === -1 ? source.length : closeEnd + 1;
}

function decodeHtmlEntities(text) {
  return text.replace(ENTITY_PATTERN, (whole, reference) => {
    if (reference[0] !== "#") {
      const lowerName = reference.toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, lowerName) ? NAMED_ENTITIES[lowerName] : whole;
    }
    const codePoint = reference[1] === "x" || reference[1] === "X" ? Number.parseInt(reference.slice(2), 16) : Number.parseInt(reference.slice(1), 10);
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : "\uFFFD";
  });
}

function collapseWhitespace(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/ +([.,;:!?])/g, "$1");
}

/**
 * Shortens text to `maxCharacters`, ending with "…" when it was cut.
 *
 * @param text - Text (string)
 * @param maxCharacters - Limit (number)
 * @returns `{text, truncated}` (object)
 */
export function truncateText(text, maxCharacters) {
  const characters = [...text];
  if (characters.length <= maxCharacters) return { text, truncated: false };
  return { text: `${characters.slice(0, maxCharacters).join("").trimEnd()}…`, truncated: true };
}
