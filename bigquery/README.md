# bigquery

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for **Google BigQuery** (API v2). It lists datasets and
tables, reads schemas and runs parameterised GoogleSQL with a hard bytes-billed cap. Agent tools only run `SELECT`
statements, checked with a free dry run. No npm dependencies; Google auth is the same code as the google-sheets
plugin (byte-identical copies in `lib/`).

## Features
- **`list_datasets`**, **`list_tables`** (paginated) and **`get_table`** (schema with nested fields flattened to
  `a.b`, row and byte counts, partitioning, clustering).
- **`query`:** (a job with a plugin-chosen id) one GoogleSQL statement with `@named` (object) or `?` (array) parameters. Returns `rows` as objects,
  the `schema`, `total_rows`, bytes processed, `cache_hit`, `affected_rows` for DML and `next_cursor`.
  `dry_run: true` validates the SQL and estimates bytes for free (statement type, schema, referenced tables).
- **`get_query_results`:** the next page from a `next_cursor`, or the rows of a query that was still running.
- **Values:** INT64 is a number when exact, else a string; NUMERIC/BIGNUMERIC are strings; TIMESTAMP is ISO 8601
  with microseconds; JSON is parsed; RECORD/REPEATED nest; DATE, TIME, DATETIME, GEOGRAPHY and BYTES (base64) are
  strings. Parameters infer STRING, INT64, FLOAT64, BOOL and ARRAY<T>; pass `{"type": "DATE", "value": "2026-11-01"}`
  (or NUMERIC, TIMESTAMP, `ARRAY<STRING>`, ...) for the rest.
- Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- A Google Cloud project with the BigQuery API enabled, and credentials (see Configuration). Grant the least you
  need: for agents, `roles/bigquery.jobUser` on the project plus `roles/bigquery.dataViewer` on specific datasets.

## Installation
```bash
graphrt plugin install ./bigquery
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | (none) | Path to a service account key file (recommended for servers) |
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | (none) | OAuth refresh-token grant (scope `https://www.googleapis.com/auth/bigquery`) |
| `GOOGLE_ACCESS_TOKEN` | (none) | A ready access token (used first; replaced by a configured grant after a 401) |
| `BIGQUERY_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`) | (none) | Default project for every call; `project_id` overrides it per call |
| `BIGQUERY_LOCATION` | (auto) | Default job location, e.g. `US`, `EU`, `asia-southeast1` |
| `BIGQUERY_MAX_BYTES_BILLED` | `1073741824` (1 GiB) | Bytes-billed cap sent with **every** query. A call's `maximum_bytes_billed` may lower it, never raise it. |
| `BIGQUERY_MAX_RESULT_BYTES` | `2000000` | Most JSON bytes of rows per call; the rest comes with `next_cursor` |
| `BIGQUERY_QUERY_TIMEOUT_MS` | `30000` | How long `query` waits for results by default (`wait_ms` up to 90000) |
| `BIGQUERY_TOOL_ALLOW_WRITES` | (off) | `1` lets agent tools run DML, DDL and scripts (and skips the dry-run check) |

A node's `access_token` (from a workflow secret, with `--trust-plugin bigquery`) replaces the credentials for that
node. Agent tools never choose credentials.

## Quick Start
```bash
export GOOGLE_SERVICE_ACCOUNT_JSON=$HOME/keys/bq-reader.json BIGQUERY_PROJECT_ID=my-project
graphrt run bigquery/example.yaml --plugins .
```

## Usage
```yaml
- id: revenue
  type: bigquery.query
  sql: "SELECT DATE(created_at) AS day, SUM(total) AS revenue FROM shop.orders WHERE created_at >= @since GROUP BY day ORDER BY day"
  params: { since: { type: "TIMESTAMP", value: "2026-11-01 00:00:00+07" } }
  maximum_bytes_billed: 500000000
- id: more
  type: bigquery.get_query_results
  cursor: "{{#revenue.next_cursor#}}"
```

## Safety
- **Cost cap on every query:** `maximumBytesBilled` is always sent (BigQuery fails a query that would bill more, and
  bills nothing for it). A `maximum_bytes_billed` above `BIGQUERY_MAX_BYTES_BILLED` is refused.
- **Agent tools run SELECT only:** before a tool query runs, a dry run (free) reports its statement type; anything
  but `SELECT` (INSERT, UPDATE, DELETE, MERGE, CREATE/DROP/ALTER, scripts, EXPORT DATA, ...) is refused with
  `permission_denied` unless `BIGQUERY_TOOL_ALLOW_WRITES=1`. A tool query whose dry run already exceeds the cap is
  refused before it runs. Nodes may run any statement (still capped).
- **Least privilege is the real boundary:** give agent workflows a service account with `bigquery.jobUser` and
  `bigquery.dataViewer` only, so even an opted-in tool cannot change data.
- **No `api_request`:** a generic endpoint would allow queries without the cap.
- **SELECT is not free of side effects:** a SELECT can still call remote functions (Cloud Functions/Run behind
  `CREATE FUNCTION ... REMOTE`), `ML.GENERATE_TEXT`, `ML.PREDICT` on remote models and `AI.*` functions, which call
  other services and are billed separately (Vertex AI), outside `maximum_bytes_billed`. Do not grant the agent's
  service account access to remote connections or models it should not use.
- **Jobs:** `query` inserts a job with an id the plugin chose, so a retry after a network error or 5xx cannot start
  a second job (409 Already Exists means the first insert worked). When a call is aborted (or its tool deadline
  passes) while the job runs, the job is cancelled in the background. Agent tools may only page through jobs an
  agent tool call started in the same plugin process; other job ids are node only.
- **Secrets:** tokens, refresh tokens, client secrets and signed assertions are redacted from errors.

## Costs
On-demand queries bill per TiB scanned (minimum 10 MB per table referenced); dry runs and cached results are free.
Use partition filters and select only the columns you need. See the BigQuery pricing page.

## License
Apache-2.0
