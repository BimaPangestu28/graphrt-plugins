# elasticsearch

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[Elasticsearch REST API](https://www.elastic.co/docs/api/doc/elasticsearch/): Query DSL search, counts, ES|QL, getting
and writing documents, and index metadata. It works with self-managed clusters (8.x and 9.x), Elastic Cloud
deployments and Elastic Cloud Serverless. It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)).

## Features
- **Cluster and indices:** `get_cluster_info`, `get_cluster_health`, `list_indices` (`_cat/indices` as JSON, open
  and closed indices; hidden and system indices are left out), `get_mapping`
- **Search:** `search` (Query DSL, sort, `search_after`, `_source` filtering, aggregations, highlight, kNN), `count`,
  `esql_query` (ES|QL with `?` parameters; agents need an opt-in)
- **Documents:** `get_document`, `multi_get`, `index_document` (PUT by id), `create_document` (generated id),
  `update_document` (partial `doc` merge, optional upsert; no scripts), `delete_document` (node only),
  `delete_by_query` (node only), `bulk` (NDJSON lines, node only)
- **`api_request`:** any other endpoint, e.g. `/<index>/_settings` (agents: GET only, on an allowlist)

Search and count are sent as `POST` with a JSON body (Elasticsearch accepts both; Node's fetch cannot send a body
with `GET`). They change nothing, so they are retried like reads. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to the cluster

## Installation
```bash
graphrt plugin install ./elasticsearch
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `ELASTICSEARCH_URL` | no | Cluster URL, default `http://localhost:9200`. Must be `https://` (plain `http://` only for localhost); no credentials in it. |
| `ELASTICSEARCH_API_KEY` | one auth | API key, sent as `Authorization: ApiKey <key>` (the base64 "encoded" value) |
| `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD` | one auth | Basic auth, used when no API key is set |
| `ELASTICSEARCH_TOOL_ALLOW_WRITES` | no | `1` lets agent tools index, create and update documents |
| `ELASTICSEARCH_TOOL_ALLOW_ESQL` | no | `1` lets agent tools run `esql_query` (its sources are checked, see Agent policy) |
| `ELASTICSEARCH_TOOL_API_EXTRA_PATHS` | no | More read paths for agent `api_request`, comma-separated, `*` = one segment |

Without any credential nothing is sent (a local cluster with security disabled). A node's `access_token` is used as the
API key.

**Getting an API key:** Kibana → Stack Management → API keys → Create API key (or `POST /_security/api_key`); copy
the **Encoded** value. Give it only the privileges the workflow needs, e.g. for read-only use:
```json
{ "role_descriptors": { "reader": { "indices": [ { "names": ["logs-*", "docs"], "privileges": ["read", "view_index_metadata"] } ], "cluster": ["monitor"] } } }
```
Add `write` (or `index`) on the indices for document writes. The cluster privilege `monitor` covers cluster info,
health and `_cat/indices`.

**Pricing:** the API is free; Elastic Cloud bills by deployment size or (Serverless) by ingest, storage and search
compute, so large searches and writes have a cost there.

## Quick Start
```bash
ELASTICSEARCH_URL=https://my-deployment.es.us-east-1.aws.elastic.cloud ELASTICSEARCH_API_KEY=... \
  graphrt run elasticsearch/example.yaml --plugins .
```
The example shows the cluster version, lists indices and searches a few documents.

## Usage
```yaml
- id: errors
  type: elasticsearch.search
  index: logs-*
  size: 20
  query: { bool: { filter: [ { term: { level: error } }, { range: { "@timestamp": { gte: now-1h } } } ] } }
  sort: [ { "@timestamp": desc } ]
- id: by_host
  type: elasticsearch.esql_query
  query: "FROM logs-* | WHERE level == ? | STATS c = COUNT(*) BY host.name | SORT c DESC | LIMIT 10"
  params: [error]
- id: save
  type: elasticsearch.index_document
  index: incidents
  doc_id: "{{#run.id#}}"
  document: { summary: "{{#summary.text#}}" }
  refresh: wait_for
```
Paging: `search` with `size` and `from` up to 10,000 hits; beyond that pass the last hit's `sort` values as
`search_after` (with a `sort` that includes a tiebreaker field).

## Agent policy
- **Reads** are agent tools: search, count, get/multi-get, mappings, cluster info, health and `_cat/indices`.
- **Painless costs CPU.** Search queries, aggregations, runtime fields and script sorts can run Painless scripts. They
  run in Elasticsearch's sandbox and cannot change data, but an agent can still send expensive aggregations or scripts
  that load the cluster. Limit this with the API key's role, `search.allow_expensive_queries: false` or
  `script.allowed_types`, and use a dedicated, read-only key for agents.
- **ES|QL needs an opt-in:** `esql_query` works as a tool only with `ELASTICSEARCH_TOOL_ALLOW_ESQL=1`, because ES|QL names
  its sources inside the query text. With the opt-in, the sources of `FROM`, `TS` and `LOOKUP JOIN` must pass the same
  check as index arguments, and any name in the query that starts with a dot is refused (also inside quotes, after a
  `cluster:` prefix or after comments and unusual whitespace). The check is a backstop that may also refuse odd but
  harmless queries (e.g. a decimal written as `.5`); index privileges on the key are the real protection.
- **System indices are off limits for agents.** Tools cannot name an index starting with `.` (`.security*`, `.kibana*`,
  `.tasks`, also behind a `cluster:` prefix, before a `::data`/`::failures` selector or inside a comma-separated list
  such as `logs,.security-7`) or `_` (other than `_all`). Selectors other than `::data` and `::failures` and date-math
  names (`<logs-{now/d}>`, also percent-encoded) are refused for agents, because a date-math name's target is only
  known on the server. `api_request` may only set `expand_wildcards` to `open` or `closed` (`hidden` or `all` would
  let `*` match system indices), so an agent cannot read user, API key or
  saved-object documents or turn an index path into another API. Scope the API key anyway: this is a backstop, not a
  replacement for index privileges.
- **Writes need an opt-in:** `index_document`, `create_document` and `update_document` work as tools only with
  `ELASTICSEARCH_TOOL_ALLOW_WRITES=1`.
- **Node only:** `delete_document`, `delete_by_query`, `bulk`.
- **`api_request`** is GET-only for agents and reaches only an allowlist: `/`, cluster health, `_cat` lists
  (indices, aliases, count, health, allocation; not shards), mappings, aliases, settings, `_resolve/index`, and per index
  `_mapping`, `_settings`, `_alias`, `_count`, `_search` (with `q=`), `_stats`, `_field_caps`, `_doc/<id>` and
  `_source/<id>`. `_security`, `_nodes`, `_snapshot`, `_cluster/settings`, `_watcher`, `_ml` and every dot index are
  refused. Endpoints that list or expand index names (`_cat/indices`, `_cat/aliases`, `_alias`, `_cluster/health`,
  mappings, settings, searches, ...) get `expand_wildcards=open,closed` when the agent sets none, since several
  default to `all` and would list hidden index names. Workflow nodes can call anything.

## Errors
| Situation | Kind |
|---|---|
| 401 (bad or missing credential) | `auth_error` |
| 403 (`security_exception`: the key lacks a privilege) | `permission_denied` |
| `index_not_found_exception`, missing document (404) | `not_found` |
| Query parse errors, ES|QL `verification_exception`, `illegal_argument_exception` (400) | `invalid_input` |
| 429, `es_rejected_execution_exception`, `circuit_breaking_exception` | `rate_limited` |
| Agent tool refused by policy | `permission_denied` |
| Cluster unreachable | `network_error` |

Messages include Elasticsearch's `reason` and `type`, e.g. `no such index [nope] (index_not_found_exception)`.
Unsafe writes (`create_document`, `update_document`, `delete_by_query`, `bulk`) are never retried after a timeout or
5xx; the error says the outcome is unknown and how to check.

## License
Apache-2.0
