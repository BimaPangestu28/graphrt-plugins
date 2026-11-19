/**
 * A small, strict, non-validating XML parser for feeds.
 *
 * Safe by construction: there is no DTD processing at all. A DOCTYPE (with or
 * without an internal subset) is skipped unread, so declared entities are
 * never expanded (no "billion laughs") and external entities are never
 * resolved (no XXE): `&name;` stays literal text unless it is one of the five
 * predefined XML entities or a character reference. Nesting depth and the
 * number of elements are capped. Malformed markup (mismatched or unclosed
 * tags, unquoted attributes, stray markup declarations) is refused.
 *
 * The result is a tree of `{name, attributes, children}` where children are
 * elements or strings; names keep their prefix (`content:encoded`).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const PREDEFINED_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const ENTITY_PATTERN = /&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9._-]*);/g;
const NAME_PATTERN = /[^\s/>="'<]+/y;
const WHITESPACE_PATTERN = /\s*/y;
const DEFAULT_LIMITS = { maxDepth: 64, maxElements: 200000 };

/**
 * Parses an XML document into its root element.
 *
 * @param text - The document (string)
 * @param limits - `{maxDepth, maxElements}` (object, optional)
 * @returns Root element `{name, attributes, children}` (object)
 * @throws PluginError kind `api_error` - When the document is malformed or over a limit
 *
 * @example
 * parseXml("<a x='1'>hi</a>"); // { name: "a", attributes: { x: "1" }, children: ["hi"] }
 */
export function parseXml(text, limits = {}) {
  const state = { text, position: 0, stack: [{ name: "#document", attributes: {}, children: [] }], elementCount: 0, limits: { ...DEFAULT_LIMITS, ...limits } };
  while (state.position < text.length) parseNextToken(state);
  if (state.stack.length !== 1) throw malformed(`<${state.stack.at(-1).name}> is never closed`);
  const rootElements = state.stack[0].children.filter((child) => typeof child !== "string");
  if (rootElements.length !== 1) throw malformed(rootElements.length === 0 ? "there is no root element" : "there is more than one root element");
  return rootElements[0];
}

/**
 * Concatenates all text inside an element (descendants included).
 *
 * @param element - Parsed element, or undefined (object)
 * @returns The text, "" for a missing element (string)
 */
export function textContent(element) {
  if (!element) return "";
  return element.children.map((child) => (typeof child === "string" ? child : textContent(child))).join("");
}

function parseNextToken(state) {
  const { text, position } = state;
  const tagStart = text.indexOf("<", position);
  if (tagStart === -1) return appendText(state, text.slice(position), true, text.length);
  if (tagStart > position) return appendText(state, text.slice(position, tagStart), true, tagStart);
  if (text.startsWith("<!--", position)) return skipPast(state, "-->", "a comment");
  if (text.startsWith("<![CDATA[", position)) return parseCdata(state);
  if (text.startsWith("<?", position)) return skipPast(state, "?>", "a processing instruction");
  if (/^<!DOCTYPE/i.test(text.slice(position, position + 9))) return skipDoctype(state);
  if (text.startsWith("<!", position)) throw malformed("markup declarations (<!ENTITY, <!ELEMENT, ...) are only allowed inside a DOCTYPE");
  if (text.startsWith("</", position)) return parseEndTag(state);
  return parseStartTag(state);
}

function appendText(state, rawText, decode, nextPosition) {
  const parent = state.stack.at(-1);
  if (parent.name === "#document") {
    if (rawText.trim() !== "") throw malformed("text outside the root element");
  } else {
    parent.children.push(decode ? decodeEntities(rawText) : rawText);
  }
  state.position = nextPosition;
}

function skipPast(state, terminator, what) {
  const end = state.text.indexOf(terminator, state.position + 2);
  if (end === -1) throw malformed(`${what} is never closed`);
  state.position = end + terminator.length;
}

function parseCdata(state) {
  const start = state.position + "<![CDATA[".length;
  const end = state.text.indexOf("]]>", start);
  if (end === -1) throw malformed("a CDATA section is never closed");
  appendText(state, state.text.slice(start, end), false, end + 3);
}

// The DOCTYPE and its internal subset are skipped without being interpreted. One linear scan: quoted strings and
// comments are jumped over whole, so a "]>" or ">" inside them cannot end the DOCTYPE early.
function skipDoctype(state) {
  if (state.stack.length !== 1) throw malformed("a DOCTYPE inside an element");
  const { text } = state;
  let position = state.position + "<!DOCTYPE".length;
  let isInSubset = false;
  while (position < text.length) {
    const character = text[position];
    if (character === "\"" || character === "'") {
      const closingQuote = text.indexOf(character, position + 1);
      if (closingQuote === -1) break;
      position = closingQuote + 1;
    } else if (text.startsWith("<!--", position)) {
      const commentEnd = text.indexOf("-->", position + 4);
      if (commentEnd === -1) break;
      position = commentEnd + 3;
    } else if (character === "[" && !isInSubset) {
      isInSubset = true;
      position += 1;
    } else if (character === "]" && isInSubset) {
      isInSubset = false;
      position += 1;
    } else if (character === ">" && !isInSubset) {
      state.position = position + 1;
      return;
    } else {
      position += 1;
    }
  }
  throw malformed("the DOCTYPE is never closed");
}

function readName(state) {
  NAME_PATTERN.lastIndex = state.position;
  const match = NAME_PATTERN.exec(state.text);
  if (!match) throw malformed(`expected a name at offset ${state.position}`);
  state.position = NAME_PATTERN.lastIndex;
  return match[0];
}

function skipWhitespace(state) {
  WHITESPACE_PATTERN.lastIndex = state.position;
  WHITESPACE_PATTERN.exec(state.text);
  state.position = WHITESPACE_PATTERN.lastIndex;
}

function parseStartTag(state) {
  state.position += 1;
  const element = { name: readName(state), attributes: {}, children: [] };
  const isSelfClosing = parseAttributes(state, element.attributes);
  countElement(state);
  state.stack.at(-1).children.push(element);
  if (isSelfClosing) return;
  if (state.stack.length > state.limits.maxDepth) throw malformed(`elements are nested too deep (more than ${state.limits.maxDepth} levels)`);
  state.stack.push(element);
}

function parseAttributes(state, attributes) {
  for (;;) {
    skipWhitespace(state);
    if (state.text.startsWith("/>", state.position)) {
      state.position += 2;
      return true;
    }
    if (state.text[state.position] === ">") {
      state.position += 1;
      return false;
    }
    if (state.position >= state.text.length) throw malformed("a start tag is never closed");
    const attributeName = readName(state);
    attributes[attributeName] = readAttributeValue(state, attributeName);
  }
}

function readAttributeValue(state, attributeName) {
  skipWhitespace(state);
  if (state.text[state.position] !== "=") throw malformed(`attribute ${attributeName} has no value`);
  state.position += 1;
  skipWhitespace(state);
  const quote = state.text[state.position];
  if (quote !== "\"" && quote !== "'") throw malformed(`attribute ${attributeName} is not quoted`);
  const end = state.text.indexOf(quote, state.position + 1);
  if (end === -1) throw malformed(`attribute ${attributeName} is never closed`);
  const rawValue = state.text.slice(state.position + 1, end);
  if (rawValue.includes("<")) throw malformed(`attribute ${attributeName} contains <`);
  state.position = end + 1;
  return decodeEntities(rawValue);
}

function parseEndTag(state) {
  state.position += 2;
  const name = readName(state);
  skipWhitespace(state);
  if (state.text[state.position] !== ">") throw malformed(`the end tag </${name}> is malformed`);
  state.position += 1;
  const openElement = state.stack.at(-1);
  if (openElement.name !== name) throw malformed(`</${name}> does not match <${openElement.name}>`);
  state.stack.pop();
}

function countElement(state) {
  state.elementCount += 1;
  if (state.elementCount > state.limits.maxElements) throw malformed(`the document has more than ${state.limits.maxElements} elements`);
}

/**
 * Decodes the five predefined XML entities and character references; any other `&name;` stays as written.
 *
 * @param rawText - Text from the document (string)
 * @returns Decoded text (string)
 */
export function decodeEntities(rawText) {
  if (!rawText.includes("&")) return rawText;
  return rawText.replace(ENTITY_PATTERN, (whole, reference) => {
    if (reference[0] !== "#") return Object.hasOwn(PREDEFINED_ENTITIES, reference) ? PREDEFINED_ENTITIES[reference] : whole;
    const codePoint = reference[1] === "x" ? Number.parseInt(reference.slice(2), 16) : Number.parseInt(reference.slice(1), 10);
    return isXmlCharacter(codePoint) ? String.fromCodePoint(codePoint) : "�";
  });
}

function isXmlCharacter(codePoint) {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd || (codePoint >= 0x20 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= 0xfffd) || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function malformed(reason) {
  return new PluginError(`The response is not well-formed XML: ${reason}`, { kind: "api_error" });
}
