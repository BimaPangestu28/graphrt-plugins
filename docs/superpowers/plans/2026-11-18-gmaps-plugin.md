# gmaps Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** graphrt plugin `gmaps` that searches Google Maps via headless Chromium and returns phone numbers.

**Architecture:** `runtime: process` Node plugin. Pure logic (validation, URL, parsing) in `lib/parse.mjs`, browser automation in `lib/scraper.mjs`, protocol wiring in `plugin.mjs` using the vendored graphrt JS SDK.

**Tech Stack:** Node >=18 ESM, `playwright` (Chromium), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-18-gmaps-plugin-design.md`

## Global Constraints
- Never write to stdout from plugin code; logs go to stderr / `ctx.log`.
- Config: `query` required non-empty string; `max_results` integer default 20, range 1–100; `language` default `id`; `headless` default `true`.
- Error kinds: `invalid_input`, `blocked`, `setup_required`.
- Manifest limits: `timeout_ms` 300000, `max_concurrency` 2.
- Outputs: `results` `{name, phone, address, website, rating, maps_url}[]`, `phones` string[] (non-null, unique), `count` integer.

## Review Focus
- Query with spaces/`&`/non-ASCII (e.g. "kopi & roti Bandung") → URL-encoded correctly (test in Task 1).
- Place without a phone → `phone: null`, excluded from `phones` (test in Task 1).
- Search that lands directly on one place page (no feed) → returns 1 result (handled in Task 2, smoke-checked in Task 3).
- Google `/sorry/` CAPTCHA redirect → `blocked` error, not empty result (test in Task 1 via `isBlockedPage`).
- Chromium not installed → `setup_required` with install command in message (test in Task 1 via `classifyLaunchError`).

---

### Task 1: Package scaffold + pure parsing module

**Files:**
- Create: `gmaps/package.json` (`"type":"module"`, dep `playwright`, script `"test": "node --test test/"`), `gmaps/.gitignore` (`node_modules/`)
- Create: `gmaps/lib/parse.mjs`
- Test: `gmaps/test/parse.test.mjs`

**Interfaces — Produces (all exported from `lib/parse.mjs`):**
- `validateSearchConfig(config: object) -> {query: string, maxResults: number, language: string, headless: boolean}`; throws `PluginError` kind `invalid_input`. Import `PluginError` from `../graphrt-plugin.mjs` (vendored SDK copy of `graphrt/sdk/typescript/index.mjs`, created in this task).
- `buildSearchUrl(query: string, language: string) -> string` → `https://www.google.com/maps/search/<encodeURIComponent(query)>?hl=<language>`
- `normalizePhone(raw: string|null|undefined) -> string|null` — strip `tel:` prefix and whitespace/dashes/parens; keep leading `+`; empty → null.
- `extractPlaceDetails(items: Array<{itemId: string, label: string}>) -> {phone, address, website}` — `itemId` starting `phone:tel:` → phone (normalized from itemId suffix); `address` → address (label with leading "Alamat: "/"Address: " removed); `authority` → website (label text). Missing → null.
- `parseRating(text: string|null) -> number|null` — accepts "4,5" and "4.5".
- `collectPhones(results: Array<{phone: string|null}>) -> string[]` — unique, non-null, order kept.
- `isBlockedPage(url: string, bodyText: string) -> boolean` — true if url contains `/sorry/` or body mentions "unusual traffic".
- `classifyLaunchError(error: Error) -> PluginError` — message matching `Executable doesn't exist` → kind `setup_required`, message includes `npx playwright install chromium`; else kind `browser_error`.

- [ ] **Step 1: Write failing tests** in `test/parse.test.mjs` covering at minimum:
  - `validateSearchConfig({query:"cafe"})` deep-equals `{query:"cafe",maxResults:20,language:"id",headless:true}`; `{query:""}`, `{query:"x",max_results:0}`, `{query:"x",max_results:101}`, `{query:"x",max_results:2.5}` throw with `kind === "invalid_input"`.
  - `buildSearchUrl("kopi & roti Bandung","id") === "https://www.google.com/maps/search/kopi%20%26%20roti%20Bandung?hl=id"`.
  - `normalizePhone("tel:+62 22-1234 (567)") === "+62221234567"`; `normalizePhone("  ") === null`; `normalizePhone(undefined) === null`.
  - `extractPlaceDetails([{itemId:"phone:tel:+62221234567",label:"Telepon: 022-1234567"},{itemId:"address",label:"Alamat: Jl. Braga 1"},{itemId:"authority",label:"braga.id"}])` → `{phone:"+62221234567",address:"Jl. Braga 1",website:"braga.id"}`; `extractPlaceDetails([])` → all null.
  - `parseRating("4,5") === 4.5`, `parseRating(null) === null`.
  - `collectPhones([{phone:"1"},{phone:null},{phone:"1"},{phone:"2"}])` deep-equals `["1","2"]`.
  - `isBlockedPage("https://www.google.com/sorry/index","")` true; `isBlockedPage("https://www.google.com/maps/search/x","Our systems have detected unusual traffic")` true; normal → false.
  - `classifyLaunchError(new Error("browserType.launch: Executable doesn't exist at ..."))` → kind `setup_required`, message includes `npx playwright install chromium`.
- [ ] **Step 2:** `cd gmaps && npm install && npm test` → FAIL (module missing).
- [ ] **Step 3:** Copy SDK to `gmaps/graphrt-plugin.mjs` (+ `graphrt-plugin.d.ts`), implement `lib/parse.mjs`.
- [ ] **Step 4:** `npm test` → all PASS.
- [ ] **Step 5:** Commit `feat(gmaps): add config validation and place parsing helpers`.

### Task 2: Playwright scraper

**Files:**
- Create: `gmaps/lib/scraper.mjs`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `searchPlaces(options: {query, maxResults, language, headless}, hooks: {signal?: AbortSignal, onProgress?: (info:{index,total,name}) => void}) -> Promise<Array<{name, phone, address, website, rating, maps_url}>>`. Throws `PluginError` kinds `blocked`, `setup_required`, `browser_error`, `cancelled`.

Behavior: launch Chromium (wrap launch errors with `classifyLaunchError`); always close browser in `finally`; context locale = language. Goto `buildSearchUrl`; if consent form (`consent.google.com` or button `form [aria-label*="Accept" i], button:has-text("Terima semua"), button:has-text("Accept all")`) click it. After load, check `isBlockedPage`. If `div[role=feed]` exists: scroll it until anchors `a[href*="/maps/place/"]` ≥ maxResults or end-of-list text appears / no growth for 3 scrolls; take first `maxResults` hrefs, visit each. Otherwise treat current page as single place. For each place page: name from `h1`, rating from `div.F7nice span[aria-hidden]` via `parseRating`, items from `[data-item-id]` → `{itemId, label: aria-label || innerText}` → `extractPlaceDetails`, `maps_url` = page URL. Check `signal.aborted` between places (throw kind `cancelled`); call `onProgress` per place. A single place that fails extraction is logged to stderr and skipped, not fatal.

- [ ] **Step 1:** Implement `lib/scraper.mjs`.
- [ ] **Step 2:** Manual check: `node -e 'import("./lib/scraper.mjs").then(m=>m.searchPlaces({query:"bengkel motor Bandung",maxResults:3,language:"id",headless:true},{onProgress:i=>console.error(i)})).then(r=>console.error(JSON.stringify(r,null,2)))'` → 3 results, ≥1 with a phone.
- [ ] **Step 3:** Single-place check with a specific query (e.g. `"Gedung Sate Bandung"`) → 1 result.
- [ ] **Step 4:** Commit `feat(gmaps): add Playwright Google Maps scraper`.

### Task 3: Plugin wiring, manifest, example, README

**Files:**
- Create: `gmaps/plugin.mjs`, `gmaps/graphrt-plugin.json`, `gmaps/example.yaml`, `gmaps/README.md`, root `README.md` (lists plugins)

**Interfaces:**
- Consumes: `validateSearchConfig`, `collectPhones`, `searchPlaces`.
- Produces: node kind `gmaps.search` (category `integration`, outputs `results` object, `phones` object, `count` integer); tool `gmaps_search` (parameters same as config schema, returns `{text: JSON of results, data: {results, phones, count}}`).

`plugin.mjs`: shared `runSearch(config, hooks)` → `{results, phones, count}`; node handler passes `ctx.signal` and `onProgress → ctx.progress("place", info)`. Manifest: `runtime: process`, `command: node`, `args: ["plugin.mjs"]`, `permissions: {network: true}`, limits per Global Constraints, `config_schema` with defaults/min/max matching Task 1. `example.yaml`: start var `query` → `gmaps.search` (`max_results: 5`) → answer `{{#search.phones#}}`. README: install (`npm install`, `npx playwright install chromium`, `graphrt plugin install ./gmaps`), usage, ToS/CAPTCHA warning.

- [ ] **Step 1:** Write the files.
- [ ] **Step 2:** `npm test` still PASS.
- [ ] **Step 3:** Smoke: `/Users/bimapangestu/Desktop/Works/personal/graphrt/target/debug/graphrt run gmaps/example.yaml --plugins . --input query="bengkel motor Bandung"` → answer prints a list of phone numbers.
- [ ] **Step 4:** Commit `feat(gmaps): wire gmaps.search node and tool`.
