/**
 * Node-side validation of everything the in-page readers return (pure functions).
 *
 * The readers run in an isolated world with pristine built-ins and cap their
 * own output, but the page still controls the DOM they read. So every value is
 * checked again here, before any text is built from it: unexpected shapes are
 * dropped and strings, node counts, depth and attribute sizes are clipped to
 * the same caps. Nothing a page does can make later steps work on more.
 */

export const MAX_TAG_CHARS = 64;
const MAX_CLASS_ID_ROLE_CHARS = 200;
const MAX_URL_CHARS = 2048;
const MAX_ERROR_CHARS = 300;
const MAX_TITLE_CHARS = 500;
const MAX_PAGE_HEIGHT = 1000000;
const KEPT_ATTRIBUTES = { role: MAX_CLASS_ID_ROLE_CHARS, id: MAX_CLASS_ID_ROLE_CHARS, class: MAX_CLASS_ID_ROLE_CHARS, href: MAX_URL_CHARS };
const METADATA_LIMITS = { title: MAX_TITLE_CHARS, description: 2000, lang: 35, canonical_url: MAX_URL_CHARS, content_type: 200 };

/**
 * Re-applies the snapshot caps to a DOM snapshot.
 *
 * @param rawSnapshot - What snapshotDocumentInPage returned (unknown)
 * @param limits - `{maxNodes, maxTextChars, maxAttributeChars, maxDepth}` (object)
 * @returns `{root, metadata, truncated}` within the caps (object)
 *
 * @example
 * sanitizeSnapshot({ root: { tag: "body", attrs: {}, children: ["hi"] } }, SNAPSHOT_LIMITS).root.children; // ["hi"]
 */
export function sanitizeSnapshot(rawSnapshot, limits) {
  const snapshot = isPlainObject(rawSnapshot) ? rawSnapshot : {};
  const budget = { nodes: limits.maxNodes, textChars: limits.maxTextChars, attributeChars: limits.maxAttributeChars, truncated: snapshot.truncated === true };
  const root = isPlainObject(snapshot.root) ? sanitizeElement(snapshot.root, 0, limits, budget) : null;
  return { root, metadata: sanitizeMetadata(snapshot.metadata), truncated: budget.truncated };
}

function sanitizeNode(node, depth, limits, budget) {
  if (budget.nodes <= 0 || budget.textChars <= 0 || depth > limits.maxDepth) {
    budget.truncated = true;
    return null;
  }
  if (typeof node === "string") return sanitizeText(node, budget);
  return isPlainObject(node) ? sanitizeElement(node, depth, limits, budget) : null;
}

function sanitizeText(text, budget) {
  budget.nodes -= 1;
  if (text.length > budget.textChars) budget.truncated = true;
  const keptText = text.slice(0, budget.textChars);
  budget.textChars -= keptText.length;
  return keptText || null;
}

function sanitizeElement(element, depth, limits, budget) {
  if (typeof element.tag !== "string" || !element.tag) return null;
  budget.nodes -= 1;
  const children = [];
  const rawChildren = Array.isArray(element.children) ? element.children : [];
  for (let childIndex = 0; childIndex < rawChildren.length; childIndex += 1) {
    const child = sanitizeNode(rawChildren[childIndex], depth + 1, limits, budget);
    if (child !== null) children.push(child);
    if (budget.nodes <= 0) break;
  }
  return { tag: element.tag.slice(0, MAX_TAG_CHARS).toLowerCase(), attrs: sanitizeAttributes(element.attrs, budget), children };
}

function sanitizeAttributes(rawAttributes, budget) {
  const attrs = {};
  if (!isPlainObject(rawAttributes)) return attrs;
  for (const [attributeName, maxChars] of Object.entries(KEPT_ATTRIBUTES)) {
    const value = rawAttributes[attributeName];
    if (typeof value !== "string" || !value) continue;
    const keptValue = value.slice(0, Math.min(maxChars, budget.attributeChars));
    if (keptValue.length < value.length) budget.truncated = true;
    budget.attributeChars -= keptValue.length;
    if (keptValue) attrs[attributeName] = keptValue;
  }
  return attrs;
}

function sanitizeMetadata(rawMetadata) {
  const metadata = isPlainObject(rawMetadata) ? rawMetadata : {};
  const sanitized = {};
  for (const [fieldName, maxChars] of Object.entries(METADATA_LIMITS)) {
    const value = metadata[fieldName];
    sanitized[fieldName] = typeof value === "string" && value ? value.slice(0, maxChars) : null;
  }
  sanitized.title ??= "";
  return sanitized;
}

/**
 * Re-applies the extract caps: only the requested fields, at most `maxMatches`
 * (or 1) string values of at most `maxValueChars` each, and a sane match count.
 *
 * @param rawResults - What extractFieldsInPage returned (unknown)
 * @param fieldSpecs - Validated specs `[{name, all}]` (object[])
 * @param limits - `{maxMatches, maxValueChars}` (object)
 * @returns `{[name]: {values, matchCount} | {error}}` (object)
 */
export function sanitizeFieldResults(rawResults, fieldSpecs, limits) {
  const results = isPlainObject(rawResults) ? rawResults : {};
  const sanitized = {};
  for (const fieldSpec of fieldSpecs) {
    const fieldResult = isPlainObject(results[fieldSpec.name]) ? results[fieldSpec.name] : {};
    if (typeof fieldResult.error === "string") {
      sanitized[fieldSpec.name] = { error: fieldResult.error.slice(0, MAX_ERROR_CHARS) };
      continue;
    }
    const rawValues = Array.isArray(fieldResult.values) ? fieldResult.values : [];
    const values = rawValues.slice(0, fieldSpec.all ? limits.maxMatches : 1).filter((value) => typeof value === "string").map((value) => value.slice(0, limits.maxValueChars));
    const matchCount = Number.isSafeInteger(fieldResult.matchCount) && fieldResult.matchCount >= 0 ? fieldResult.matchCount : 0;
    sanitized[fieldSpec.name] = { values, matchCount };
  }
  return sanitized;
}

/**
 * Accepts a page height only when it is a finite, non-negative number (capped).
 *
 * @param rawHeight - What measurePageHeightInPage returned (unknown)
 * @returns Height in CSS pixels, 0 when unusable (number)
 */
export function sanitizePageHeight(rawHeight) {
  if (typeof rawHeight !== "number" || !Number.isFinite(rawHeight) || rawHeight < 0) return 0;
  return Math.min(rawHeight, MAX_PAGE_HEIGHT);
}

/**
 * Accepts a document title only when it is a string (capped).
 *
 * @param rawTitle - What readTitleInPage returned (unknown)
 * @returns Title, "" when unusable (string)
 */
export function sanitizeTitle(rawTitle) {
  return typeof rawTitle === "string" ? rawTitle.slice(0, MAX_TITLE_CHARS) : "";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
