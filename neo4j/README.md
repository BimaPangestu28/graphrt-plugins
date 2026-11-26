# neo4j

**Status:** beta · **ToS risk:** none. Official Query API; reviewed and unit-tested with fakes, checked live against the public demo with a bad password (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin that runs Cypher on Neo4j through the
[HTTP Query API v2](https://neo4j.com/docs/query-api/current/) (`POST /db/<database>/query/v2`). It works with
self-managed Neo4j (5.x and 2025+ calendar versions with the Query API enabled) and Neo4j Aura. It is built with the
declarative REST layer ([`definition.mjs`](definition.mjs)); no driver, no Bolt.

## Features
- **Queries:** `run_read_query` (`accessMode: "Read"`; agent statements with write clauses are refused), `run_write_query` (`accessMode: "Write"`,
  returns counters). Both take `statement` with `$placeholders` and `parameters`, plus an optional
  `max_execution_time` (seconds, Neo4j 2026.04+).
- **Schema:** `list_labels`, `list_relationship_types`, `list_property_keys`, `list_indexes`, `list_constraints`,
  `get_schema` (`db.schema.visualization`)
- **Nodes:** `get_node` and `delete_node` (node only) by `elementId`
- **Server:** `get_server_info` (version, edition, Query API versions; the discovery endpoint needs no auth)

Results come back as `records` (one object per row, keyed by the `RETURN` names) next to `fields`, `bookmarks`,
`queryType` (`r`, `rw`, `w`, `s`), `notifications` and, for writes, `counters`. Nodes are
`{elementId, labels, properties}`. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Neo4j with the Query API (on by default in recent versions; self-managed: `server.http_enabled_modules` must include
  `QUERY_API_ENDPOINTS`) reachable over HTTP(S): port 7474 (http) / 7473 (https), Aura on 443

## Installation
```bash
graphrt plugin install ./neo4j
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `NEO4J_URL` | no | HTTP(S) address, default `http://localhost:7474`; Aura: `https://<instance-id>.databases.neo4j.io`. Not `neo4j://`/`bolt://`. Plain `http://` only for localhost. |
| `NEO4J_DATABASE` | no | Database name, default `neo4j` (one database per configuration) |
| `NEO4J_USERNAME`, `NEO4J_PASSWORD` | yes | Basic auth (Aura: the instance's credentials file) |
| `NEO4J_TOOL_ALLOW_WRITES` | no | `1` lets agent tools use `run_write_query` |
| `NEO4J_TOOL_ALLOWED_PROCEDURES` | no | More procedures/functions agents may call, comma-separated: exact names (`apoc.coll.sum`) or prefixes (`apoc.text.`, `apoc.coll.*`) |

A node's `access_token` replaces the password.

**Credentials:** create a dedicated user with only the privileges the workflow needs, e.g. for read-only agents:
```cypher
CREATE USER agent SET PASSWORD 'change-me' CHANGE NOT REQUIRED;
GRANT ROLE reader TO agent;
```
(Role-based access control needs Enterprise Edition or Aura Business/Enterprise; on Community and AuraDB Free every
user is an admin, so only the statement guard below protects against agent writes: prefer an edition with roles for
agent workflows.)

**Pricing:** the Query API is free; Aura bills by instance size, and AuraDB Free has limits on nodes and relationships.

## Quick Start
```bash
NEO4J_URL=https://<id>.databases.neo4j.io NEO4J_USERNAME=neo4j NEO4J_PASSWORD=... \
  graphrt run neo4j/example.yaml --plugins .
```
The example prints the server version, the labels and the five most connected nodes.

## Usage
```yaml
- id: movies
  type: neo4j.run_read_query
  statement: "MATCH (p:Person {name: $name})-[:ACTED_IN]->(m:Movie) RETURN m.title AS title, m.released AS year ORDER BY year"
  parameters: { name: "{{#start.actor#}}" }
- id: tag
  type: neo4j.run_write_query
  statement: "MATCH (m:Movie {title: $title}) SET m.reviewed = true RETURN m.title"
  parameters: { title: "{{#movies.data.records.0.title#}}" }
```
Always pass values as `parameters` (never paste them into the statement): that prevents Cypher injection and lets
Neo4j cache the plan. Statements must be on one line (JSON forbids literal line breaks; spaces work the same).

## Agent policy
- **Read queries ask for read transactions.** `run_read_query`, the schema operations and `get_node` send
  `accessMode: "Read"`. The Query API documents this field for routing (in a cluster the query goes to a reader); it
  is not documented as a guaranteed write barrier on a single server. When the server does refuse a write
  (`Neo.ClientError.Statement.AccessMode`: "Writing in read access mode not allowed"), that becomes
  `permission_denied`. **The real protection is the guard below plus a database user with a read-only role**
  (`reader`, see Credentials); use one for any workflow that gives agents `run_read_query`.
- **Tool statements are scanned.** For `run_read_query`, a tool statement with a write clause (`CREATE`, `INSERT`, `MERGE`,
  `SET`, `DELETE`, `DETACH`, `REMOVE`, `FOREACH`, `DROP`, `ALTER`, `GRANT`, `DENY`, `REVOKE`, `RENAME`,
  `START`/`STOP DATABASE`, `IN TRANSACTIONS`) is refused. Every tool statement is also checked for side effects a read
  transaction still allows. After removing comments (`//` ends at `\r` or `\n`) and string literals, unquoting
  backtick names as separate words and turning every character outside printable ASCII into a space (Cypher
  whitespace includes U+001C..U+001F and U+0085), a tool statement is refused when it contains a backslash outside a
  string (escape sequences in names), uses `LOAD CSV` (fetches URLs
  and files), `USE` (another database, e.g. `system`), `TERMINATE` (kills other users' transactions), `SHOW` for
  anything but indexes, constraints, functions and procedures (`SHOW TRANSACTIONS` reveals other users' queries,
  `SHOW SETTINGS` the configuration), or calls a namespaced procedure or function outside the read-only built-ins
  (`db.labels`, `db.relationshipTypes`, `db.propertyKeys`, `db.schema.*`, full-text and vector index queries,
  `db.info`, `db.ping`, `dbms.components`, and the `point.`, `date.`, `datetime.`, `localdatetime.`, `localtime.`,
  `time.`, `duration.`, `vector.` functions). So APOC (`apoc.load.*`, `apoc.export.*`, `apoc.cypher.*`,
  `apoc.periodic.*`), `dbms.*`, `gds.*` and `genai.*` (paid embedding calls) are refused unless listed in
  `NEO4J_TOOL_ALLOWED_PROCEDURES`. Keywords count only in keyword positions: a label or relationship type
  (`(n:Create)`, ``[r:`Set`]``), an alias (`RETURN 1 AS remove`), a map key or a backtick name is fine. **Known
  limitation:** a variable named like a write keyword is refused where it is used (`MATCH (set) RETURN set`);
  write it in backticks (``MATCH (`set`) RETURN `set` ``). This is a backstop, not a parser: give the plugin a user with only the privileges
  agents need.
- **Writes need an opt-in:** `run_write_query` works as a tool only with `NEO4J_TOOL_ALLOW_WRITES=1`, and the scan
  above still applies.
- **Node only:** `delete_node`. Workflow nodes may run any statement.
- **No `api_request`:** every query goes through `POST /query/v2`, and the database is fixed by `NEO4J_DATABASE`.
  Explicit multi-request transactions (`/query/v2/tx`) and impersonation are not offered; run multi-step changes as one
  statement (`CALL { ... }`, `UNWIND`).

## Errors
| Situation | Kind |
|---|---|
| `Neo.ClientError.Security.Unauthorized` (401) | `auth_error` |
| `Neo.ClientError.Security.Forbidden`, `Statement.AccessMode` (write in a read query) | `permission_denied` |
| `Statement.SyntaxError`, `SemanticError`, `ParameterMissing`, `TypeError`, `Request.Invalid` | `invalid_input` |
| `Database.DatabaseNotFound`, `Procedure.ProcedureNotFound` | `not_found` |
| `Security.AuthenticationRateLimit`, 429 | `rate_limited` |
| Agent tool refused by policy | `permission_denied` |

The Query API answers most failed queries with status 202 and an `errors` list; the plugin treats those as errors too
and shows the message and code, e.g. `Invalid credential. (Neo.ClientError.Security.Unauthorized)`. Transient errors
(deadlocks, database unavailable) were rolled back and are retryable. `run_write_query` is never retried after a
timeout or 5xx: the error says the outcome is unknown.

Live check: the example against the public demo server (`https://demo.neo4jlabs.com:7473`, database `movies`) with an
invalid password reads the server info (Neo4j 2026.05.0) and then fails with
`auth_error: API error 401: Invalid credential. (Neo.ClientError.Security.Unauthorized)`.

## License
Apache-2.0
