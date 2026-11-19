/**
 * Minimal readers for BMKG's nowcast weather warnings: the RSS 2.0 list of active warnings and one warning's CAP 1.2
 * document (https://data.bmkg.go.id/peringatan-dini-cuaca/). Both are small, flat and machine-generated, so a tag
 * extractor is enough; no XML library (the plugin has no dependencies). Unknown tags are ignored.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const CDATA_PATTERN = /^<!\[CDATA\[([\s\S]*)\]\]>$/;
const ALERT_CODE_PATTERN = /\/([A-Za-z0-9]+)_alert\.xml$/;

/**
 * Decodes the text content of one XML element: CDATA is taken verbatim, otherwise entities are decoded.
 *
 * @param rawText - Element content as it appears in the document (string)
 * @returns Decoded, trimmed text (string)
 *
 * @example
 * decodeXmlText("Hujan &amp; petir"); // "Hujan & petir"
 */
export function decodeXmlText(rawText) {
  const trimmed = String(rawText).trim();
  const cdata = CDATA_PATTERN.exec(trimmed);
  if (cdata) return cdata[1].trim();
  return trimmed.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, reference) => {
    if (reference[0] !== "#") return NAMED_ENTITIES[reference.toLowerCase()] ?? entity;
    const codePoint = reference[1].toLowerCase() === "x" ? Number.parseInt(reference.slice(2), 16) : Number(reference.slice(1));
    return Number.isInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

function readAllElements(xmlText, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "g");
  return [...xmlText.matchAll(pattern)].map((match) => match[1]);
}

function readElement(xmlText, tagName) {
  const [content] = readAllElements(xmlText, tagName);
  return content === undefined ? null : decodeXmlText(content);
}

/**
 * Parses BMKG's nowcast RSS feed (active provincial warnings).
 *
 * @param xmlText - The feed body (string)
 * @returns `{updated_at, warnings: [{alert_code, title, description, author, published_at, link}]}` (object)
 * @throws PluginError kind `api_error` - The body is not an RSS feed (e.g. an HTML error or challenge page)
 */
export function parseNowcastFeed(xmlText) {
  const text = String(xmlText ?? "");
  if (!/<rss[\s>]/.test(text)) throw new PluginError("BMKG nowcast: the response is not an RSS feed", { kind: "api_error" });
  const warnings = readAllElements(text, "item").map((itemXml) => {
    const link = readElement(itemXml, "link");
    return {
      alert_code: ALERT_CODE_PATTERN.exec(link ?? "")?.[1] ?? null,
      title: readElement(itemXml, "title"),
      description: readElement(itemXml, "description"),
      author: readElement(itemXml, "author"),
      published_at: readElement(itemXml, "pubDate"),
      link,
    };
  });
  return { updated_at: readElement(text, "lastBuildDate"), warnings };
}

function parsePolygon(polygonText) {
  return decodeXmlText(polygonText)
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => pair.split(",").map(Number));
}

/**
 * Parses one CAP 1.2 nowcast warning.
 *
 * @param xmlText - The CAP document (string)
 * @param options - `{includePolygons}`: false leaves out the area polygons, which can be large (object, optional)
 * @returns Warning fields, with `polygons` as arrays of [latitude, longitude] pairs (object)
 * @throws PluginError kind `api_error` - The body is not a CAP alert
 */
export function parseCapAlert(xmlText, { includePolygons = true } = {}) {
  const text = String(xmlText ?? "");
  if (!/<alert[\s>]/.test(text)) throw new PluginError("BMKG nowcast: the response is not a CAP alert", { kind: "api_error" });
  const alert = {
    identifier: readElement(text, "identifier"),
    sent: readElement(text, "sent"),
    language: readElement(text, "language"),
    event: readElement(text, "event"),
    urgency: readElement(text, "urgency"),
    severity: readElement(text, "severity"),
    certainty: readElement(text, "certainty"),
    effective: readElement(text, "effective"),
    expires: readElement(text, "expires"),
    sender_name: readElement(text, "senderName"),
    headline: readElement(text, "headline"),
    description: readElement(text, "description"),
    infographic_url: readElement(text, "web"),
    area_description: readElement(text, "areaDesc"),
  };
  if (!includePolygons) return alert;
  return { ...alert, polygons: readAllElements(text, "polygon").map(parsePolygon) };
}
