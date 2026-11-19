/**
 * read_feed (fetch a public https feed) and parse_feed (feed text from another node).
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { fetchPublicHttpsBytes } from "../lib/shared/public-https-fetch.mjs";
import { normalizeFeed } from "../lib/feed-normalizer.mjs";
import { decodeFeedBytes } from "../lib/text-decoding.mjs";

const SHAPING_PARAMETERS = {
  max_items: { type: "integer", minimum: 1, maximum: 500, default: 50, description: "Most items to return, in feed order; `truncated` says when there were more" },
  since: { type: "string", description: "ISO 8601 date-time: keep only items published (or updated) after it; undated items are kept" },
  include_content: { type: "boolean", default: false, description: "Add each item's full content (content:encoded, Atom content, content_html/text)" },
  content_format: { type: "string", enum: ["text", "html"], default: "text", description: "Content as readable plain text or as the feed's HTML (not sanitised)" },
  max_content_chars: { type: "integer", minimum: 100, maximum: 200000, default: 20000, description: "Longest content per item; longer content ends in … and has content_truncated" },
};

function parseSince(since) {
  if (since === undefined) return null;
  const milliseconds = Date.parse(since);
  if (!Number.isFinite(milliseconds) || !/^\d{4}-\d\d-\d\d/.test(since)) throw new PluginError("`since` must be an ISO 8601 date or date-time, e.g. 2026-11-18T00:00:00Z", { kind: "invalid_input" });
  return milliseconds;
}

function isNewerThan(item, sinceMilliseconds) {
  const itemMilliseconds = Date.parse(item.published ?? item.updated ?? "");
  return !Number.isFinite(itemMilliseconds) || itemMilliseconds > sinceMilliseconds;
}

/**
 * Normalises feed text and applies `since` and `max_items`.
 *
 * @param text - Feed document (string)
 * @param args - Validated operation arguments (object)
 * @returns `{feed, items, item_count, truncated}` (object)
 * @throws PluginError kinds `api_error` (not a feed), `invalid_input` (bad `since`)
 */
export function shapeFeed(text, args) {
  const sinceMilliseconds = parseSince(args.since);
  const { feed, items } = normalizeFeed(text, { includeContent: args.include_content, contentFormat: args.content_format, maxContentChars: args.max_content_chars });
  const selected = sinceMilliseconds === null ? items : items.filter((item) => isNewerThan(item, sinceMilliseconds));
  return { feed, items: selected.slice(0, args.max_items), item_count: selected.length, truncated: selected.length > args.max_items };
}

const readFeedOperation = {
  name: "read_feed",
  title: "Read a feed",
  description: "Fetches an RSS 2.0, RSS 1.0, Atom or JSON Feed from a public https URL and returns the feed and its items in one normalised shape (title, link, dates, author, categories, plain-text summary, enclosures)",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Feed URL (https, public host)" }, ...SHAPING_PARAMETERS },
    required: ["url"],
  },
  run: async ({ client, args, signal }) => {
    parseSince(args.since); // a bad `since` fails before any request
    const { bytes, contentType } = await fetchPublicHttpsBytes(args.url, {
      fetchImpl: client.fetchImpl,
      resolveHostAddresses: client.resolveHostAddresses,
      signal,
      maxBytes: client.settings.maxFeedBytes,
      timeoutMs: client.settings.timeoutMs,
      label: "url",
    });
    const shaped = shapeFeed(decodeFeedBytes(bytes), args);
    return { data: { url: args.url, content_type: contentType || null, ...shaped } };
  },
};

const parseFeedOperation = {
  name: "parse_feed",
  title: "Parse feed text",
  description: "Parses RSS, Atom or JSON Feed text you already have (e.g. from another node) into the same normalised shape as read_feed, without any network access",
  parameters: {
    type: "object",
    properties: { content: { type: "string", description: "The feed document (XML or JSON text)" }, ...SHAPING_PARAMETERS },
    required: ["content"],
  },
  run: async ({ client, args }) => {
    if (Buffer.byteLength(args.content) > client.settings.maxFeedBytes) {
      throw new PluginError(`\`content\` is larger than the ${client.settings.maxFeedBytes}-byte limit (RSS_READER_MAX_FEED_BYTES)`, { kind: "invalid_input" });
    }
    return { data: shapeFeed(args.content, args) };
  },
};

export const feedOperations = [readFeedOperation, parseFeedOperation];
