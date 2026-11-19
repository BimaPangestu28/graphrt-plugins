# google-maps-scraper

**Status:** experimental · **ToS risk:** high. Scrapes Google Maps with a headless browser: works live (PR #1), but against Google's terms and breaks when the Maps UI changes. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin that searches Google Maps with a headless
Chromium browser (Playwright) and returns business phone numbers, addresses, websites and ratings.
Free: no API key or paid service.

> **Warning:** scraping Google Maps breaks Google's Terms of Service. Heavy use triggers a CAPTCHA
> (the node fails with `blocked`), and the selectors break whenever Google changes the Maps UI.
> Keep volumes low. For production use, consider the paid Google Places API.

## Features
- `google-maps-scraper.search` node: query → `results`, `phones`, `count`
- `google-maps-scraper/search_places` tool for `tool` and `agent` nodes
- Scrolls the result list up to `max_results` (1–100); handles searches that open a single place
- Per-place progress events, cancellation, clear errors (`invalid_input`, `blocked`, `setup_required`)

## Prerequisites
- Node.js >= 18
- graphrt with plugin support
- About 150 MB of disk for Chromium

## Installation
```bash
cd google-maps-scraper
npm install
npx playwright install chromium
graphrt plugin install .
```
The plugin runs `node plugin.mjs` from its own directory, so `node_modules/` must sit next to it.
If you install it from git, run the two `npm`/`npx` commands inside the installed copy
(`~/.graphrt/plugins/google-maps-scraper`).

## Quick Start
```bash
graphrt run google-maps-scraper/example.yaml --plugins . --input query="bengkel motor Bandung"
# Found 5 places. Phones: ["081222888397", ...]
```

## Usage
```yaml
- id: search
  type: google-maps-scraper.search
  query: "{{#start.query#}}"
  max_results: 20
```
Then use `{{#search.phones#}}`, `{{#search.results#}}` or `{{#search.count#}}`.

## Configuration
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | (required) | What to search for, e.g. `kopi Bandung` |
| `max_results` | integer | `20` | Maximum places to return (1–100) |
| `language` | string | `id` | Google Maps interface language (`id`, `en`, `pt-BR`, …) |
| `headless` | boolean | `true` | Set `false` to watch the browser |

Outputs:
- `results`: `array[object]` of `{name, phone, address, website, website_label, rating, maps_url}`. Fields are `null` when missing.
  `website` is the full link from the place page (falls back to the visible label); `website_label` is the label as shown.
  A search Google Maps finds nothing for returns an empty list (logged to stderr) instead of failing.
- `phones`: `array[string]` of unique phone numbers, digits only with an optional leading `+`.
- `count`: integer.

Timing: about 1–1.5 s per place. Node timeout is 5 minutes and at most 2 searches run at once.
Cancelling a run closes the browser immediately. Tool calls (`google-maps-scraper/search_places`) cannot be cancelled by the
host, so they stop themselves after 290 s with `cancelled`.
`max_results` may be a number or a whole-number string (e.g. from `{{#start.n#}}`).

Live view: when the host sets `GRAPHRT_LIVE_VIEW_DIR` (an absolute folder; the graphrt desktop app does), the page's
screen is written there as a small JPEG (max 960×720, quality 60, about 6 per second) while the search runs, so the
host can show it live, and deleted when the search ends. Frames stay on the machine and are never logged. Unset: no frames.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad config |
| `blocked` | Google served its `/sorry/` page or a CAPTCHA form (retryable after ~10 min) |
| `setup_required` | Chromium is not installed: run `npx playwright install chromium` |
| `browser_error` | Browser failed to start for another reason |
| `cancelled` | The run was cancelled |

## Development
```bash
npm test   # unit tests for the pure parsing helpers (no browser)
```
Code layout: `lib/parse.mjs` (pure helpers), `lib/scraper.mjs` (Playwright), `plugin.mjs` (protocol wiring),
`graphrt-plugin.mjs` (vendored graphrt JS SDK).

## License
Apache-2.0
