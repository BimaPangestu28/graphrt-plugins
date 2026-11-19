/**
 * Normalises RSS 2.0 (and 0.9x), RSS 1.0 (RDF), Atom 1.0 and JSON Feed 1.x
 * into one shape:
 *   feed: {format, title, link, description, language, updated}
 *   item: {id, title, link, published, updated, author, categories, summary, enclosures, content?}
 * Dates are ISO 8601 when they parse (the raw text otherwise); `summary` is
 * plain text of at most 1000 characters; `content` is only added on request.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { htmlToPlainText, truncateText } from "./html-text.mjs";
import { parseXml, textContent } from "./xml-parser.mjs";

const SUMMARY_MAX_CHARACTERS = 1000;

/**
 * Parses and normalises a feed document.
 *
 * @param text - The feed (XML or JSON text) (string)
 * @param options - `{includeContent, contentFormat: "text"|"html", maxContentChars}` (object)
 * @returns `{feed, items}` (object)
 * @throws PluginError kind `api_error` - When the document is not a supported feed
 */
export function normalizeFeed(text, options) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return normalizeJsonFeed(parseJson(trimmed), options);
  const root = parseXml(trimmed);
  const rootName = localName(root.name);
  if (root.name === "rss") return normalizeRss(root, "rss", options);
  if (root.name === "rdf:RDF" || rootName === "RDF") return normalizeRss(root, "rdf", options);
  if (rootName === "feed") return normalizeAtom(root, options);
  throw notAFeed(`the root element is <${root.name}>`);
}

function notAFeed(reason) {
  return new PluginError(`The response is not an RSS, Atom or JSON feed: ${reason}`, { kind: "api_error" });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (parseError) {
    throw notAFeed(`invalid JSON (${parseError.message})`);
  }
}

function localName(qualifiedName) {
  return qualifiedName.slice(qualifiedName.indexOf(":") + 1);
}

function childElements(element, name, { byLocalName = false } = {}) {
  return (element?.children ?? []).filter((child) => typeof child !== "string" && (byLocalName ? localName(child.name) === name : child.name === name));
}

function childText(element, name, options) {
  return textContent(childElements(element, name, options)[0]).trim();
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
const RFC822_DATE_PATTERN = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2}|\d{4})\s+\d{2}:\d{2}(?::\d{2})?\s*(?:[A-Za-z]{1,5}|[+-]\d{4})?$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isRealCalendarDay(year, monthIndex, day) {
  return monthIndex >= 0 && monthIndex < 12 && day >= 1 && new Date(Date.UTC(year, monthIndex, day)).getUTCDate() === day;
}

// Only the two formats feeds use (RFC 822 for RSS, ISO 8601 / RFC 3339 for Atom and JSON Feed), with real calendar days.
function isStrictFeedDate(text) {
  const iso = ISO_DATE_PATTERN.exec(text);
  if (iso) return isRealCalendarDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const rfc822 = RFC822_DATE_PATTERN.exec(text);
  if (!rfc822) return false;
  const year = rfc822[3].length === 2 ? 2000 + Number(rfc822[3]) : Number(rfc822[3]);
  return isRealCalendarDay(year, MONTHS.indexOf(rfc822[2].toLowerCase()), Number(rfc822[1]));
}

/**
 * ISO 8601 for an RFC 822 or ISO 8601 date, the trimmed raw text for anything else, null when empty.
 *
 * @param rawDate - Date text from the feed (string)
 * @returns Date string or null (string | null)
 */
export function toIsoDate(rawDate) {
  const trimmed = typeof rawDate === "string" ? rawDate.trim() : "";
  if (!trimmed) return null;
  const milliseconds = isStrictFeedDate(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : trimmed;
}

/**
 * Keeps only http(s) URLs, so a feed cannot hand a workflow a javascript:, data: or file: link.
 *
 * @param value - URL text from the feed (unknown)
 * @returns The trimmed URL, or null (string | null)
 */
export function httpUrlOrNull(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === "http:" || protocol === "https:" ? value.trim() : null;
  } catch {
    return null;
  }
}

function buildEnclosures(candidates) {
  return candidates.map((candidate) => ({ ...candidate, url: httpUrlOrNull(candidate.url) })).filter((enclosure) => enclosure.url);
}

function buildSummary(summaryHtml, fallbackHtml) {
  const plainText = htmlToPlainText(summaryHtml || fallbackHtml || "");
  return plainText ? truncateText(plainText, SUMMARY_MAX_CHARACTERS).text : null;
}

function buildContent(item, { html, plainText }, options) {
  if (!options.includeContent) return item;
  const rendered = options.contentFormat === "html" ? html ?? plainText ?? "" : plainText ?? htmlToPlainText(html ?? "");
  const { text, truncated } = truncateText(rendered, options.maxContentChars);
  return { ...item, content: text, ...(truncated ? { content_truncated: true } : {}) };
}

function toLength(rawLength) {
  const length = Number(rawLength);
  return rawLength !== undefined && rawLength !== "" && Number.isFinite(length) ? length : null;
}

function normalizeRss(root, format, options) {
  const channel = childElements(root, "channel")[0];
  if (!channel) throw notAFeed("there is no <channel>");
  const itemParent = format === "rdf" ? root : channel;
  return {
    feed: {
      format,
      title: childText(channel, "title") || null,
      link: httpUrlOrNull(childText(channel, "link")),
      description: childText(channel, "description") || null,
      language: childText(channel, "language") || childText(channel, "dc:language") || null,
      updated: toIsoDate(childText(channel, "lastBuildDate") || childText(channel, "pubDate") || childText(channel, "dc:date")),
    },
    items: childElements(itemParent, "item").map((item) => normalizeRssItem(item, options)),
  };
}

function normalizeRssItem(item, options) {
  const guidElement = childElements(item, "guid")[0];
  const guid = textContent(guidElement).trim();
  const isPermalink = guidElement?.attributes.isPermaLink !== "false" && /^https?:\/\//.test(guid);
  const link = httpUrlOrNull(childText(item, "link")) ?? (isPermalink ? httpUrlOrNull(guid) : null) ?? httpUrlOrNull(item.attributes["rdf:about"]);
  const descriptionHtml = textContent(childElements(item, "description")[0]);
  const encodedHtml = textContent(childElements(item, "content:encoded")[0]);
  const normalized = {
    id: guid || link || childText(item, "title") || null,
    title: childText(item, "title") || null,
    link,
    published: toIsoDate(childText(item, "pubDate") || childText(item, "dc:date")),
    updated: toIsoDate(childText(item, "atom:updated")),
    author: childText(item, "author") || childText(item, "dc:creator") || null,
    categories: [...childElements(item, "category"), ...childElements(item, "dc:subject")].map((category) => textContent(category).trim()).filter(Boolean),
    summary: buildSummary(descriptionHtml, encodedHtml),
    enclosures: buildEnclosures(childElements(item, "enclosure").map((enclosure) => ({ url: enclosure.attributes.url, type: enclosure.attributes.type ?? null, length: toLength(enclosure.attributes.length) }))),
  };
  return buildContent(normalized, { html: encodedHtml || descriptionHtml }, options);
}

const ATOM = { byLocalName: true };

// Atom text constructs: type="html" holds escaped HTML, type="xhtml" holds elements, anything else is plain text.
function readAtomText(element) {
  if (!element) return { html: null, plainText: null };
  const type = element.attributes.type ?? "text";
  if (type === "html") return { html: textContent(element), plainText: htmlToPlainText(textContent(element)) };
  if (type === "xhtml") return { html: element.children.map(serializeNode).join(""), plainText: htmlToPlainText(element.children.map(serializeNode).join("")) };
  return { html: null, plainText: textContent(element).trim() };
}

function serializeNode(node) {
  if (typeof node === "string") return node.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const attributes = Object.entries(node.attributes).map(([name, value]) => ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join("");
  const name = localName(node.name);
  return `<${name}${attributes}>${node.children.map(serializeNode).join("")}</${name}>`;
}

function pickAtomLink(element, relation) {
  const links = childElements(element, "link", ATOM);
  const matching = links.find((link) => (link.attributes.rel ?? "alternate") === relation);
  return httpUrlOrNull(matching?.attributes.href);
}

function normalizeAtom(root, options) {
  return {
    feed: {
      format: "atom",
      title: readAtomText(childElements(root, "title", ATOM)[0]).plainText || null,
      link: pickAtomLink(root, "alternate"),
      description: readAtomText(childElements(root, "subtitle", ATOM)[0]).plainText || null,
      language: root.attributes["xml:lang"] ?? null,
      updated: toIsoDate(childText(root, "updated", ATOM)),
    },
    items: childElements(root, "entry", ATOM).map((entry) => normalizeAtomEntry(entry, options)),
  };
}

function normalizeAtomEntry(entry, options) {
  const summary = readAtomText(childElements(entry, "summary", ATOM)[0]);
  const content = readAtomText(childElements(entry, "content", ATOM)[0]);
  const link = pickAtomLink(entry, "alternate");
  const normalized = {
    id: childText(entry, "id", ATOM) || link,
    title: readAtomText(childElements(entry, "title", ATOM)[0]).plainText || null,
    link,
    published: toIsoDate(childText(entry, "published", ATOM)),
    updated: toIsoDate(childText(entry, "updated", ATOM)),
    author: childText(childElements(entry, "author", ATOM)[0], "name", ATOM) || null,
    categories: childElements(entry, "category", ATOM).map((category) => category.attributes.term ?? category.attributes.label).filter(Boolean),
    summary: buildSummary(summary.html ?? summary.plainText, content.html ?? content.plainText),
    enclosures: buildEnclosures(childElements(entry, "link", ATOM).filter((linkElement) => linkElement.attributes.rel === "enclosure").map((linkElement) => ({ url: linkElement.attributes.href, type: linkElement.attributes.type ?? null, length: toLength(linkElement.attributes.length) }))),
  };
  return buildContent(normalized, content.html || content.plainText ? content : summary, options);
}

function normalizeJsonFeed(document, options) {
  if (typeof document !== "object" || document === null || !String(document.version ?? "").startsWith("https://jsonfeed.org/version/")) {
    throw notAFeed("JSON without a JSON Feed version (https://jsonfeed.org/version/...)");
  }
  return {
    feed: { format: "json", title: stringOrNull(document.title), link: httpUrlOrNull(document.home_page_url), description: stringOrNull(document.description), language: stringOrNull(document.language), updated: null },
    items: readJsonItems(document.items).map((item) => normalizeJsonItem(item, options)),
  };
}

// JSON Feed `items` is required to be an array; entries that are not objects are skipped.
function readJsonItems(items) {
  if (items === undefined) return [];
  if (!Array.isArray(items)) throw notAFeed("JSON Feed `items` is not an array");
  return items.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item));
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeJsonItem(item, options) {
  const html = stringOrNull(item.content_html);
  const plainText = stringOrNull(item.content_text);
  const normalized = {
    id: typeof item.id === "string" || (typeof item.id === "number" && Number.isFinite(item.id)) ? String(item.id) : httpUrlOrNull(item.url),
    title: stringOrNull(item.title),
    link: httpUrlOrNull(item.url) ?? httpUrlOrNull(item.external_url),
    published: toIsoDate(item.date_published),
    updated: toIsoDate(item.date_modified),
    author: stringOrNull(item.authors?.[0]?.name) ?? stringOrNull(item.author?.name),
    categories: (Array.isArray(item.tags) ? item.tags : []).filter((tag) => typeof tag === "string"),
    summary: stringOrNull(item.summary) ? truncateText(item.summary.trim(), SUMMARY_MAX_CHARACTERS).text : buildSummary(html ?? plainText),
    enclosures: buildEnclosures((Array.isArray(item.attachments) ? item.attachments : []).map((attachment) => ({ url: attachment?.url, type: stringOrNull(attachment?.mime_type), length: toLength(attachment?.size_in_bytes) }))),
  };
  return buildContent(normalized, { html, plainText: plainText ?? (html ? htmlToPlainText(html) : null) }, options);
}
