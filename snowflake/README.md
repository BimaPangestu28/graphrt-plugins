# snowflake

**Status:** beta · **ToS risk:** none. Official SQL API; reviewed and unit-tested with fakes, checked live only with a made-up account (not_found). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **Snowflake** over the
[SQL API v2](https://docs.snowflake.com/en/developer-guide/sql-api/index), authenticated with a key-pair JWT
(RS256 signed with `node:crypto`, see [`lib/key-pair-jwt.mjs`](lib/key-pair-jwt.mjs)). No Snowflake driver, no npm
dependencies.

## Features
- **`execute`:** one SQL statement with `?` bindings. It is submitted asynchronously and polled for up to
  `SNOWFLAKE_WAIT_MS`. Returns typed `rows` (objects), `columns`, `total_rows`, `stats` for DML, and `next_cursor`
  when more rows (or more result partitions) remain. A statement still running after the wait comes back as
  `{status: "running", statement_handle}`; `wait: false` returns that at once.
- **`get_statement_status`:** waits for a running statement and returns its first page.
- **`get_statement_results`:** the next page from a `next_cursor`, across result partitions.
- **`cancel_statement`:** cancels a running statement. Aborting a call while it waits cancels the statement too.
- **Values:** NUMBER with scale 0 is a number when exact, else a string; decimals are exact strings; FLOAT is a
  number; BOOLEAN a boolean; DATE `YYYY-MM-DD`; TIME `HH:MM:SS.fffffffff`; TIMESTAMP_NTZ ISO without offset,
  TIMESTAMP_LTZ ISO in UTC, TIMESTAMP_TZ ISO in its own offset; VARIANT/OBJECT/ARRAY parsed JSON; BINARY hex.
  Bindings infer TEXT, FIXED, REAL and BOOLEAN; pass `{"type": "DATE", "value": "2026-11-19"}` (or TIME,
  TIMESTAMP_NTZ/LTZ/TZ, BINARY, ...) for the rest.
- Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- A Snowflake user with an RSA key pair:
  ```bash
  openssl genrsa 2048 | openssl pkcs8 -topk8 -v2 aes-256-cbc -inform PEM -out rsa_key.p8   # encrypted private key
  openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
  ```
  then in Snowflake: `ALTER USER graphrt_reader SET RSA_PUBLIC_KEY='MIIBIjANBgkqh...';`

## Installation
```bash
graphrt plugin install ./snowflake
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `SNOWFLAKE_ACCOUNT` | (required) | Account identifier: `myorg-myaccount` (preferred) or the locator form `xy12345.us-east-2.aws`. The JWT uses it uppercase without region (`MYORG-MYACCOUNT`, `XY12345`); the host keeps the full identifier with `_` turned into `-`. |
| `SNOWFLAKE_USER` | (required) | Login name (uppercased in the JWT) |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | (none) | PEM private key file (PKCS#8, encrypted or not) |
| `SNOWFLAKE_PRIVATE_KEY` | (none) | The PEM text instead of a file (`\n` escapes allowed) |
| `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` | (none) | Passphrase of an encrypted key |
| `SNOWFLAKE_HOST` | from the account | Another Snowflake host, e.g. a PrivateLink `xy12345.us-east-2.privatelink.snowflakecomputing.com` (must end in `.snowflakecomputing.com` or `.cn`) |
| `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_ROLE` | user defaults | Session defaults; nodes may override each per call |
| `SNOWFLAKE_TOOL_ROLE` | (none: agent tools refused) | Role **every agent tool call** uses (tools cannot choose a role or warehouse). Agent tools are refused until it is set, unless `SNOWFLAKE_TOOL_ALLOW_WRITES=1`. |
| `SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS` | `60` | Statement timeout; nodes may pass up to 3600, tool calls are capped at this value |
| `SNOWFLAKE_WAIT_MS` | `45000` | How long a call waits for a result before returning the handle (1000 to 90000) |
| `SNOWFLAKE_MAX_RESULT_BYTES` | `2000000` | Most JSON bytes of rows per call; the rest comes with `next_cursor` |
| `SNOWFLAKE_TOOL_ALLOW_WRITES` | (off) | `1` lets agent tools run statements the read-only check refuses |

**Per-node token:** a node's `access_token` (an OAuth access token from a workflow secret, with
`--trust-plugin snowflake`) is sent with `X-Snowflake-Authorization-Token-Type: OAUTH` instead of the key-pair JWT.

## Quick Start
```bash
export SNOWFLAKE_ACCOUNT=myorg-myaccount SNOWFLAKE_USER=GRAPHRT_READER SNOWFLAKE_PRIVATE_KEY_PATH=$HOME/.snowflake/rsa_key.p8
export SNOWFLAKE_PRIVATE_KEY_PASSPHRASE=... SNOWFLAKE_WAREHOUSE=REPORTING_WH
graphrt run snowflake/example.yaml --plugins .
```

## Usage
```yaml
- id: revenue
  type: snowflake.execute
  statement: "SELECT order_date, SUM(total) AS revenue FROM shop.orders WHERE order_date >= ? GROUP BY 1 ORDER BY 1"
  bindings: [{ type: DATE, value: "2026-11-01" }]
- id: next_page
  type: snowflake.get_statement_results
  cursor: "{{#revenue.next_cursor#}}"
```

## Safety
- **The role is the boundary; the text check is not.** Agent tool calls are refused until `SNOWFLAKE_TOOL_ROLE` is
  set (or `SNOWFLAKE_TOOL_ALLOW_WRITES=1`). For any setup that offers this plugin's tools to an agent, use a
  **separate Snowflake user** that holds only a least-privilege role, and turn off secondary roles for it so no other
  grant can become active in its sessions:
  ```sql
  CREATE ROLE agent_reader;
  GRANT USAGE ON WAREHOUSE reporting_wh TO ROLE agent_reader;
  GRANT USAGE ON DATABASE analytics TO ROLE agent_reader;
  GRANT USAGE ON SCHEMA analytics.public TO ROLE agent_reader;
  GRANT SELECT ON ALL TABLES IN SCHEMA analytics.public TO ROLE agent_reader;
  CREATE USER graphrt_agent TYPE = SERVICE DEFAULT_ROLE = agent_reader DEFAULT_SECONDARY_ROLES = ()
    DEFAULT_WAREHOUSE = reporting_wh RSA_PUBLIC_KEY = 'MIIBIjANBgkqh...';
  GRANT ROLE agent_reader TO USER graphrt_agent;
  ALTER USER graphrt_agent SET STATEMENT_TIMEOUT_IN_SECONDS = 120;
  ```
  Then set `SNOWFLAKE_USER=GRAPHRT_AGENT` and `SNOWFLAKE_TOOL_ROLE=AGENT_READER`. Workflows that write should run with
  a different user (a separate graphrt environment), not by granting write roles to the agent user. Put the warehouse
  under a resource monitor.
- **Read-only text check for agent tools (defense in depth only):** the SQL API reports no statement type before it
  runs a statement, so the text is lexed (comments, `'strings'`, `"identifiers"` and `$$strings$$`, where `$$` only
  opens a string at the start of a token) and must match an allowed form: SELECT, WITH ... SELECT, a parenthesized
  query, SHOW, DESCRIBE/DESC, or EXPLAIN [USING ...] of a query. Refused anywhere: a second statement, the `->>`
  pipe operator, `SYSTEM$` in any identifier (quoted or not), INSERT, UPDATE, DELETE, MERGE, TRUNCATE, CREATE, ALTER,
  DROP, UNDROP, COPY, PUT, REMOVE/RM, GRANT, REVOKE, CALL, EXECUTE, USE, UNSET, BEGIN, COMMIT and ROLLBACK, and table
  functions other than FLATTEN, GENERATOR, SPLIT_TO_TABLE, STRTOK_SPLIT_TO_TABLE and INFORMATION_SCHEMA functions
  (`TABLE(my_proc())` can run a stored procedure; RESULT_SCAN can read results of queries other roles ran).
  `MULTI_STATEMENT_COUNT=1` is sent with every statement. `SNOWFLAKE_TOOL_ALLOW_WRITES=1` turns the check off. Nodes
  may run any statement.
- **Statement handles:** agent tools can only check, page or cancel statements that an agent tool call started in
  the same plugin process; other handles are node only.
- **Retries:** read-only statements are resubmitted after 5xx and network errors. Other statements are not; the
  error names the request id and query tag so you can check the query history first.
- **Secrets:** the JWT, OAuth token, key passphrase and PEM text are redacted from errors; key parse errors never
  quote key material. The JWT is only sent to Snowflake hosts and is reused until 5 minutes before it expires.

## Costs
Statements run on your warehouse and bill credits while it runs (per second, 60 s minimum after resume). The SQL
API itself has no extra charge. See Snowflake's pricing and resource monitors.

## License
Apache-2.0
