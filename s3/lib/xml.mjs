/**
 * Minimal XML reader for S3 responses (ListBuckets, ListObjectsV2, CopyObject, Error).
 *
 * Supports elements, attributes, text, CDATA, comments, processing instructions and the five predefined plus
 * numeric character entities. DOCTYPE and entity declarations are refused outright, so entity expansion attacks
 * cannot happen. Namespace prefixes are dropped from element names (S3 uses a default namespace).
 */

const NAMED_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const TAG_PATTERN = /^<\/?([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/;
const ATTRIBUTE_PATTERN = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Parses an XML document into `{name, attributes, children, text}` elements.
 *
 * @param xmlText - The document (string)
 * @returns The root element (object)
 * @throws Error - On DOCTYPE/ENTITY declarations, unknown entities or malformed markup
 *
 * @example
 * childText(parseXml("<Error><Code>NoSuchKey</Code></Error>"), "Code"); // "NoSuchKey"
 */
export function parseXml(xmlText) {
  const text = String(xmlText);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("XML with a DOCTYPE or ENTITY declaration is refused");
  const stack = [{ name: "#document", attributes: {}, children: [], text: "" }];
  let position = 0;
  while (position < text.length) {
    position = readNext(text, position, stack);
  }
  if (stack.length > 1) throw new Error(`Malformed XML: unclosed element <${stack.at(-1).name}>`);
  const root = stack[0].children[0];
  if (!root) throw new Error("Malformed XML: no root element");
  return root;
}

function readNext(text, position, stack) {
  if (text[position] !== "<") return readText(text, position, stack);
  if (text.startsWith("<?", position)) return skipPast(text, position, "?>");
  if (text.startsWith("<!--", position)) return skipPast(text, position, "-->");
  if (text.startsWith("<![CDATA[", position)) {
    const end = indexOrFail(text, "]]>", position);
    stack.at(-1).text += text.slice(position + 9, end);
    return end + 3;
  }
  return readTag(text, position, stack);
}

function readText(text, position, stack) {
  const nextTag = text.indexOf("<", position);
  const end = nextTag === -1 ? text.length : nextTag;
  const rawText = text.slice(position, end);
  if (stack.length === 1 && rawText.trim() !== "") throw new Error("Malformed XML: no root element");
  stack.at(-1).text += decodeEntities(rawText);
  return end;
}

function readTag(text, position, stack) {
  const tagMatch = TAG_PATTERN.exec(text.slice(position, position + 4096));
  if (!tagMatch) throw new Error(`Malformed XML at offset ${position}`);
  const [tagText, qualifiedName, attributeText, selfClosing] = tagMatch;
  const name = qualifiedName.includes(":") ? qualifiedName.slice(qualifiedName.indexOf(":") + 1) : qualifiedName;
  if (tagText.startsWith("</")) {
    const openElement = stack.pop();
    if (!openElement || openElement.name !== name || stack.length === 0) throw new Error(`Malformed XML: mismatched closing tag </${qualifiedName}>`);
    return position + tagText.length;
  }
  const element = { name, attributes: readAttributes(attributeText), children: [], text: "" };
  stack.at(-1).children.push(element);
  if (!selfClosing) stack.push(element);
  return position + tagText.length;
}

function readAttributes(attributeText) {
  const attributes = {};
  for (const [, attributeName, doubleQuoted, singleQuoted] of attributeText.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[attributeName] = decodeEntities(doubleQuoted ?? singleQuoted ?? "");
  }
  return attributes;
}

function decodeEntities(rawText) {
  return rawText.replace(/&([^;\s&]*);?/g, (entityText, entityName) => {
    if (entityName.startsWith("#x")) return String.fromCodePoint(parseCodePoint(entityName.slice(2), 16, entityText));
    if (entityName.startsWith("#")) return String.fromCodePoint(parseCodePoint(entityName.slice(1), 10, entityText));
    if (!entityText.endsWith(";") || !(entityName in NAMED_ENTITIES)) throw new Error(`Malformed XML: unknown entity ${entityText}`);
    return NAMED_ENTITIES[entityName];
  });
}

function parseCodePoint(digits, radix, entityText) {
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) throw new Error(`Malformed XML: bad character reference ${entityText}`);
  return codePoint;
}

function skipPast(text, position, terminator) {
  return indexOrFail(text, terminator, position) + terminator.length;
}

function indexOrFail(text, terminator, position) {
  const end = text.indexOf(terminator, position);
  if (end === -1) throw new Error(`Malformed XML: missing ${terminator}`);
  return end;
}

/**
 * First child element with a name.
 *
 * @param element - Parsed element (object)
 * @param name - Child name (string)
 * @returns The child, or undefined (object | undefined)
 */
export function findChild(element, name) {
  return element?.children.find((child) => child.name === name);
}

/**
 * Every child element with a name.
 *
 * @param element - Parsed element (object)
 * @param name - Child name (string)
 * @returns Children in document order (object[])
 */
export function findChildren(element, name) {
  return element?.children.filter((child) => child.name === name) ?? [];
}

/**
 * Text of the first child element with a name.
 *
 * @param element - Parsed element (object)
 * @param name - Child name (string)
 * @returns The child's text, or undefined when there is no such child (string | undefined)
 */
export function childText(element, name) {
  return findChild(element, name)?.text;
}
