# wikipedia

**Status:** stable · **ToS risk:** none. Public no-auth API; the example read real data live (rechecked 2026-11-19). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for Wikipedia in any language, through the
[MediaWiki Action API](https://www.mediawiki.org/wiki/API:Main_page) and the
[REST v1 API](https://en.wikipedia.org/api/rest_v1/). It searches articles, returns summaries, plain-text content,
media lists, articles near a coordinate and the same article in other languages. No account or API key is needed.
Every operation is a workflow node and an agent tool.

## Features
- **`search_pages`:** full-text search (`intitle:`, `incategory:`, quoted phrases), paginated with `limit`/`cursor`
- **`get_page_summary`:** title, short description, plain-text lead (`extract`), thumbnail, coordinates, URLs
- **`get_page_content`:** the whole article (or only the lead with `intro_only`) as plain text, capped at
  `max_chars` (default 20,000) with `truncated` and `total_chars`
- **`get_page_media`:** images, audio and video on a page with captions and thumbnail URLs
- **`search_nearby_pages`:** articles near `"lat|lon"` within `radius_meters` (up to 10 km), nearest first
- **`get_page_languages`:** links to the same article in other Wikipedias (up to `limit`, default 500; MediaWiki's
  `llcontinue` comes back as `next_cursor` for the rest)
- **`api_request`:** any other Action or REST endpoint on the wiki, e.g.
  `/w/api.php?action=query&prop=categories&titles=Borobudur&format=json` (GET only for agents)

Every operation except `api_request` takes `language` (`en`, `id`, `de`, `ja`, `simple`, `zh-yue`, ...).
Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `*.wikipedia.org`

## Installation
```bash
graphrt plugin install ./wikipedia
```
No `npm install` needed: the plugin has no dependencies.

## Runtime: Node.js or WebAssembly
This plugin runs on Node.js (the release tarball, above). A sandboxed WebAssembly build with the same nodes, tools,
env variables, results and errors is in [`wasm/wikipedia`](../wasm/wikipedia/): no Node.js process, cold runs ~6× faster
(≈18–24 ms instead of ≈110 ms) and ~12× less memory on a warm server, but 1–3 ms slower per warm call. Install one
of the two (same plugin name):

```bash
graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/wikipedia
```
The release catalog lists the build in the plugin's `wasm` field. Differences and measurements:
[wasm/README.md](../wasm/README.md#choosing-a-runtime).

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `WIKIPEDIA_LANGUAGE` | no | Default wiki for calls without `language`, e.g. `id` (default `en`) |

No secrets. Every request sends the User-Agent
`graphrt-wikipedia-plugin/0.1.0 (https://github.com/BimaPangestu28/graphrt-plugins; graphrt workflow plugin)`, as
the [Wikimedia User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) asks.

**Terms:** Wikimedia has no fixed quota for reads but asks for serial requests and reasonable volume
([API etiquette](https://www.mediawiki.org/wiki/API:Etiquette)); heavy users get 429s. Text is CC BY-SA 4.0:
credit Wikipedia and link the article when you republish it.

## Quick Start
```bash
graphrt run wikipedia/example.yaml --plugins .
```
The example searches for Borobudur and prints the top hit's summary.

## Usage
```yaml
- id: article
  type: wikipedia.get_page_content
  page_title: Candi Borobudur
  language: id
  max_chars: 8000
```
- Titles are case-sensitive after the first letter; redirects are followed (`"Jokowi"` gives "Joko Widodo").
- `search_pages` snippets contain HTML (`<span class="searchmatch">`).
- `get_page_content` on a page that does not exist is `not_found`.

## Agent policy
All operations are free reads and available to agents as tools. `language` only accepts plain wiki codes, so calls
always stay on `wikipedia.org`. `api_request` is GET-only for agents (Wikipedia writes need a login the plugin does
not have).

## Errors
| Kind | When |
|------|------|
| `not_found` | 404 from the REST API (unknown page), or a missing page in `get_page_content` |
| `invalid_input` | bad `language`, or a MediaWiki parameter error (`badvalue`, `badinteger`, `missingparam`, `invalidtitle`, ...; sent with HTTP 200, the code and `info` are in the message) |
| `rate_limited` | 429, or MediaWiki `ratelimited` / `maxlag` (maxlag is retried) |
| `api_error` | other MediaWiki error codes, 5xx (retried) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus language, User-Agent and content-cap cases.
Verified live with a real read (`graphrt run wikipedia/example.yaml --plugins .`).

## License
Apache-2.0
