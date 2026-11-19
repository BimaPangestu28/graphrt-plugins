# supabase

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only against an unreachable host (network_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for one [Supabase](https://supabase.com) project:
table rows through the Data API ([PostgREST](https://docs.postgrest.org/en/stable/)) and files through
[Supabase Storage](https://supabase.github.io/storage/). Filters are structured and safely encoded, so values can
never inject PostgREST operators or extra conditions. It is built with the declarative REST layer
([`definition.mjs`](definition.mjs)).

## Features
- **Rows:** `select_rows` (filters, columns incl. related tables, order, `limit`/`cursor` paging), `insert_rows`,
  `upsert_rows` (merge or ignore duplicates, `on_conflict`), `update_rows` and `delete_rows` (node only), both
  requiring at least one filter
- **Functions:** `call_function` (RPC `POST /rest/v1/rpc/<name>` with named arguments)
- **Schema:** `get_api_schema` (OpenAPI of the exposed tables and functions; needs a secret or `service_role` key
  since Supabase removed anon access in February 2026)
- **Storage:** `list_buckets`, `get_bucket`, `list_objects`, `get_object_info`, `download_object` (into
  `SUPABASE_DOWNLOAD_DIR`), `upload_object`, `delete_objects` (node only), `create_signed_url` (node only)
- **`api_request`:** any other project endpoint (agents: GET only, `/rest/v1` and Storage reads only)

Full reference: [OPERATIONS.md](OPERATIONS.md).

### Filters
`filters` is a list of conditions that must all match:
```yaml
filters:
  - { column: status, operator: eq, value: open }
  - { column: due, operator: lt, value: "2026-12-01" }
  - { column: id, operator: in, value: [1, 2, 3] }
  - { column: deleted_at, operator: is, value: null }
  - { column: title, operator: ilike, value: "*invoice*" }
  - { column: status, operator: eq, value: archived, negate: true }
  - { column: body_tsv, operator: fts, value: "cat & dog", language: english }
  - { column: data->>city, operator: eq, value: Bandung }
```
Operators: `eq neq gt gte lt lte like ilike match imatch in is isdistinct fts plfts phfts wfts cs cd ov sl sr nxr
nxl adj`. They are sent as one `and=(col.op."value",...)` group. Every value is wrapped in double quotes with `\`
and `"` escaped (PostgREST's rule for reserved characters), so `a,b` or `x"),or(id.gt.0` stay one literal value.
Columns must be identifiers (JSON paths with `->`/`->>` allowed), `is` only takes `null`/`true`/`false`/`unknown`,
and `order` must be `column[.asc|.desc][.nullsfirst|.nullslast]` terms. For array and range operators (`cs`, `ov`,
...), pass the Postgres literal as the value, e.g. `"{a,b}"` or `"[2026-01-01,2026-02-01)"`.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Supabase project (hosted, self-hosted, or local `supabase start`)

## Installation
```bash
graphrt plugin install ./supabase
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | yes | Project URL: `https://<project-ref>.supabase.co`, a custom https domain, or `http://127.0.0.1:54321` locally. Origin only (no `/rest/v1`). |
| `SUPABASE_KEY` | yes | API key, sent as `apikey`: a publishable key (`sb_publishable_...`) or secret key (`sb_secret_...`); legacy `anon`/`service_role` JWTs also work (they are sent as Bearer too). |
| `SUPABASE_USER_JWT` | no | A signed-in user's access token, sent as `Authorization: Bearer`, so row level security sees that user |
| `SUPABASE_TOOL_ALLOW_WRITES` | no | `1` lets agent tools insert, upsert, update, upload and call functions |
| `SUPABASE_DOWNLOAD_DIR` | for downloads | Absolute directory for `download_object` |
| `SUPABASE_UPLOAD_DIR` | for local uploads | Directory that local `upload_object` files must be inside (https URLs work without it) |
| `SUPABASE_TOOL_API_EXTRA_PATHS` | no | More read paths for agent `api_request`, comma-separated, `*` = one segment |

**Getting a key:** Supabase dashboard → Project Settings → API Keys. Copy the project URL and the publishable key.
Create a secret key only for trusted backend workflows.

> **Warning: secret and `service_role` keys bypass row level security.** Every policy is skipped (the role has
> `BYPASSRLS`); only table grants still apply. With such a key, any workflow or agent using this plugin can read and
> (with the opt-in) change every exposed table. For agents, prefer a publishable key (optionally with
> `SUPABASE_USER_JWT`) and RLS policies that limit what that role can see.

A node may pass `access_token` to use another API key for that node; agent tools never can.

**Pricing and limits:** API requests are not billed per call, but egress, storage and database size count toward your
plan's quotas. Rate limits depend on the plan and on Auth/Storage settings; 429 is `rate_limited`.

## Quick Start
```bash
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_KEY=sb_publishable_... \
  graphrt run supabase/example.yaml --plugins .
```
The example lists buckets and reads the newest rows of a `todos` table (change it to one of yours).

## Usage
```yaml
- id: open_todos
  type: supabase.select_rows
  table: todos
  columns: id,title,owner:profiles(name)
  filters: [{ column: status, operator: eq, value: open }]
  order: created_at.desc
  limit: 20
- id: close
  type: supabase.update_rows
  table: todos
  values: { status: done }
  filters: [{ column: id, operator: eq, value: "{{#open_todos.data.0.id#}}" }]
```
Results are PostgREST's JSON rows; writes return the written rows (`Prefer: return=representation`), and inserts use
column defaults for keys a row leaves out (`missing=default`).

## Agent policy
- **Reads** (`select_rows`, `get_api_schema`, storage lists, info and downloads) are agent tools. PostgREST runs
  GET requests in read-only transactions.
- **Writes need `SUPABASE_TOOL_ALLOW_WRITES=1`:** `insert_rows`, `upsert_rows`, `update_rows`, `upload_object`
  and `call_function` (a function may write, and POST runs volatile functions read-write).
- **Tool uploads never overwrite:** `upload_object` with `upsert: true` is refused for tools.
- **Node only:** `delete_rows`, `delete_objects`, and `create_signed_url` (anyone with the link can read the file).
- **`update_rows` and `delete_rows` need at least one filter**, for nodes too, so a missing filter never changes or
  deletes a whole table.
- **`api_request`** is GET-only for agents and reaches only `/rest/v1/...` and Storage reads (`/storage/v1/bucket`,
  `/storage/v1/object/...`). Auth admin (`/auth/v1/admin/users`), Edge Functions (`/functions/v1`, which run code
  with your key), GraphQL and other services are refused; extend with `SUPABASE_TOOL_API_EXTRA_PATHS`.

## Errors
PostgREST errors (`{code, message, details, hint}`) and Storage errors (`{statusCode, error, message}`) keep their
message and code. `Invalid API key` (401) and JWT errors (`PGRST301`-`PGRST303`, `InvalidJWT`) are `auth_error`;
`42501` (insufficient privilege, e.g. RLS) is `permission_denied`; unknown tables/functions (`PGRST205`, `PGRST202`),
buckets and objects are `not_found`. Failed writes are never retried blindly: their error says how to check.

## License
Apache-2.0
