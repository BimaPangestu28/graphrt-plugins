# google-sheets

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the official **Google Sheets API v4**. Use a
spreadsheet as a shared data sink for workflows: read ranges, append rows, overwrite or clear cells, and treat a
sheet with a header row as a small table (find rows, upsert by key). Every operation is a workflow node and an
agent tool.

## Features
- **Spreadsheets:** metadata and sheet list, create a spreadsheet, add a sheet (tab)
- **Values:** read one range or many, append rows (`USER_ENTERED` or `RAW`, `INSERT_ROWS` or `OVERWRITE`),
  update a range, clear a range
- **Records:** `find_rows` (header row + simple filters, done in the plugin) and `upsert_row` (match by a key
  column, update only the given cells, or append)
- **`api_request`:** any other Sheets API endpoint, restricted to `sheets.googleapis.com`
- **Auth:** OAuth refresh token, service account key file, or a ready access token. Tokens are fetched and cached
  by the plugin.
- Sheet names are always quoted for you (`My Sheet` becomes `'My Sheet'`, `Jon's` becomes `'Jon''s'`)
- Writes that may already have happened (append, create, upsert) are never retried; the error says how to check.
  `clear_range` is idempotent, so its failures are retryable

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with the **Google Sheets API** enabled
- Scope `https://www.googleapis.com/auth/spreadsheets`

## Installation
```bash
graphrt plugin install ./google-sheets
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
Set **one** of these credential options.

| Env var | Description |
|---------|-------------|
| `GOOGLE_REFRESH_TOKEN` | OAuth refresh token for a Google account (authorize with `access_type=offline` and the spreadsheets scope) |
| `GOOGLE_CLIENT_ID` | OAuth client id that issued the refresh token |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **Path** to a service account JSON key file |
| `GOOGLE_ACCESS_TOKEN` | A ready OAuth access token (expires after about an hour), e.g. from `gcloud auth print-access-token` |

- **Refresh trio:** the plugin exchanges the refresh token at `https://oauth2.googleapis.com/token`, caches the
  access token until a minute before it expires, and refreshes once when Sheets answers 401.
- **Service account:** the plugin reads the key file, signs an RS256 JWT with `node:crypto` and exchanges it at
  `https://oauth2.googleapis.com/token` (the file's own `token_uri` is ignored). The private key is never logged
  or returned. Share each spreadsheet with the service account's `client_email` (Editor to write). Spreadsheets
  created with a service account belong to it: share them from there, or create them as a user instead.
- **Precedence:** refresh trio, then service account. `GOOGLE_ACCESS_TOKEN` is used first when set, and a
  configured trio or service account takes over after a 401.
- A node can take `access_token` to use another account. That token is used as-is and is never refreshed. Pass it
  from a secret and trust the plugin (`--trust-plugin google-sheets`).

graphrt starts plugins with a clean environment, and only these variables are passed through.

## Quick Start
```bash
export GOOGLE_SERVICE_ACCOUNT_JSON=$HOME/keys/sheets-bot.json
graphrt run google-sheets/example.yaml --plugins .
```

## Usage
```yaml
- id: log
  type: google-sheets.append_rows
  spreadsheet_id: "1AbC..."
  sheet: "Orders 2026"
  rows: [["{{#start.order_id#}}", "{{#start.customer#}}", "new"]]
- id: mark_paid
  type: google-sheets.upsert_row
  spreadsheet_id: "1AbC..."
  sheet: "Orders 2026"
  key_column: "Order ID"
  record: { "Order ID": "{{#start.order_id#}}", "Status": "paid" }
```
- **`spreadsheet_id`** takes the id or the full spreadsheet URL (`https://docs.google.com/spreadsheets/d/<id>/edit`).
- **Ranges:** pass `sheet` (any title, quoted for you) and `range` with cells only (`A1:C10`, `A:C`, `2:5`), or
  `range` alone as a full A1 range (`'My Sheet'!A1:C`, `Sheet1!B2`) or a named range. With `sheet` and no
  `range`, the whole sheet is used. Ranges are checked loosely (A1 notation only, not R1C1).
- **Cells** are strings, numbers, booleans or null. With `USER_ENTERED` (default) values are parsed as if typed
  (`=SUM(A1:A3)` becomes a formula, `2026-11-18` a date); use `RAW` to store text as-is.
- **Formula injection:** with `USER_ENTERED`, text starting with `=`, `+`, `-` or `@` becomes a formula. When cells
  come from untrusted input (form fields, messages, scraped text), set `value_input_option: RAW` so they are stored
  as text, or a value like `=IMPORTXML(...)` or `=HYPERLINK(...)` runs in the sheet of everyone who opens it.
- **`clear_range`** needs `range`. To clear a whole sheet, pass `sheet` with `whole_sheet: true`: a `range` that
  renders empty from a template is refused instead of wiping the sheet.
- **`find_rows`** reads the whole sheet. Row 1 is the header: blank headers become the column letter, repeated
  headers get `_2`, `_3`. Filters compare trimmed, formatted text (case-insensitive unless `case_sensitive`).
  Results are `{row_number, record}`; `next_cursor` is an offset into the matches, so a sheet that changes
  between pages can shift results.
- **`upsert_row`** compares the key exactly (after trimming) with both the formatted cell text and the unformatted
  value, so `1234` matches a cell shown as `1,234`. A text key is written verbatim (under `USER_ENTERED` it is
  prefixed with `'`), so `+6281234567890`, `007` or `2026-11-18` stay text and match on the next upsert. Keys that
  were typed earlier and parsed by Sheets (`007` stored as the number 7) do not match their original text. It
  updates only the record's cells (other cells and formulas stay), or appends a new row aligned to the header.
- **`upsert_row` is not atomic.** It reads the sheet, then writes row N. Two concurrent upserts of the same new key
  can both append, and if rows are inserted, deleted or sorted above row N between the read and the write, the
  update lands on the wrong row. Run upserts against a sheet from one workflow at a time.
- **Polling:** graphrt plugins can't receive webhooks. To react to new rows, run a workflow on a schedule.

## Quota
Sheets allows 300 read and 300 write requests per minute per project, and 60 per minute per user. `find_rows`
makes one read; `upsert_row` makes two reads (the sheet, then the key column unformatted) and one write. Rate limits (429) are retried with backoff.

## Per-user tokens (multi-user agents)

Set `GOOGLE_SHEETS_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin google-sheets`):

```yaml
tools: [google-sheets/get_spreadsheet]
tool_context:
  google-sheets:
    access_token: "{{#start.google_sheets_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a Google OAuth access token of that user with the scopes this plugin needs.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `GOOGLE_ACCESS_TOKEN`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_SERVICE_ACCOUNT_JSON` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments or ranges, unknown columns, HTTP 400 (`INVALID_ARGUMENT`, `FAILED_PRECONDITION`) |
| `auth_error` | Missing, invalid or expired credentials, a rejected refresh token or service account key, unreadable key file |
| `permission_denied` | The account can't open the spreadsheet (share it), or the Sheets API is not enabled |
| `not_found` | Unknown spreadsheet |
| `rate_limited` | `RESOURCE_EXHAUSTED` / 429 (retried) |
| `api_error`, `network_error`, `timeout`, `cancelled` | As named; failed writes whose outcome is unknown are not retried and say how to check |

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it. `lib/google-auth.mjs`,
`lib/google-token-endpoint.mjs`, `lib/service-account.mjs` and `lib/google-errors.mjs` are kept identical to the
copies in `google-business-profile-api/`.

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** `create_spreadsheet` parameter `title` is now `spreadsheet_title`, and `add_sheet` parameter `title` is now `sheet_title` (both still sent to the Sheets API as `title`). graphrt takes `title` from every workflow node, so the old name could never be set from a node (the required field made the node fail to load); tool calls that passed `title` must use the new names.

## License
Apache-2.0
