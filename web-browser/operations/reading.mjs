/**
 * Read-only page operations: fetch_page, get_links and extract.
 */
import { invalidInput } from "../lib/errors.mjs";
import { normalizeFieldSpecs, shapeFieldResults } from "../lib/field-specs.mjs";
import { filterLinks, LINK_SCOPES, MAX_PATTERN_LENGTH, validateLinkFilter } from "../lib/link-filter.mjs";
import { browsePage } from "../lib/page-loader.mjs";
import { evaluateInIsolatedWorld } from "../lib/page-reader.mjs";
import { extractFieldsInPage, readTitleInPage, snapshotDocumentInPage } from "../lib/page-snapshot.mjs";
import { sanitizeFieldResults, sanitizeSnapshot, sanitizeTitle } from "../lib/snapshot-limits.mjs";
import { buildReadableContent, collectLinks, selectContentRoot, truncateText } from "../lib/readable.mjs";
import { buildLoadRequest, describePage, URL_PROPERTY, WAIT_PROPERTIES } from "./common.mjs";

export const SNAPSHOT_LIMITS = { maxNodes: 30000, maxTextChars: 2000000, maxAttributeChars: 2000000, maxDepth: 400 };
const EXTRACT_LIMITS = { maxValueChars: 2000 };

const fetchPageOperation = {
  name: "fetch_page",
  title: "Fetch web page",
  description:
    "Open a public web page in a headless browser and return its title, meta description, readable main text (optionally markdown) and links. Read-only: no clicking, typing or logins.",
  parameters: {
    type: "object",
    properties: {
      url: URL_PROPERTY,
      main_content_only: { type: "boolean", default: true, description: "Keep only the main content (article/main), without navigation, footers and sidebars" },
      include_markdown: { type: "boolean", default: false, description: "Also return the content as markdown (headings, lists, links, tables)" },
      max_chars: { type: "integer", minimum: 500, maximum: 100000, default: 20000, description: "Cut the text (and markdown) after this many characters" },
      max_links: { type: "integer", minimum: 0, maximum: 500, default: 50, description: "Links to return from the content (0 for none)" },
      ...WAIT_PROPERTIES,
    },
    required: ["url"],
  },
  run: async ({ client, args, signal }) => {
    const readPage = async (page, loadedPage) => {
      const snapshot = await readSnapshot(page);
      return buildFetchPageResult(snapshot, loadedPage.finalUrl, args);
    };
    const { result, loadedPage, blockedRequests } = await browsePage(client, buildLoadRequest(args, "text"), readPage, signal);
    return { data: { ...describePage(args.url, loadedPage, blockedRequests), ...result } };
  },
};

/**
 * Takes the DOM snapshot in an isolated world and re-applies its caps in Node.
 *
 * @param page - Playwright Page (object)
 * @returns Snapshot within SNAPSHOT_LIMITS (Promise<object>)
 */
async function readSnapshot(page) {
  return sanitizeSnapshot(await evaluateInIsolatedWorld(page, snapshotDocumentInPage, SNAPSHOT_LIMITS), SNAPSHOT_LIMITS);
}

/**
 * Turns a DOM snapshot into the fetch_page result (pure).
 *
 * @param snapshot - From snapshotDocumentInPage (object)
 * @param finalUrl - URL the page ended on (string)
 * @param args - fetch_page arguments (object)
 * @returns `{title, description, lang, canonical_url, text, text_length, text_truncated, markdown?, links, links_truncated, snapshot_truncated}` (object)
 */
export function buildFetchPageResult(snapshot, finalUrl, args) {
  const contentRoot = selectContentRoot(snapshot.root, { mainContentOnly: args.main_content_only });
  const content = buildReadableContent(contentRoot, { markdown: args.include_markdown });
  const text = truncateText(content.text, args.max_chars);
  const links = args.max_links > 0 ? collectLinks(contentRoot, finalUrl) : [];
  const result = {
    title: snapshot.metadata.title || null,
    description: snapshot.metadata.description,
    lang: snapshot.metadata.lang,
    canonical_url: snapshot.metadata.canonical_url,
    text: text.text,
    text_length: content.text.length,
    text_truncated: text.truncated,
    links: links.slice(0, args.max_links),
    links_truncated: links.length > args.max_links,
    snapshot_truncated: snapshot.truncated,
  };
  if (args.include_markdown) {
    const markdown = truncateText(content.markdown, args.max_chars);
    Object.assign(result, { markdown: markdown.text, markdown_truncated: markdown.truncated });
  }
  return result;
}

const getLinksOperation = {
  name: "get_links",
  title: "Get page links",
  description:
    "Open a public web page and list its unique http(s) links (url and text), optionally only the same host/domain or matching a wildcard pattern such as \"*/blog/*\".",
  parameters: {
    type: "object",
    properties: {
      url: URL_PROPERTY,
      scope: { type: "string", enum: LINK_SCOPES, default: "all", description: "`same_host` (ignores www.), `same_domain` (host and its subdomains) or `all`" },
      pattern: { type: "string", description: `Wildcard (*) matched against the full link URL, case-insensitive; without * it matches anywhere in the URL (max ${MAX_PATTERN_LENGTH} chars)` },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Maximum links to return" },
      ...WAIT_PROPERTIES,
    },
    required: ["url"],
  },
  run: async ({ client, args, signal }) => {
    const readPage = async (page, loadedPage) => {
      const snapshot = await readSnapshot(page);
      const matchingLinks = filterLinks(collectLinks(snapshot.root, loadedPage.finalUrl), { pageUrl: loadedPage.finalUrl, scope: args.scope, pattern: args.pattern });
      return { title: snapshot.metadata.title || null, links: matchingLinks.slice(0, args.limit), total_found: matchingLinks.length, truncated: matchingLinks.length > args.limit };
    };
    validateLinkFilter(args);
    const { result, loadedPage, blockedRequests } = await browsePage(client, buildLoadRequest(args, "text"), readPage, signal);
    return { data: { ...describePage(args.url, loadedPage, blockedRequests), ...result } };
  },
};

const extractOperation = {
  name: "extract",
  title: "Extract from page",
  description:
    "Open a public web page and read values with CSS selectors: `fields` maps names to a selector string (text of the first match) or {selector, attribute?, all?}. CSS only; no scripts.",
  parameters: {
    type: "object",
    properties: {
      url: URL_PROPERTY,
      fields: {
        type: "object",
        description: "e.g. {\"title\": \"h1\", \"prices\": {\"selector\": \".price\", \"all\": true}, \"next\": {\"selector\": \"a.next\", \"attribute\": \"href\"}}",
      },
      max_matches: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Values per `all: true` field" },
      ...WAIT_PROPERTIES,
    },
    required: ["url", "fields"],
  },
  run: async ({ client, args, signal }) => {
    const fieldSpecs = normalizeFieldSpecs(args.fields);
    const readPage = async (page) => {
      const limits = { ...EXTRACT_LIMITS, maxMatches: args.max_matches };
      const rawResults = await evaluateInIsolatedWorld(page, extractFieldsInPage, { fieldSpecs, limits });
      const shaped = shapeFieldResults(fieldSpecs, sanitizeFieldResults(rawResults, fieldSpecs, limits));
      const selectorErrors = Object.entries(shaped.errors);
      if (selectorErrors.length === fieldSpecs.length) throw invalidInput(`No selector could be used: ${selectorErrors.map(([name, message]) => `${name}: ${message}`).join("; ")}`);
      return { title: sanitizeTitle(await evaluateInIsolatedWorld(page, readTitleInPage)), ...shaped };
    };
    const { result, loadedPage, blockedRequests } = await browsePage(client, buildLoadRequest(args, "text"), readPage, signal);
    return { data: { ...describePage(args.url, loadedPage, blockedRequests), ...result } };
  },
};

export const readingOperations = [fetchPageOperation, getLinksOperation, extractOperation];
