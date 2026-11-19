# rss-reader

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **news and blog feeds**. It fetches RSS 2.0
(and 0.9x), RSS 1.0 (RDF), Atom 1.0 and JSON Feed 1.x from public https URLs and returns every format in one
normalised shape, so workflows and agents can poll feeds without caring which format a site uses.

## Features
- **`read_feed`:** fetch a feed by URL and normalise it.
- **`parse_feed`:** normalise feed text you already have (from another node), with no network access.
- **One item shape:** `id`, `title`, `link`, `published`, `updated` (ISO 8601 when the feed uses RFC 822 or
  ISO 8601 with a real calendar day, the raw text otherwise), `author`, `categories`, `summary` (plain text, at most
  1000 characters), `enclosures` (`url`, `type`, `length`). `link`, the feed's `link` and enclosure URLs are http(s)
  only: `javascript:`, `data:`, `file:` and other schemes become `null` (enclosures without one are dropped). `id` is
  kept as the feed wrote it (Atom ids are often `tag:` URIs); treat it as an identifier, never as a link. `include_content: true` adds `content` as readable text, or the feed's HTML with
  `content_format: "html"` (capped by `max_content_chars`, with `content_truncated` when cut).
- **Polling helpers:** `since` keeps items published or updated after a date (undated items are kept, since they
  cannot be compared); `max_items` (default 50, at most 500) with `item_count` and `truncated`. Pair it with the
  [state-store](../state-store/) plugin's `filter_unseen` to process each item once.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer. No npm dependencies (the XML parser is built in; see Safety).

## Installation
```bash
graphrt plugin install ./rss-reader
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `RSS_READER_MAX_FEED_BYTES` | 5 MiB | Largest feed accepted (65536 to 50 MiB), checked while streaming; also caps `parse_feed` input |
| `RSS_READER_TIMEOUT_MS` | `20000` | Time limit for one fetch, redirects included (1000 to 45000) |

No API key: the plugin asks graphrt for network access but no secrets, and nodes have no `access_token`.

## Quick Start
```bash
graphrt run rss-reader/example.yaml --plugins .
```

## Usage
```yaml
- { id: news, type: rss-reader.read_feed, url: "https://blog.rust-lang.org/feed.xml", since: "2026-11-01T00:00:00Z", max_items: 10 }
```
Result:
```json
{ "url": "https://blog.rust-lang.org/feed.xml", "content_type": "application/xml",
  "feed": { "format": "atom", "title": "Rust Blog", "link": "https://blog.rust-lang.org/", "description": "...", "language": null, "updated": "2026-11-16T00:00:00.000Z" },
  "items": [{ "id": "...", "title": "...", "link": "...", "published": "2026-11-16T00:00:00.000Z", "updated": "...", "author": "...", "categories": [], "summary": "...", "enclosures": [] }],
  "item_count": 1, "truncated": false }
```

## Safety
- **Public hosts only:** fetches go through the shared `public-https-fetch`: https only, at most 5 redirects with
  every hop checked, and hosts that resolve to loopback, private, link-local, CGNAT, multicast or other internal
  addresses (including IPv4-mapped IPv6) are refused before any request, so a feed URL cannot reach the cloud
  metadata service or your LAN. Fetch resolves the name again, so DNS rebinding between the check and the request
  is not covered. No credentials or cookies are ever sent.
- **Size cap** while streaming (`RSS_READER_MAX_FEED_BYTES`) and a whole-fetch time limit.
- **No DTDs, no entity expansion:** the XML parser (lib/xml-parser.mjs) skips a DOCTYPE and its internal subset
  without reading it. Declared entities are never expanded (no "billion laughs"), external entities are never
  resolved (no XXE), and any other `&name;` stays literal text. Only the five predefined entities and character
  references are decoded. Nesting depth (64) and element count (200000) are capped, and malformed XML is refused.
- **HTML is not sanitised:** `summary` and text `content` have tags, scripts and styles removed for reading (in one
  linear pass, so an unclosed `<script>` or comment cannot stall the plugin), but `content_format: "html"` returns
  the feed's HTML as is. Sanitise it before rendering it in a browser.
- **Entities:** only the parser's own entity tables are consulted (own properties), so names such as
  `&constructor;` stay literal text. The DOCTYPE skip jumps over quoted strings and comments, so a `]>` inside them
  cannot end it early.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Not https, an internal host (or a redirect to one), feed over the size cap, bad `since` |
| `api_error` | HTTP error status, malformed XML, or a document that is not an RSS, Atom or JSON feed |
| `network_error` | DNS, connection or timeout failure (retryable) |
| `cancelled` | The call was cancelled |

## License
Apache-2.0
