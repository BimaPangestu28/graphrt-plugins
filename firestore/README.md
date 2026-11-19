# firestore

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **Google Cloud Firestore** (native mode) over the
REST API v1. Documents are read and written as plain JSON; the plugin converts to and from Firestore's typed values.
No npm dependencies; Google auth is the same code as the google-sheets plugin (byte-identical copies in `lib/`).

## Features
- **Reads:** `get_document`, `list_documents` (paginated, `order_by`, field `mask`) and `run_query` (one collection
  or a collection group, `where` filters combined with AND, `order_by`, `select`, `limit`, `offset`).
- **Writes:** `create_document` (fails if it exists; give `document_id` so a retry cannot create a duplicate),
  `update_document` (merge the given top-level fields and remove `delete_fields`, or replace the whole document;
  `must_exist` by default) and `delete_document` (node only).
- **Values** (`value_format: "plain"`, the default): null, booleans, integers, doubles, strings, arrays and maps map
  to their Firestore types. Other types use Firestore's own one-key form: `{"timestampValue": "2026-11-19T10:00:00Z"}`,
  `{"bytesValue": "<base64>"}`, `{"referenceValue": "projects/p/databases/(default)/documents/users/u1"}`,
  `{"geoPointValue": {"latitude": -6.2, "longitude": 106.8}}`, `{"integerValue": "9007199254740993"}` (exact int64),
  `{"doubleValue": 2}` (a whole-number double). Read back, integers too large for a JSON number stay strings,
  timestamps are RFC 3339 text. `value_format: "typed"` passes Firestore Value JSON through in both directions.
- **Filter operators:** `==`, `!=`, `<`, `<=`, `>`, `>=`, `array-contains`, `in`, `array-contains-any`, `not-in`
  (or the API names such as `GREATER_THAN`), and `IS_NULL`, `IS_NOT_NULL`, `IS_NAN`, `IS_NOT_NAN` without a value.
- Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- A Google Cloud project with Firestore in native mode and credentials. For read-only agents use a service account
  with `roles/datastore.viewer`; `roles/datastore.user` allows writes.

## Installation
```bash
graphrt plugin install ./firestore
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | (none) | Path to a service account key file |
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | (none) | OAuth refresh-token grant (scope `https://www.googleapis.com/auth/datastore`) |
| `GOOGLE_ACCESS_TOKEN` | (none) | A ready access token (used first; replaced by a configured grant after a 401) |
| `FIRESTORE_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`) | (required) | Project id |
| `FIRESTORE_DATABASE` | `(default)` | Database id for named databases |
| `FIRESTORE_MAX_RESULT_BYTES` | `4000000` | Most JSON bytes per call (1000 to 32000000). `list_documents` and `run_query` keep whole documents and report `truncated` and `omitted_count` (the omitted ones are skipped, so use a smaller `limit` or a `mask`/`select`); a single `get_document` over the cap returns only its metadata and `field_names` with `truncated: true`. |
| `FIRESTORE_TOOL_ALLOW_WRITES` | (off) | `1` lets agent tools call `create_document` and `update_document` |

A node's `access_token` (from a workflow secret, with `--trust-plugin firestore`) replaces the credentials for that
node. Agent tools never choose credentials.

## Quick Start
```bash
export GOOGLE_SERVICE_ACCOUNT_JSON=$HOME/keys/firestore-reader.json FIRESTORE_PROJECT_ID=my-project
graphrt run firestore/example.yaml --plugins .
```

## Usage
```yaml
- id: vip_orders
  type: firestore.run_query
  collection_id: orders
  where:
    - { field: customer_tier, op: "==", value: vip }
    - { field: total, op: ">=", value: 1000000 }
  order_by: ["total desc"]
  limit: 20
- id: note
  type: firestore.update_document
  path: "orders/{{#vip_orders.data.documents.0.id#}}"
  fields: { followed_up: true, followed_up_at: { timestampValue: "2026-11-19T10:00:00Z" } }
```
Composite filters and ordering on several fields need a composite index; Firestore's error message links to the
index it needs.

## Safety
- **Agent tools are read-only by default:** `get_document`, `list_documents` and `run_query` are tools.
  `create_document` and `update_document` are refused for tools unless `FIRESTORE_TOOL_ALLOW_WRITES=1`.
  `delete_document` is node only (and never deletes subcollections).
- **IAM is the real boundary:** give agent workflows a service account with `roles/datastore.viewer`.
- **Paths:** every path segment is encoded on its own; empty, `.` and `..` segments are refused.
- **Retries:** reads and updates (same fields, same result) are retried after 5xx and network errors. A create is
  not, and its error says how to check whether it happened.
- **Secrets:** tokens, refresh tokens, client secrets and signed assertions are redacted from errors.

## Costs
Firestore bills document reads, writes and deletes (`offset`-skipped documents count as reads) and storage. See the
Firestore pricing page.

## License
Apache-2.0
