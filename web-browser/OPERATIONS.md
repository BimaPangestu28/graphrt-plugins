# web-browser operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `web-browser.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `fetch_page` | Open a public web page in a headless browser and return its title, meta description, readable main text (optionally markdown) and links. Read-only: no clicking, typing or logins. | **url**, main_content_only, include_markdown, max_chars, max_links, wait_until, wait_for_selector, timeout_seconds |
| `get_links` | Open a public web page and list its unique http(s) links (url and text), optionally only the same host/domain or matching a wildcard pattern such as "*/blog/*". | **url**, scope, pattern, limit, wait_until, wait_for_selector, timeout_seconds |
| `extract` | Open a public web page and read values with CSS selectors: `fields` maps names to a selector string (text of the first match) or {selector, attribute?, all?}. CSS only; no scripts. | **url**, **fields**, max_matches, wait_until, wait_for_selector, timeout_seconds |
| `screenshot` | Open a public web page and save a PNG screenshot (viewport, or full page up to max_height pixels) in WEB_BROWSER_SCREENSHOT_DIR; returns the file path. | **url**, full_page, viewport_width, viewport_height, max_height, wait_until, wait_for_selector, timeout_seconds |
