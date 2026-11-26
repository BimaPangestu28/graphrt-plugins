# qdrant

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only against an unreachable host (network_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Qdrant](https://api.qdrant.tech/api-reference)
vector database REST API, on Qdrant Cloud or a self-hosted server. It reads collections, runs the universal Query API
(vector search, hybrid search with prefetch and fusion, recommendations, grouping), scrolls, retrieves and counts
points, and upserts points and payload. It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)).

## Features
- **Collections:** `list_collections`, `get_collection`, `collection_exists`, `list_aliases`, `create_collection`,
  `delete_collection` (node only)
- **Search and reads:** `query_points` (`/points/query`: `{"nearest": [...]}`, `{"nearest": <point id>}`,
  `{"recommend": ...}`, `{"fusion": "rrf"}` with `prefetch`, `{"order_by": ...}`), `query_points_groups`,
  `scroll_points`, `get_points`, `get_point`, `count_points`, `facet_counts`
- **Writes:** `upsert_points`, `set_payload`, `delete_points` (node only)
- **`api_request`:** other endpoints, e.g. `/collections/<collection_name>/optimizations` (agents: GET only, on an allowlist)

The older `/points/search`, `/points/recommend` and `/points/discover` endpoints are gone from the current API
reference; `query_points` covers them. `scroll_points` pages with `next_cursor` (Qdrant's `next_page_offset`, a point
id): pass it back as `cursor`. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Qdrant server (e.g. `docker run -p 6333:6333 qdrant/qdrant`) or a Qdrant Cloud cluster

## Installation
```bash
graphrt plugin install ./qdrant
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `QDRANT_URL` | no | Server URL, default `http://localhost:6333`. Cloud: `https://<cluster-id>.<region>.<cloud>.cloud.qdrant.io:6333`. Must be https unless the host is localhost. |
| `QDRANT_API_KEY` | for Cloud / secured servers | Sent as the `api-key` header; leave unset for a local server without auth |
| `QDRANT_TOOL_ALLOW_WRITES` | no | `1` lets agent tools create collections, upsert points and set payload |
| `QDRANT_TOOL_API_EXTRA_PATHS` | no | More GET paths for agent `api_request`, comma-separated, `*` = one segment |

**Getting a key:** Qdrant Cloud console → your cluster → API Keys → Create. Cloud keys can be read-only and limited to
collections; for agents that only search, use a read-only key. Self-hosted: set `QDRANT__SERVICE__API_KEY` (and
optionally `QDRANT__SERVICE__READ_ONLY_API_KEY`) on the server.

**Pricing:** self-hosted Qdrant is free. Qdrant Cloud bills per cluster resources (RAM, vCPU, disk) per hour, not per
request ([qdrant.tech/pricing](https://qdrant.tech/pricing/)); there is a free 1 GB cluster. Cloud inference
(queries with `{"text": ..., "model": ...}` inputs) is billed per token for paid models.

## Quick Start
```bash
docker run -p 6333:6333 qdrant/qdrant      # or use your Cloud cluster
graphrt run qdrant/example.yaml --plugins .
```
The example lists collections and shows the first one's point count and status.

## Usage
```yaml
- id: hits
  type: qdrant.query_points
  collection_name: articles
  query: { nearest: "{{#embed.data.embedding#}}" }
  filter: { must: [{ key: lang, match: { value: id } }] }
  result_limit: 5
- id: hybrid
  type: qdrant.query_points
  collection_name: articles
  prefetch:
    - { query: { indices: [1, 42], values: [0.2, 0.8] }, using: sparse, limit: 20 }
    - { query: "{{#embed.data.embedding#}}", using: dense, limit: 20 }
  query: { fusion: rrf }
```
Point ids are unsigned integers or UUID strings. Limit-like parameters are named `result_limit`, `group_limit` and
`facet_limit` (sent as Qdrant's `limit`). Writes wait for the change to be applied (`wait: true`) unless you pass
`wait: false`.

## Agent policy
- **Reads** are agent tools.
- **Writes from agents are off by default:** `create_collection`, `upsert_points` and `set_payload` work as tools only
  with `QDRANT_TOOL_ALLOW_WRITES=1`. `set_payload` with a `filter` changes every matching point. Workflow nodes are
  unaffected.
- **Node only:** `delete_points`, `delete_collection`.
- **`api_request`** is GET-only for agents and reaches only `/`, health checks, collections, aliases, collection
  optimization/shard info and single points (plus `QDRANT_TOOL_API_EXTRA_PATHS`): no snapshot downloads
  (a full copy of the data), telemetry, metrics, cluster or issues endpoints, and no per-collection cluster info
  (peer ids and shard placement).
- **Retries:** reads are retried after network errors and 5xx. `query_points` and `query_points_groups` are not
  retried when the query contains a server-side inference input (an object with `model` and `text`, `image` or
  `object`, in `query` or `prefetch`), because Qdrant Cloud inference and external embedding providers bill per
  request. The same holds for `upsert_points` when a point's `vector` is such an input (upserts of plain vectors
  are retried: writing the same points again is harmless). `create_collection` is not retried either (a retry could not tell a first-attempt create from an
  existing collection); check with `collection_exists`.
- Tool results are truncated to 100,000 characters; nodes get everything.

## Errors
| Kind | When |
|---|---|
| `auth_error` | Missing or invalid API key (401) |
| `permission_denied` | A read-only key writing (403); an agent tool needs an opt-in or the operation is node only |
| `not_found` | Unknown collection or point (404, Qdrant's `status.error` is in the message) |
| `invalid_input` | Bad arguments or filters (400/422), a remote `QDRANT_URL` without https |
| `network_error` | Server unreachable (reads and idempotent writes are retried) |
| `rate_limited` | 429 (retried with backoff) |

## Contributing
See the repository guide [docs/declarative-plugins.md](../docs/declarative-plugins.md). Run `npm run sync && npm test`
at the repo root.

## License
Apache-2.0
