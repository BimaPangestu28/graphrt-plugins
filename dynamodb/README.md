# dynamodb

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **Amazon DynamoDB**. It calls the DynamoDB JSON API
directly, signed with AWS Signature Version 4 ([`lib/aws-sigv4.mjs`](lib/aws-sigv4.mjs), a byte-identical copy of
the [s3](../s3/) plugin's signer, verified against the official AWS SigV4 test suite). No AWS SDK, no npm
dependencies.

## Features
- **Tables:** `list_tables` (paginated) and `describe_table` (keys, attribute types, item count, size, billing mode,
  indexes, stream, deletion protection).
- **Reads:** `get_item`, `query` (key condition, filter, index, sort order), `scan` and `batch_get_items` (up to
  100 keys; unprocessed keys are retried three times, any left over are returned in `unprocessed_keys`). Query and
  scan return one page (`limit`, default 100, at most 1000; DynamoDB also stops at 1 MB) and a `next_cursor`
  (the LastEvaluatedKey, encoded).
- **Writes:** `put_item` and `update_item` (condition expressions, return values) and `delete_item` (node only).
- **Values:** `attribute_format: "plain"` (default) takes and returns ordinary JSON: strings, numbers, booleans,
  null, arrays (L) and objects (M). Numbers that a JSON number cannot hold exactly come back as strings; string,
  number and binary sets come back as arrays, binary as base64. Use `attribute_format: "typed"` for DynamoDB JSON
  (`{"S": "x"}`, `{"SS": ["a"]}`, `{"N": "1.50"}`) to write sets, binary and exact numbers.
- Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- An IAM user or role with only the actions your workflow needs, e.g. `dynamodb:ListTables`, `DescribeTable`,
  `GetItem`, `Query`, `Scan`, `BatchGetItem` for read-only use, plus `PutItem` / `UpdateItem` / `DeleteItem` on
  specific table ARNs for writes.

## Installation
```bash
graphrt plugin install ./dynamodb
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | (none) | Credentials (session token for temporary credentials) |
| `DYNAMODB_REGION` (or `AWS_REGION`, `AWS_DEFAULT_REGION`) | `us-east-1` | Region |
| `DYNAMODB_ENDPOINT` | `https://dynamodb.<region>.amazonaws.com` | Another origin, e.g. DynamoDB Local `http://localhost:8000` (http only for localhost) |
| `DYNAMODB_TIMEOUT_MS` | `30000` | Per-request timeout (1000 to 100000) |
| `DYNAMODB_TOOL_ALLOW_WRITES` | (off) | `1` lets agent tools call `put_item` and `update_item` |
| `DYNAMODB_ALLOWED_TABLES` | (any name, no ARNs) | Comma-separated table names or ARNs agent tools may use; nodes are not limited |

**Per-node credentials:** a node's `access_token` replaces the credentials for that node:
`ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]`, from a workflow env variable of type `secret`, with
`--trust-plugin dynamodb`. Agent tools never choose credentials.

## Quick Start
```bash
export AWS_ACCESS_KEY_ID=AKIA... AWS_SECRET_ACCESS_KEY=... AWS_REGION=ap-southeast-1
graphrt run dynamodb/example.yaml --plugins .
```

## Usage
```yaml
- id: orders
  type: dynamodb.query
  table: orders
  key_condition_expression: "pk = :customer AND begins_with(sk, :month)"
  expression_attribute_values: { ":customer": "customer#42", ":month": "2026-11" }
  scan_index_forward: false
  limit: 20
- id: mark_paid
  type: dynamodb.update_item
  table: orders
  key: { pk: "customer#42", sk: "{{#orders.data.items.0.sk#}}" }
  update_expression: "SET #s = :paid"
  condition_expression: "attribute_exists(pk)"
  expression_attribute_names: { "#s": "status" }
  expression_attribute_values: { ":paid": "paid" }
```
Values always go in `expression_attribute_values` and reserved words in `expression_attribute_names`; never paste
user input into an expression.

## Safety
- **Agent tools are read-only by default:** `list_tables`, `describe_table`, `get_item`, `query`, `scan` and
  `batch_get_items` are tools. `put_item` and `update_item` are refused for tools unless
  `DYNAMODB_TOOL_ALLOW_WRITES=1`. `delete_item` is node only.
- **Table allowlist:** `DYNAMODB_ALLOWED_TABLES` limits every agent tool call to the listed tables, and
  `list_tables` shows tools only those. Table ARNs (which can name another account's table) are refused for tools
  unless listed, even without the allowlist.
- **Full-table scans:** `scan` reads every item up to `limit` per page (at most 1000 items or 1 MB) and an agent can
  page through a whole table with `next_cursor`. Keep `limit` small, prefer `query`, and use the allowlist for
  large tables.
- **Least privilege:** the opt-in is a plugin-side check; the IAM policy is the real boundary. Give agent workflows
  credentials that only allow the read actions on the tables they need.
- **Retries:** reads are retried after 5xx and network errors; throttling is retried for every action (DynamoDB
  applied nothing). A write that fails with a 5xx or network error is not retried and says how to check
  (`update_item` with `ADD` or list appends is not safe to repeat).
- **Secrets:** the secret key and session token are redacted from every error and response.

## Costs
On-demand tables bill per read/write request unit; `scan` reads (and bills) every item it passes, including those a
filter drops. See the DynamoDB pricing page.

## License
Apache-2.0
