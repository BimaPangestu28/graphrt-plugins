# notion-api

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the official **Notion API** (REST, `Notion-Version: 2026-03-11`).
It searches a workspace, reads and creates pages, updates their properties, queries databases, reads page
content, appends paragraphs and adds comments. Every operation is a workflow node and an agent tool.

## Features
- **Search** pages and data sources shared with the integration
- **Pages:** get, get one property in full (paginated), create (in a database or under a page), update properties,
  move to the trash and restore (`archive_page` / `restore_page`)
- **Simple property values:** `values: {"Stage": "Won", "Price": 1200, "Due": "2026-11-20"}` is turned into
  Notion JSON using the database's schema; raw Notion JSON in `properties` works for every property type
- **Databases:** get a database, get a data source (the table schema), query with Notion filters and sorts
- **Content:** read child blocks, append plain-text paragraphs (≤ 100 per call), comment on a page, block or thread
- **`api_request`:** any other endpoint (GET only when called by an agent)
- Page ids can be given as ids (with or without dashes) or as Notion page URLs

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Notion **internal integration** ([notion.so/profile/integrations](https://www.notion.so/profile/integrations)) with
  the capabilities you need (read content, update content, insert content, read/insert comments)
- Share each page or database with the integration (page ••• menu > Connections). Anything not shared answers
  `not_found`.

## Installation
```bash
graphrt plugin install ./notion-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `NOTION_TOKEN` | yes | Internal integration secret (`ntn_...`) |
| `NOTION_TOOL_ALLOW_PEOPLE` | no | `1` lets agent tools set people properties (which notifies those people). Default: refused |

graphrt starts plugins with a clean environment, and only these variables are passed through. A node can take
`access_token` to use another integration's secret. Pass it from a secret and trust the plugin (`--trust-plugin notion-api`).

## Quick Start
```bash
export NOTION_TOKEN=ntn_...
graphrt run notion-api/example.yaml --plugins .
```
The example only calls `search`; it changes nothing.

## Usage
```yaml
- id: lead
  type: notion-api.create_page
  database_id: "https://www.notion.so/acme/Leads-0123456789abcdef0123456789abcdef"
  values:
    Name: "{{#start.company#}}"
    Stage: Lead
    Tags: [inbound, jakarta]
    Email: "{{#start.email#}}"
    Follow up: "2026-11-25"
  paragraphs: ["First contact via the website form."]
- id: open_deals
  type: notion-api.query_database
  database_id: "0123456789abcdef0123456789abcdef"
  filter: '{"property": "Stage", "select": {"does_not_equal": "Won"}}'
  sorts: '[{"property": "Follow up", "direction": "ascending"}]'
  limit: 50
```

### Databases and data sources
- Since `Notion-Version` 2025-09-03 a database holds one or more **data sources** (tables). Queries, schemas and
  new database pages belong to a data source, so this plugin uses `/v1/data_sources/{id}/query` and creates pages
  with a `data_source_id` parent.
- You can still pass `database_id`: the plugin reads the database and uses its data source when there is exactly
  one. With several, it fails `invalid_input` and lists each data source's name and id; pass `data_source_id`.

### Property values (`values`)
| Notion type | `values` accepts | Sent as |
|-------------|------------------|---------|
| title, rich_text | text (numbers and booleans become text) | rich text, cut into 2000-character pieces |
| number | number or plain decimal string (`"1500"`, `"-12.5"`; not `"0x10"` or `"1e3"`) | `{number}` |
| select, status | option name (≤ 100 characters); `""` clears a select | `{select: {name}}` / `{status: {name}}` |
| multi_select | array of strings, or one comma-separated string (`"vip, jakarta"`); names are trimmed and may not be empty | `[{name}, ...]` |
| date | `"2026-11-20"`, `"2026-11-20T09:00:00+07:00"` or `{start, end, time_zone}` | `{date: ...}` |
| checkbox | true/false (or "true"/"false"); `null` unchecks | `{checkbox}` |
| url, email, phone_number | string (≤ 2000 characters); `""` clears | the string |

- `null` clears a property; for a checkbox that means unchecked (`false`).
- Other types (people, relation, files, ...) go in `properties` as Notion JSON. `properties` wins over `values` for
  the same name.
- **People:** assigning a person notifies them, so agent tools may not set people properties (in `properties` or
  `values`) unless `NOTION_TOOL_ALLOW_PEOPLE=1`; otherwise the call fails `permission_denied`. Workflow nodes are
  not restricted.
- A page created under another page only has a title: use `values: {"title": "..."}`.
- Unknown property names fail `invalid_input` with the list of names. Reading the schema costs one extra GET.

### Pagination
List operations take `limit` (1-100) and `cursor` and return `next_cursor` (null on the last page).

### Writes and retries
- **No duplicate creates.** `create_page`, `append_paragraphs` and `add_comment` are not retried after an unknown
  outcome (timeout, network error, 5xx). The error is `retryable: false` and says how to check first.
- A 429 (rate limited: about 3 requests per second) or 529 means nothing was written. It is retried after
  Notion's `Retry-After`. A 409 `conflict_error` is also retried.
- `update_page_properties`, `archive_page` and `restore_page` set absolute values, so they are retried like reads.
- `archive_page` moves the page to the trash (`in_trash: true`, Notion's name since 2026-03-11 for `archived`).
  It can be undone with `restore_page`, so it is available to agents.

## Per-user tokens (multi-user agents)

Set `NOTION_API_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin notion-api`):

```yaml
tools: [notion-api/search]
tool_context:
  notion-api:
    access_token: "{{#start.notion_api_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a Notion public integration (OAuth) access token of that user's workspace.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `NOTION_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
| Notion code | kind |
|-------------|------|
| `unauthorized` (401) | `auth_error` |
| `restricted_resource` (403) | `permission_denied` (the integration lacks a capability) |
| `object_not_found` (404) | `not_found` (also when the page isn't shared with the integration) |
| `validation_error`, `invalid_json`, `invalid_request`, `missing_version` (400) | `invalid_input` |
| `rate_limited` (429), `service_overload` (529) | `rate_limited` |
| other 5xx | `api_error` |

## Limits
- Rich text pieces up to 2000 characters, at most 100 per value (200,000 characters).
- At most 100 paragraphs and 400,000 characters of paragraph text per `append_paragraphs` / `create_page` call,
  checked locally (Notion caps a request at 500KB). Split longer content over several calls.
- Page URLs: a peek URL (`...?v=<view>&p=<page>`) refers to the page in `p`; otherwise the last id in the path
  (32 hex characters or a dashed UUID) is used.
- The query endpoint's `filter_properties` (a repeated query parameter) is not supported. Use `api_request` with it in the path, e.g. `/pages/{id}?filter_properties=title&filter_properties=abc`.

## License
Apache-2.0
