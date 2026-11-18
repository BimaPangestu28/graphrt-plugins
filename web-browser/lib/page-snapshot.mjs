/**
 * Fixed functions that run INSIDE the page, in an isolated world with pristine
 * built-ins (see page-reader.mjs). They are part of this plugin, never supplied
 * by callers: tools cannot run their own JavaScript. Each one must be
 * self-contained (no imports, no closures over module variables) because its
 * source is serialised. Node re-checks every result (snapshot-limits.mjs).
 *
 * - `snapshotDocumentInPage` turns the visible DOM into a compact JSON tree
 *   (the "DOM snapshot") that the pure functions in readable.mjs work on.
 * - `extractFieldsInPage` reads text or attributes for CSS selectors.
 * - `measurePageHeightInPage` reports the scroll height for screenshots.
 * - `readTitleInPage` reads the document title.
 */

/**
 * Serialises `document.body` into `{tag, attrs, children}` / text nodes, skipping
 * scripts, styles, media, form controls and hidden elements, within node, text,
 * attribute and depth caps (tag names are cut at 64 characters).
 *
 * @param limits - `{maxNodes, maxTextChars, maxAttributeChars, maxDepth}` (object)
 * @returns `{root, metadata: {title, description, lang, canonical_url, content_type}, truncated}` (object)
 */
export function snapshotDocumentInPage(limits) {
  const skippedTags = new Set([
    "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "frame", "frameset", "object", "embed",
    "head", "link", "meta", "img", "picture", "audio", "video", "source", "track", "map", "datalist", "select", "option",
    "input", "textarea",
  ]);
  const keptAttributes = ["role", "id", "class"];
  const budget = { nodes: limits.maxNodes, textChars: limits.maxTextChars, attributeChars: limits.maxAttributeChars, truncated: false };
  const keepAttribute = (attrs, attributeName, value, maxChars) => {
    const keptValue = value.slice(0, Math.min(maxChars, budget.attributeChars));
    if (keptValue.length < value.length) budget.truncated = true;
    budget.attributeChars -= keptValue.length;
    if (keptValue) attrs[attributeName] = keptValue;
  };
  const isHidden = (element) => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return true;
    const style = window.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  };
  const serializeText = (textNode) => {
    const text = textNode.nodeValue ?? "";
    if (!text) return null;
    if (text.length > budget.textChars) budget.truncated = true;
    const keptText = text.slice(0, Math.max(0, budget.textChars));
    budget.textChars -= keptText.length;
    return keptText || null;
  };
  const serializeElement = (element, depth) => {
    const tag = String(element.localName).slice(0, 64);
    if (skippedTags.has(tag) || depth > limits.maxDepth || isHidden(element)) return null;
    const attrs = {};
    for (const attributeName of keptAttributes) {
      const value = element.getAttribute(attributeName);
      if (value) keepAttribute(attrs, attributeName, value, 200);
    }
    if (tag === "a" && typeof element.href === "string" && element.href) keepAttribute(attrs, "href", element.href, 2048);
    const children = [];
    for (const childNode of element.childNodes) {
      const serializedChild = serializeNode(childNode, depth + 1);
      if (serializedChild !== null) children.push(serializedChild);
    }
    return { tag, attrs, children };
  };
  const serializeNode = (node, depth) => {
    if (budget.nodes <= 0 || budget.textChars <= 0) {
      budget.truncated = true;
      return null;
    }
    budget.nodes -= 1;
    if (node.nodeType === 3) return serializeText(node);
    return node.nodeType === 1 ? serializeElement(node, depth) : null;
  };
  const readMeta = (selector) => document.querySelector(selector)?.getAttribute("content")?.trim() || null;
  const canonicalLink = document.querySelector('link[rel="canonical"]');
  return {
    root: document.body ? serializeNode(document.body, 0) : null,
    metadata: {
      title: (document.title || readMeta('meta[property="og:title"]') || "").trim().slice(0, 500),
      description: (readMeta('meta[name="description"]') || readMeta('meta[property="og:description"]') || "").slice(0, 2000) || null,
      lang: document.documentElement?.lang?.slice(0, 35) || null,
      canonical_url: canonicalLink && typeof canonicalLink.href === "string" ? canonicalLink.href.slice(0, 2048) : null,
      content_type: document.contentType || null,
    },
    truncated: budget.truncated,
  };
}

/**
 * Reads values for validated field specs. A malformed selector yields `{error}` for that field only.
 *
 * @param request - `{fieldSpecs: [{name, selector, attribute, all}], limits: {maxMatches, maxValueChars}}` (object)
 * @returns `{[name]: {values: string[], matchCount} | {error}}` (object)
 */
export function extractFieldsInPage({ fieldSpecs, limits }) {
  const readValue = (element, attribute) => {
    if (!attribute) return (element.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
    // href/src as properties are absolute URLs; other attributes are returned as written.
    const propertyValue = attribute === "href" || attribute === "src" ? element[attribute] : null;
    const value = typeof propertyValue === "string" && propertyValue ? propertyValue : element.getAttribute(attribute);
    return value === null || value === undefined ? null : String(value).trim();
  };
  const results = {};
  for (const fieldSpec of fieldSpecs) {
    let matches;
    try {
      matches = document.querySelectorAll(fieldSpec.selector);
    } catch (selectorError) {
      results[fieldSpec.name] = { error: `invalid CSS selector: ${String(selectorError?.message ?? selectorError).slice(0, 200)}` };
      continue;
    }
    const wantedCount = fieldSpec.all ? limits.maxMatches : 1;
    const values = [];
    for (const element of Array.from(matches).slice(0, wantedCount)) {
      const value = readValue(element, fieldSpec.attribute);
      if (value !== null) values.push(value.slice(0, limits.maxValueChars));
    }
    results[fieldSpec.name] = { values, matchCount: matches.length };
  }
  return results;
}

/**
 * Returns the page's full scroll height in CSS pixels.
 *
 * @returns Height (number)
 */
export function measurePageHeightInPage() {
  return Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0);
}

/**
 * Returns the document title, cut at 500 characters.
 *
 * @returns Title (string)
 */
export function readTitleInPage() {
  return String(document.title ?? "").slice(0, 500);
}
