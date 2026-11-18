# Calendar, CRM and web-browser plugins: design

Date: 2026-11-18 · Status: approved in conversation. The user picked google-calendar, notion-api/airtable-api and web-browser; both CRMs are built so the user can choose.

## Common rules
Same as `2026-11-18-automation-and-commerce-plugins-design.md`:
- self-contained plugins on the shared runner;
- every operation is a node and a tool except `nodeOnly` ones;
- `api_request` is GET-only for tool calls;
- writes are never retried after an unknown outcome;
- credentials are redacted everywhere;
- table-driven tests with fakes, plus a live check using invalid credentials.

**Agent-safety rule (from earlier reviews):** destructive or outward-facing writes need either `nodeOnly` or an explicit env opt-in when they come from a tool call. Each plugin below says which.

## google-calendar
- **Auth:** the same four Google auth files as google-sheets (copy, byte-identical). Scope `https://www.googleapis.com/auth/calendar`. Base `https://www.googleapis.com/calendar/v3`.
- **Calendars and availability:**
  - `list_calendars`
  - `query_free_busy` (calendars, time range)
  - `find_free_slots`: computed in the plugin from free/busy. Inputs: duration, time range, working hours, IANA time zone, buffer and slot step; returns candidate slots.
- **Events:**
  - Reading: `list_events` (calendar, time range, `q`, `singleEvents`/`orderBy`, page token), `get_event`.
  - `create_event`: summary, description, start/end (dateTime + timeZone, or all-day date), location, attendees, Google Meet via `conferenceData.createRequest`, reminders.
    - `book_slot: true` re-checks free/busy right before inserting and fails `conflict` if the slot was taken.
  - `update_event` (PATCH), `delete_event`, `quick_add`.
- **Idempotency:**
  - `create_event` sends a client-generated event id: a deterministic id from `idempotency_key` when given, otherwise random. A retried insert can then never create a duplicate, so inserts may be retried.
  - A 409 duplicate on retry counts as success. `requestId` for conference creation comes from the same key.
- **Tool guardrails:**
  - Tool calls only act on calendars in `GOOGLE_CALENDAR_TOOL_ALLOWED_IDS` (default `primary`).
  - `sendUpdates` is forced to `none` for tool calls unless `GOOGLE_CALENDAR_TOOL_SEND_UPDATES=1`, so an agent can't email invites to arbitrary people.
  - `delete_event` and `update_event` from tool calls only work on events this plugin created (tagged `extendedProperties.private.graphrt_created=1`).
  - Workflow nodes have none of these limits.

## notion-api
- **Auth and transport:**
  - Env `NOTION_TOKEN` (internal integration secret). Base `https://api.notion.com/v1`.
  - Header `Notion-Version`: the latest version in the official docs. If that version replaces databases with data sources, support the data-source endpoints and document it.
  - Rate limit about 3 requests per second: 429 is honoured via `Retry-After`.
- **Operations:**
  - `search`, `get_page`, `get_page_property`
  - `create_page` (in a database/data source or under a page, properties as Notion JSON plus a simple `{name: value}` convenience mapping for title/rich_text/number/select/multi_select/date/checkbox/url/email/phone)
  - `update_page_properties`, `archive_page` / `restore_page`
  - `query_database` (filter, sorts, page cursor), `get_database`
  - `get_block_children`, `append_paragraphs` (plain text to paragraph blocks, ≤ 100 blocks per call), `add_comment`
  - `api_request`
- **Tool guardrails:** `archive_page` is a tool (reversible).
- **Retries:** `create_page` is a POST and is never retried after an unknown outcome.

## airtable-api
- **Auth and transport:**
  - Env `AIRTABLE_TOKEN` (personal access token) and an optional default `AIRTABLE_BASE_ID`. Base `https://api.airtable.com/v0`.
  - Rate limit 5 requests per second per base. A 429 means wait 30 s, which exceeds the shared client's 60 s cap only when stacked, so honour it once and then fail `rate_limited`.
- **Operations:**
  - `list_bases`, `get_base_schema`
  - `list_records` (table, view, `filterByFormula`, sort, fields, pageSize, offset cursor), `get_record`, `find_records` (simple field=value helper that builds a safely escaped formula)
  - `create_records` (≤ 10 per call), `update_records` (PATCH, ≤ 10), `upsert_records` (`performUpsert.fieldsToMergeOn`)
  - `delete_records` (≤ 10, **nodeOnly**)
  - `api_request`
- **Retries:** `upsert_records` is idempotent by design (merge on fields), so it may be retried; `create_records` may not.
- **Formula safety:** strings are escaped correctly in formulas (quotes, backslashes), so a value can never break out of the formula.

## web-browser (Playwright, read-only browsing)
- **Dependency:** `playwright` (same version as google-maps-scraper). One long-lived headless Chromium per plugin process, a **fresh browser context per call** (no cookies or storage carried over), idle shutdown, and operations serialised with a small concurrency limit.
- **Operations:**
  - `fetch_page`: url → final url, status, title, meta description, readable text (main content heuristics, capped), optional markdown, links (capped).
  - `extract`: url plus CSS selectors map → text/attribute values, capped.
  - `get_links` (filter by same-site/pattern).
  - `screenshot`: url → PNG file path in `WEB_BROWSER_SCREENSHOT_DIR`, viewport or full page with a height cap.
  - `wait_for` options: load / networkidle / selector, with timeouts.
- **Safety:**
  - Only http(s).
  - Public hosts only: DNS check and per-request interception, so every navigation and sub-request to loopback, private, link-local or metadata addresses is blocked, including after redirects.
  - No downloads, no file://, no arbitrary JS evaluation exposed to tools.
  - Response size and time caps.
  - Optional robots.txt respect (`WEB_BROWSER_RESPECT_ROBOTS`, default on).
  - A clear user agent.
- **Explicitly not in v1:** clicking, typing or logins (no session operations). They can be added later behind nodeOnly or opt-in.

## Testing
- Fakes for every request shape and guardrail.
- google-calendar `find_free_slots` gets pure-function tests: time zones, DST, working hours, buffers.
- Notion and Airtable property/formula mapping tables.
- web-browser: an injected browser plus a local test HTTP server for the parsing and blocking logic. The live check fetches one public page (`https://example.com`) and tries a blocked private URL.

## Left to the builder
Exact field lists, text-extraction heuristics and file layout.
