# chroma

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [Chroma](https://docs.trychroma.com) over its HTTP
API v2 (OpenAPI: [api.trychroma.com/openapi.json](https://api.trychroma.com/openapi.json)), for a local or self-hosted
server or Chroma Cloud. It lists and creates collections, gets, queries and searches records, and adds, upserts and
updates them. It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)).

## Features
- **Server:** `heartbeat`, `get_identity` (tenant and databases of the token)
- **Collections:** `list_collections`, `count_collections`, `get_collection` (by name; returns the `id`),
  `create_collection` (get-or-create by default), `delete_collection` (node only)
- **Records (by collection id):** `count_records`, `get_records` (ids, `where`, `where_document`), `query_records`
  (nearest neighbours of query embeddings), `search_records` (Search API with rank expressions such as `$knn`),
  `add_records`, `upsert_records`, `update_records`, `delete_records` (node only)
- **`api_request`:** other GET endpoints of the database, e.g. `/collections/<collection_id>/indexing_status`
  (agents: GET only, on an allowlist)

Collections are addressed **by name** for get/delete and **by id** (UUID) for record operations, matching the server's
routes; take the id from `get_collection` or `list_collections`. **Unverified live:** addressing get/delete by
collection name follows the Chroma server source (the route looks the collection up by name), while the OpenAPI
docs label that path parameter as a UUID; this plugin has not been run against a live Chroma server. If your
server answers `not_found` for an existing collection name there, use `api_request` with the collection id and
report it. The HTTP API does not compute embeddings: send
`embeddings` with adds/upserts and `query_embeddings` with queries (e.g. from an embeddings plugin). Results are
columnar (`ids`, `documents`, `metadatas`, `distances` arrays; one inner list per query embedding for queries).
`list_collections` pages by offset: pass `next_cursor` back as `cursor`. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Chroma server >= 1.0 (`chroma run` or `docker run -p 8000:8000 chromadb/chroma`), or a Chroma Cloud database

## Installation
```bash
graphrt plugin install ./chroma
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `CHROMA_URL` | no | Server URL, default `http://localhost:8000`; Chroma Cloud: `https://api.trychroma.com`. Must be https unless the host is localhost. |
| `CHROMA_API_KEY` | for Cloud / secured servers | Token, sent as `x-chroma-token`; leave unset for a local server without auth |
| `CHROMA_AUTH_HEADER` | no | `authorization` to send the token as `Authorization: Bearer` (servers configured for bearer tokens) |
| `CHROMA_TENANT` | no | Tenant, default `default_tenant` (Chroma Cloud: your tenant id) |
| `CHROMA_DATABASE` | no | Database, default `default_database` |
| `CHROMA_TOOL_ALLOW_WRITES` | no | `1` lets agent tools create collections and add, upsert and update records |
| `CHROMA_TOOL_API_EXTRA_PATHS` | no | More GET paths (relative to the database) for agent `api_request`, comma-separated, `*` = one segment |

Collection and record operations are scoped to `CHROMA_TENANT` / `CHROMA_DATABASE`; neither nodes nor agents can
switch to another database per call.

**Getting a key:** Chroma Cloud dashboard → your database → Settings / API keys → Create; the connection snippet shows
the tenant id and database name. Self-hosted servers can enable token auth (`x-chroma-token` or bearer); without it,
anyone who can reach the port can read and write.

**Pricing:** self-hosted Chroma is free. Chroma Cloud bills usage (data written, stored and queried) per its
[pricing page](https://www.trychroma.com/pricing). Reads and idempotent writes are retried after network errors and
5xx, which can count as usage again.

## Quick Start
```bash
chroma run --path ./chroma-data      # or docker run -p 8000:8000 chromadb/chroma
graphrt run chroma/example.yaml --plugins .
```
The example checks the server, lists collections and counts the first collection's records.

## Usage
```yaml
- id: collection
  type: chroma.get_collection
  collection_name: articles
- id: hits
  type: chroma.query_records
  collection_id: "{{#collection.data.id#}}"
  query_embeddings: ["{{#embed.data.embedding#}}"]
  n_results: 5
  where: { lang: id }
```
Limit-like parameters of `get_records` are named `record_limit` / `record_offset` (sent as `limit` / `offset`).

## Agent policy
- **Reads** are agent tools.
- **Writes from agents are off by default:** `create_collection`, `add_records`, `upsert_records` and `update_records`
  work as tools only with `CHROMA_TOOL_ALLOW_WRITES=1`. Workflow nodes are unaffected.
- **Node only:** `delete_records` (a `where` filter can delete many records), `delete_collection`.
- **`api_request`** is GET-only for agents and reaches only the configured database's collection list, count,
  collections and their count/indexing status (plus `CHROMA_TOOL_API_EXTRA_PATHS`).
- Tool results are truncated to 100,000 characters; nodes get everything.

## Errors
| Kind | When |
|---|---|
| `auth_error` | Missing or invalid token (401) |
| `permission_denied` | Token without access (403); an agent tool needs an opt-in or the operation is node only |
| `not_found` | Unknown collection (`NotFoundError`) |
| `invalid_input` | Bad arguments (`InvalidArgumentError`, 400/422), bad `CHROMA_AUTH_HEADER`, remote `CHROMA_URL` without https |
| `network_error` | Server unreachable |
| `rate_limited` | 429 (Chroma Cloud quotas; retried with backoff) |

## Contributing
See the repository guide [docs/declarative-plugins.md](../docs/declarative-plugins.md). Run `npm run sync && npm test`
at the repo root.

## License
Apache-2.0
