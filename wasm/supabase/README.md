# supabase (WebAssembly build, default tool mode)

**Status:** experimental · **ToS risk:** none.

## Overview
The agent tools of the [supabase](../../supabase/) plugin in its default tool mode, compiled from Rust to a
sandboxed `wasm32-unknown-unknown` module (`supabase.wasm`, ~300 KB). It runs inside graphrt's wasmi interpreter
with fuel and memory limits, and reaches Supabase only through graphrt's SSRF-safe egress. No Node.js.

Same manifest name (`supabase`), tool names, parameter schemas, env variables, agent policy, error kinds and messages
as the Node.js plugin, so workflows keep `tools: [supabase/select_rows, ...]`. The per-user mode
(`SUPABASE_TOOL_MODE=user_rpc`) is the separate module [`wasm/supabase-rpc`](../supabase-rpc/): a module lists its
tools before it sees env, and the two modes offer different tools.

## Features
- `select_rows` with structured, quoted PostgREST filters, column selection, ordering and offset pagination
- `insert_rows`, `upsert_rows`, `update_rows` and `call_function` behind `SUPABASE_TOOL_ALLOW_WRITES=1`
- `call_function` with `SUPABASE_TOOL_RPC_ALLOWLIST`, `SUPABASE_TOOL_TIMEOUT_MS` and `SUPABASE_TOOL_MAX_ROWS`
- `get_api_schema`, `list_buckets`, `get_bucket`, `list_objects`, `get_object_info`
- `upload_object` from an https URL (binary files, never overwriting)
- `api_request`: GET only, `/rest/v1` and Storage reads (plus `SUPABASE_TOOL_API_EXTRA_PATHS`)

## Prerequisites
- graphrt built with `wasm` and `http` (the default build has both); 0.6.1 for every tool except `upload_object`,
  which needs binary HTTP bodies (graphrt PR #57, graphrt 0.7+)
- No Node.js

## Installation
```sh
graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/supabase
```
or point `--plugins` at this directory. It needs no `--trust-plugin`: it receives no tool context secrets.

## Quick Start
```sh
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_KEY=sb_publishable_... \
  graphrt run agent.yaml --plugins wasm/supabase --no-default-plugins
```
with an agent node that lists `tools: [supabase/select_rows]`.

## Configuration
The Node.js plugin's variables ([supabase README](../../supabase/README.md#configuration)), without the file
directories:

| Variable | Required | Meaning |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Project origin, `https://<ref>.supabase.co` (http only on localhost) |
| `SUPABASE_KEY` | yes | Publishable/anon key (row level security applies) or secret/service_role key |
| `SUPABASE_USER_JWT` | no | A user's access token sent as `Authorization: Bearer` (RLS as that user) |
| `SUPABASE_TOOL_ALLOW_WRITES` | no | `1` lets agents insert, upsert, update, upload and call functions |
| `SUPABASE_TOOL_RPC_ALLOWLIST` | no | Functions `call_function` may call, comma-separated (default: any) |
| `SUPABASE_TOOL_TIMEOUT_MS` | no | Deadline of one `call_function`, 1000–120000 (default 30000) |
| `SUPABASE_TOOL_MAX_ROWS` | no | `call_function` array results are cut to this many rows, 1–1000 (default 100) |
| `SUPABASE_TOOL_API_EXTRA_PATHS` | no | More paths `api_request` may read, comma-separated, `*` for one segment |
| `SUPABASE_TOOL_MODE` | no | Empty or `default`; `user_rpc` needs [`wasm/supabase-rpc`](../supabase-rpc/) |

Requests go through graphrt's egress policy: public addresses only, so a local Supabase (`supabase start`,
`http://localhost:54321`) needs `--allow-private-network`; redirects are not followed for API calls.

## Differences from the Node.js plugin
- Agent tools only: no workflow nodes, and no `download_object` (a module has no file system).
- `upload_object` takes an https URL only; a local path (`SUPABASE_UPLOAD_DIR`) is refused. The download and the
  upload are capped by the host (`http_response_bytes`, 4 MiB, and `http_request_bytes`, 1 MiB, by default; the
  Node.js plugin allows 50 MiB), and request timeouts by `http_timeout_ms` (30 s by default).
- No automatic retries: the Node.js client retries 429s and the 5xx/network failures of reads after a back-off; a
  guest cannot sleep, so the error comes back at once with the same `retryable` flag.
- Internal-host checks of the upload URL cover literal addresses and `localhost`; resolved addresses are checked by
  the host's egress (the Node.js plugin resolves names itself).
- Network errors carry graphrt's error text instead of undici's; an API error without a message names the HTTP
  reason phrase (`Too Many Requests`); numbers in results are re-serialized by serde_json (`10.0` stays `10.0`).
- Case-insensitive matches (enum values, `api_request` path policy) are ASCII-only: a non-ASCII letter that
  JavaScript maps to ASCII (the Kelvin sign) is refused instead of matched.

## Building
The source is the crate [`wasm/crates/supabase`](../crates/supabase/), which builds this module and
`wasm/supabase-rpc/supabase_rpc.wasm` (feature `user-rpc`):
```sh
rustup target add wasm32-unknown-unknown
wasm/crates/supabase/build.sh           # rebuilds both modules (opt-level z, LTO, stripped)
wasm/crates/supabase/build.sh --check   # fails if a committed module is stale
```
The tool schemas (`src/tools.jsonl`) are the Node.js manifest's; [`wasm/test`](../test/) checks they match.

## License
Apache-2.0
