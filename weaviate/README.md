# weaviate

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [Weaviate](https://docs.weaviate.io/), self-hosted
or Weaviate Cloud. Search (near text, near vector, near object, hybrid, BM25, filters, counts) goes through Weaviate's
GraphQL API with queries the plugin builds from structured arguments; objects and the schema go through the REST API
v1. It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)) plus two hand-written GraphQL
operations ([`lib/weaviate-extras.mjs`](lib/weaviate-extras.mjs)).

## Features
- **Search:** `search_objects`: one of `near_text`, `near_vector`, `near_object`, `hybrid_query` (with `alpha`,
  `fusion_type`, `hybrid_vector`) or `bm25_query` (with `search_properties`, `^` boosts), or none to list; `where`
  filters, `distance`, `target_vectors`, `limit`/`offset`/`autocut`, `after` cursor paging, `tenant`,
  `include_vector`. Each object has its properties and `_additional` (`id`, `distance` or `score`/`explainScore`,
  timestamps).
- **Counts:** `count_objects` (Aggregate `meta { count }`, optionally filtered)
- **Schema and cluster:** `get_meta`, `list_collections`, `get_collection`, `get_nodes_status`
- **Objects:** `list_objects` (UUID order, `next_cursor`), `get_object`, `create_object`, `update_object` (merge
  patch), `batch_objects`, `delete_object` (node only)
- **Raw GraphQL:** `graphql_query` (opt-in for agents)
- **`api_request`:** any other REST endpoint, e.g. `/v1/schema/<collection>/shards` (agents: GET only, on an allowlist)

Full reference: [OPERATIONS.md](OPERATIONS.md).

**About the APIs:** Weaviate has deprecated its GraphQL API. Weaviate Cloud switches it off on **May 1, 2027** (and
from December 1, 2026 on clusters unused for 30 days); self-hosted Weaviate keeps it until at least then. Its
replacement for plain HTTP, the REST Search API (`/v1/search/<collection>/near-text`, ..., Weaviate 1.39+), is still
experimental: off by default (`EXPERIMENTAL_REST_SEARCH_ENABLED`) and its shape may change, so this plugin uses GraphQL
today. Expect a switch of `search_objects`/`count_objects` to the REST Search API once it is stable.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Weaviate 1.x server reachable over HTTP(S), with the GraphQL API on (named vectors and `target_vectors` need a
  recent 1.2x release, `fusion_type` 1.20+)

## Installation
```bash
graphrt plugin install ./weaviate
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `WEAVIATE_URL` | no | Server URL, default `http://localhost:8080`; Weaviate Cloud: the cluster's REST endpoint (`https://<id>.<region>.weaviate.cloud`; a bare host gets `https://`). Plain `http://` only for localhost. |
| `WEAVIATE_API_KEY` | Cloud / auth enabled | API key, sent as `Authorization: Bearer`. Without it nothing is sent (anonymous local Weaviate). A node's `access_token` replaces it. |
| `WEAVIATE_PROVIDER_HEADERS` | no | Model provider keys for vectorizer/generative modules as JSON, e.g. `{"X-OpenAI-Api-Key": "sk-...", "X-Cohere-Api-Key": "..."}` (only `X-...` names; values are redacted) |
| `WEAVIATE_TOOL_ALLOW_WRITES` | no | `1` lets agent tools create, update and batch-import objects |
| `WEAVIATE_TOOL_ALLOW_RAW_GRAPHQL` | no | `1` lets agent tools run `graphql_query` |

**Getting an API key:** Weaviate Cloud console → your cluster → API Keys (create a read-only key for agents that only
search). Self-hosted: `AUTHENTICATION_APIKEY_*` settings or database users with RBAC roles.

**Pricing:** Weaviate itself does not bill per request (Weaviate Cloud bills by stored vectors/dimensions and plan).
But `near_text`, `hybrid_query` (without `hybrid_vector`), object creates, updates and imports into collections with a
vectorizer make Weaviate call your embedding provider (OpenAI, Cohere, ...), which bills per token; generative search
in raw GraphQL bills per LLM call. Those requests are never retried after a timeout.

## Quick Start
```bash
WEAVIATE_URL=https://<cluster>.weaviate.cloud WEAVIATE_API_KEY=... graphrt run weaviate/example.yaml --plugins .
```
The example shows the server version, the collections and three objects of the first one.

## Usage
```yaml
- id: related
  type: weaviate.search_objects
  collection: Article
  properties: [title, url]
  hybrid_query: "{{#start.question#}}"
  alpha: 0.6
  where: { path: [lang], operator: Equal, valueText: id }
  limit: 5
- id: save
  type: weaviate.create_object
  collection: Note
  object_uuid: "{{#start.note_id#}}"
  properties: { text: "{{#llm.text#}}" }
```
Filters use Weaviate's `where` shape: `{path, operator, valueText | valueInt | valueNumber | valueBoolean | valueDate
| valueGeoRange}`, combined with `{operator: And | Or | Not, operands: [...]}`. Paging: `limit` + `offset` for searches;
`after` (the last object's UUID) to walk a whole collection without a search, or `list_objects` with `next_cursor`.

## Agent policy
- **No GraphQL text from agents.** `search_objects` and `count_objects` build the document themselves: the collection,
  property, filter key and target vector names must be GraphQL names, filter operators and fusion types must be known
  enum values, UUIDs must be UUIDs, and every value is a literal. An argument cannot add fields (such as `generate`)
  or other queries.
- **Reads** are tools: searches, counts, objects, schema, meta and node status.
- **`api_request`** is GET-only for agents and reaches only an allowlist: `/v1/meta`, `/v1/schema` (collections,
  shards, tenants), `/v1/nodes`, `/v1/objects`, `/v1/aliases`, `/v1/classifications/<id>` and `/v1/.well-known/ready|live`.
  RBAC (`/v1/authz`), users (`/v1/users`, which manages database user API keys), backups, replication and cluster
  internals are refused (paths are decoded and normalised before matching). Workflow nodes can call anything.
- **Raw GraphQL needs an opt-in:** `graphql_query` works as a tool only with `WEAVIATE_TOOL_ALLOW_RAW_GRAPHQL=1`
  (Weaviate GraphQL has no mutations, but generative search and vectorizers bill your provider).
- **Writes need an opt-in:** `create_object`, `update_object` and `batch_objects` work as tools only with
  `WEAVIATE_TOOL_ALLOW_WRITES=1`.
- **Node only:** `delete_object`.

## Errors
| Situation | Kind |
|---|---|
| 401 (missing or bad API key) | `auth_error` |
| 403 (key without the permission) | `permission_denied` |
| 404 (collection, object or cluster not found) | `not_found` |
| 400/422 (bad filter, unknown property, invalid object) | `invalid_input` |
| GraphQL `errors` in a 200 response | `api_error` with Weaviate's message |
| 429 | `rate_limited` |
| Bad arguments refused before any request (names, operators, UUIDs, two search modes) | `invalid_input` |
| Agent tool refused by policy | `permission_denied` |

Messages are Weaviate's `error[].message` (REST) or `errors[].message` (GraphQL).

## License
Apache-2.0
