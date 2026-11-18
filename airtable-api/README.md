# airtable-api

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **Airtable Web API**. It lists bases
and their schemas, lists, finds and reads records, and creates, updates, upserts and deletes records. Every
operation is a workflow node; all except `delete_records` are also agent tools.

## Features
- **Bases:** list the bases a token can access, read a base's tables, fields and views
- **Reading:** `list_records` (view, `filter_by_formula`, sort, fields, page size, max records), `get_record`
- **`find_records`:** match records on `{"Field": value}` without writing a formula; values are escaped so they can
  never change the formula (exact, case-insensitive or contains)
- **Writing:** create, update (PATCH) and upsert (merge on 1-3 fields) up to 10 records per call
- **`delete_records`:** workflow node only, so an agent can never delete records
- **`api_request`:** any other endpoint (GET only when called by an agent)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An Airtable **personal access token** ([airtable.com/create/tokens](https://airtable.com/create/tokens)) with the
  bases it may use and these scopes: `data.records:read`, `data.records:write` (for writes), `schema.bases:read`
  (for `list_bases` / `get_base_schema`)

## Installation
```bash
graphrt plugin install ./airtable-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `AIRTABLE_TOKEN` | yes | Personal access token (`pat...`) |
| `AIRTABLE_BASE_ID` | no | Default base (`app...`) when an operation has no `base_id`. When set, agent tools are limited to this base (see below) |
| `AIRTABLE_TOOL_ALLOWED_BASES` | no | Extra bases agent tools may use when `AIRTABLE_BASE_ID` is set, comma-separated (`appA...,appB...`); `*` allows any base |

graphrt starts plugins with a clean environment, and only these variables are passed through.

**Agent tool limits.** When `AIRTABLE_BASE_ID` is set, a tool call may only address that base and the bases in
`AIRTABLE_TOOL_ALLOWED_BASES`. Anything else, including an `api_request` path such as `/meta/bases/appX/tables`
or `/appX/Table`, fails `permission_denied`. Tool calls also always send `typecast: false`. Workflow nodes have
neither limit. A node can take
`access_token` to use another token. Pass it from a secret and trust the plugin (`--trust-plugin airtable-api`).

## Quick Start
```bash
export AIRTABLE_TOKEN=pat...
graphrt run airtable-api/example.yaml --plugins .
```
The example only calls `list_bases`; it changes nothing.

## Usage
```yaml
- id: existing
  type: airtable-api.find_records
  table: Leads
  where: { Email: "{{#start.email#}}" }
  match: case_insensitive
  limit: 1
- id: save
  type: airtable-api.upsert_records
  table: Leads
  fields_to_merge_on: [Email]
  records: '[{"fields": {"Email": "{{#start.email#}}", "Name": "{{#start.name#}}", "Stage": "New"}}]'
  typecast: true
```

### Tables, ids and pagination
- `table` is a table name or id (`tbl...`). Ids keep working after a rename.
- Base ids (`app...`) and record ids (`rec...`) are checked before any request.
- List operations take `limit` (page size, 1-100) and `cursor` and return `next_cursor` (Airtable's `offset`, null
  on the last page). An offset expires after a while: start again from the first page if Airtable says so.
- Reads use Airtable's `POST .../listRecords` endpoint, so long formulas and field lists need no URL encoding. It
  is a read and is retried like one.

### find_records
- `where: {"Email": "a@b.co", "Active": true}` matches records where every condition holds (at most 20).
- Text values compare against the field as text (`{Field} & ""`). Single selects, linked records and lookups
  therefore compare against their display text (several linked records read as `"A, B"`). Numbers and
  `true`/`false` compare exactly. `null` matches an empty field (`LEN({Field} & "") = 0`).
- Types are never guessed: a checkbox needs a JSON boolean (`true`), not the string `"true"`, and a number field a
  JSON number. A string always compares as text.
- `match`: `exact` (default), `case_insensitive`, or `contains` (case-insensitive substring). `contains` with `""`
  would match everything and fails `invalid_input`.
- **Escaping:** strings are double-quoted with `\"` escaped, and newlines and tabs become `\n` / `\t`. Other
  control characters (including `\r`) are refused. **Backslashes are refused** in values and field names, and so
  are field names containing `{`, `}` or control characters (Airtable has no escape for them inside a
  `{reference}`). For those, use `list_records` with your own `filter_by_formula` from a workflow node.
- The formula that was sent is returned as `data.filter_by_formula`.

### Writes and retries
- At most **10 records per call** (Airtable's limit). Larger batches fail `invalid_input`: split them.
- **No duplicate creates.** `create_records` is not retried after an unknown outcome (timeout, network error,
  5xx). The error is `retryable: false`. Check with `find_records` before creating again.
- `update_records` (PATCH: fields not sent are kept) and `upsert_records` set absolute values, so they are retried
  once after a 5xx. An upsert matches on `fields_to_merge_on`: no match creates, one match updates, several
  matches fail. Records with an `id` are plain updates. Every record needs a non-empty value for each merge field
  (otherwise `invalid_input`), and repeated merge field names are sent once.
- `typecast: true` lets Airtable convert strings, for example to create a missing select option. Workflow nodes
  only: agent tool calls always send `typecast: false`.
- `delete_records` (node only) is retried once after a 5xx or network error. If that retry answers 404/422, the
  first attempt already deleted the records, so the result is `{records: [{id, deleted: true}], already_absent:
  true}`. A not-found on the first attempt is still `not_found`.

### Rate limits
Airtable allows 5 requests per second per base (and 50 per second per token). A 429 means wait 30 seconds. The
plugin waits once, 30 s or the `Retry-After` when sent, and retries. A second 429 fails `rate_limited`
(`retryable: true`). A 429 means nothing was written, so this is safe for creates too.

## Errors
| Airtable | kind |
|----------|------|
| 401 `AUTHENTICATION_REQUIRED` | `auth_error` |
| 403 `INVALID_PERMISSIONS`, `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` | `permission_denied` (also a wrong base/table id or a token without that base) |
| 404 `NOT_FOUND`, `MODEL_ID_NOT_FOUND` | `not_found` |
| 400, 413, 422 (`INVALID_REQUEST_UNKNOWN`, `INVALID_MULTIPLE_CHOICE_OPTIONS`, ...) | `invalid_input` |
| 429 `RATE_LIMIT_REACHED` | `rate_limited` |
| 5xx (`RETRIABLE_ERROR`, ...) | `api_error` |

## License
Apache-2.0
