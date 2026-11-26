# pinecone

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Pinecone](https://docs.pinecone.io/reference/api)
vector database, API version `2026-07` (sent as `X-Pinecone-Api-Version`). It lists and describes indexes on the
control plane (`api.pinecone.io`), and queries, fetches, lists, upserts and updates vectors and documents on each
index's own data-plane host. It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)).

## Features
- **Indexes (control plane):** `list_indexes`, `describe_index`, `delete_index` (node only)
- **Stats and namespaces:** `describe_index_stats`, `list_namespaces`, `delete_namespace` (node only)
- **Vectors:** `query_vectors` (by vector or stored id, metadata filter), `fetch_vectors`, `fetch_vectors_by_metadata`,
  `list_vector_ids` (serverless), `upsert_vectors`, `update_vectors` (by id, or metadata by filter, with `dry_run`),
  `delete_vectors` (node only)
- **Documents (document indexes):** `search_documents` (`score_by` dense, sparse, text, query string or Pinecone-embedded
  text), `fetch_documents`, `list_documents`, `upsert_documents`, `update_documents`, `delete_documents` (node only)
- **Legacy integrated indexes:** `search_records` (Pinecone embeds `query_text`, optional rerank)
- **`api_request`:** other control-plane endpoints, e.g. `/indexes/<index_name>/backups` (agents: GET only, on an allowlist)

Lists page with `next_cursor` (Pinecone's `pagination.next`): pass it back as `cursor`. Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `api.pinecone.io` and your index hosts (`*.pinecone.io`)

## Installation
```bash
graphrt plugin install ./pinecone
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `PINECONE_API_KEY` | yes | Project API key (`Api-Key` header) |
| `PINECONE_INDEX_HOST` | for data-plane operations | Default index host, e.g. `docs-example-a1b2c3d.svc.aped-4627-b74a.pinecone.io` (`host` from `describe_index`). Every data-plane operation also takes `index_host` to override it per call. |
| `PINECONE_TOOL_ALLOW_WRITES` | no | `1` lets agent tools upsert and update vectors and documents |
| `PINECONE_TOOL_API_EXTRA_PATHS` | no | More GET paths for agent `api_request`, comma-separated, `*` = one segment |

**Index hosts are checked** because the API key is sent to them: `index_host` and `PINECONE_INDEX_HOST` must be a host
under `.pinecone.io` over https (no path). `http://localhost:<port>` for [Pinecone Local](https://docs.pinecone.io/guides/operations/local-development)
is accepted only from `PINECONE_INDEX_HOST`, never as an `index_host` argument (so neither an agent nor a templated
node value can send the key to a local service). Anything else is refused before a request is made.

**Getting a key:** [Pinecone console](https://app.pinecone.io) → your project → API keys → Create API key. A key belongs
to one project. Pinecone keys can be given limited permissions (e.g. data-plane read only); use the narrowest one
that fits the workflow.

**Pricing:** serverless indexes are billed by read units (queries, fetches, lists), write units (upserts, updates,
deletes), storage, and embedding/rerank tokens for integrated inference
([pinecone.io/pricing](https://www.pinecone.io/pricing/)). Reads and idempotent writes are retried after network
errors and 5xx, which may consume read/write units again. `upsert_documents` and `update_documents` embed text on
indexes with integrated embedding, which Pinecone meters on every request including retries, so these are never
retried automatically: after an "outcome unknown" error, check with `fetch_documents` before calling again. The same
holds for `search_documents` and `search_records`: their embed, text and rerank inputs are billed per request, so a
failed search is never retried automatically (the error says "outcome unknown: the search may have been billed; not
retried"; a search changes no data, so call again yourself if you want to pay for it).

**Rate limits:** per-project limits on reads, writes and control-plane calls depend on your plan; 429 is `rate_limited`.

## Quick Start
```bash
PINECONE_API_KEY=... graphrt run pinecone/example.yaml --plugins .
```
The example lists your indexes and reads the first index's stats from its host.

## Usage
```yaml
- id: matches
  type: pinecone.query_vectors
  index_host: my-index-abc123.svc.aped-4627-b74a.pinecone.io
  namespace: articles
  vector: "{{#embed.data.embedding#}}"
  top_k: 5
  filter: { lang: { $eq: "id" } }
- id: hybrid
  type: pinecone.search_documents
  namespace: articles
  top_k: 10
  score_by: [{ type: embed, fields: [content], query: "hujan deras di Jakarta" }]
  include_fields: [title, url]
```

## Agent policy
- **Reads** (indexes, stats, namespaces, query, fetch, list, document search) are agent tools.
- **Writes from agents are off by default:** `upsert_vectors`, `update_vectors`, `upsert_documents` and
  `update_documents` work as tools only with `PINECONE_TOOL_ALLOW_WRITES=1`. Workflow nodes are unaffected. Note that
  `update_vectors` / `update_documents` with a `filter` change every matching record.
- **Node only:** `delete_vectors`, `delete_documents`, `delete_namespace`, `delete_index` (bulk and irreversible).
- **`api_request`** is GET-only for agents, on the control plane only, and reaches only index, collection, backup and
  restore-job metadata (plus `PINECONE_TOOL_API_EXTRA_PATHS`).
- Tool results are truncated to 100,000 characters; nodes get everything.

## Errors
| Kind | When |
|---|---|
| `auth_error` | Missing or invalid API key (401, text body) |
| `permission_denied` | The key lacks the permission; an agent tool needs an opt-in or the operation is node only |
| `not_found` | Unknown index or namespace (`NOT_FOUND`) |
| `invalid_input` | Bad arguments, or an `index_host` / `PINECONE_INDEX_HOST` that is not a Pinecone host |
| `rate_limited` | 429 / `RESOURCE_EXHAUSTED` (retried with backoff) |
| `api_error` | Other failures; 5xx on reads are retried |

## Contributing
See the repository guide [docs/declarative-plugins.md](../docs/declarative-plugins.md). Run `npm run sync && npm test`
at the repo root.

## License
Apache-2.0
