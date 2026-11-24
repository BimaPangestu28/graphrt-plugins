# supabase (WebAssembly build of `user_rpc`)

**Status:** experimental (pilot) · **ToS risk:** none.

## Overview
The per-user RPC tool of the [supabase](../../supabase/) plugin, compiled from Rust to a sandboxed
`wasm32-unknown-unknown` module (`supabase_rpc.wasm`). It offers one agent tool, `call_function`, that calls an
allowlisted Postgres function as the signed-in end user: `apikey` is the publishable key, `Authorization: Bearer`
is the user's JWT from the agent's `tool_context`. Row level security decides what the user sees.

Same manifest name (`supabase`), tool name, env variables, error kinds and messages as the Node.js plugin in
`SUPABASE_TOOL_MODE=user_rpc`, so it is a drop-in replacement for that mode: workflows keep
`tools: [supabase/call_function]` and `tool_context: {supabase: {user_jwt: ...}}`. The default tool mode (every
other tool) is the separate module [`wasm/supabase`](../supabase/).

## Prerequisites
- graphrt 0.6.1+ built with `wasm` and `http` (the default build has both): WebAssembly tools and `graphrt::http`
- No Node.js

## Installation
```sh
graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/supabase-rpc
```
or point `--plugins` at this directory. Trust it so it receives the user's JWT: `--trust-plugin supabase`.

## Configuration
| Variable | Required | Meaning |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Project origin, `https://<ref>.supabase.co` (http only on localhost) |
| `SUPABASE_KEY` | yes | Publishable (`sb_publishable_...`) or anon key; secret and service_role keys are refused |
| `SUPABASE_TOOL_MODE` | yes | Must be `user_rpc` (the default mode is [`wasm/supabase`](../supabase/)) |
| `SUPABASE_TOOL_RPC_ALLOWLIST` | yes | Functions the tool may call, comma-separated; others are refused |
| `SUPABASE_TOOL_TIMEOUT_MS` | no | Deadline of one call, 1000–120000 (default 30000); graphrt caps it at 30 s by default |
| `SUPABASE_TOOL_MAX_ROWS` | no | Array results are cut to this many rows, 1–1000 (default 100) |

Requests go through graphrt's egress policy: public addresses only, so a local Supabase (`supabase start`,
`http://localhost:54321`) needs `--allow-private-network`; redirects are not followed.

## Differences from the Node.js plugin
- Only `user_rpc`'s `call_function`; no nodes, no default-mode tools.
- The `function_name` parameter has no `enum` of the allowlisted names (the module describes itself before it
  sees env); the allowlist is still enforced on every call, and names are matched case-insensitively as before.
- Network errors carry graphrt's error text instead of undici's.
- Numbers in results are re-serialized by serde_json (`10.0` stays `10.0`; JavaScript prints `10`).

## Building
The source is the crate [`wasm/crates/supabase`](../crates/supabase/) with the feature `user-rpc`; one script builds
this module and [`wasm/supabase`](../supabase/):
```sh
rustup target add wasm32-unknown-unknown
wasm/crates/supabase/build.sh           # rebuilds both modules (opt-level z, LTO, stripped)
wasm/crates/supabase/build.sh --check   # fails if a committed module is stale
```

## License
Apache-2.0
