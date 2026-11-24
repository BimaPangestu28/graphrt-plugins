# rest-kit

## Overview
A small Rust runtime for graphrt WebAssembly builds of the repo's declarative REST plugins
([docs/declarative-plugins.md](../../../docs/declarative-plugins.md)). A plugin is described by data, exported from the
Node.js plugin's own `defineRestPlugin` definition, so both builds share one source of truth for the contract:

- `manifest.json`: what `graphrt_describe` returns, the Node.js plugin's nodes and tools byte for byte;
- `spec.jsonl`: the runtime spec (APIs, operations, params, auth, errors, pagination, limits), one JSON document
  per line so a call parses only the lines it uses;
- `wasm/<plugin>/graphrt-plugin.json`: the install manifest (`runtime: wasm`) with the Node.js plugin's permissions and limits.

Plugin-specific code (currency-rates `convert`, wikipedia's `language`, web-search's providers) is a small `Hooks`
implementation in the port's `src/lib.rs`. The behaviour is a port of `shared/lib` (rest-plugin, rest-request,
rest-response, rest-errors, rest-auth, api-client, params, operations): same requests, results, error kinds and
messages, checked against the Node.js plugins by [`wasm/test`](../../test/).

## Features
- **Params:** path (one encoded segment, `{+name}` keeps slashes), query (comma, repeat or brackets arrays), header
  (CR/LF refused) and body (dotted paths); constants; validation and coercion exactly like `params.mjs` (types, enum
  with case-insensitive match, min/max, minLength, maxItems, defaults, string templates, exact numeric ids).
- **Auth:** none, bearer, api-key header (with prefix) or query param, from env; a node's `access_token`; the end
  user's token from the agent's `tool_context` (`<PLUGIN>_TOOL_TOKEN_SOURCE=context`, the env credential is then
  hidden from tools). Every credential is redacted from data, cursors and errors.
- **Responses:** `dataPath` field picking; pagination by cursor field, Link header, next URL, last item id, page or
  offset (generated `limit`/`cursor`); errors from `messagePath`, `codePath`, `kindByCode`, `kindByStatus`,
  `retryableCodes`, and errors in 2xx bodies (`okPath`, `errorPath`).
- **Limits:** per-request `timeoutMs` (the host caps it), retries only where safe (`write: read/idempotent`, never
  `unsafe`, with the "outcome unknown" note and `checkHint`), tool result caps (`toolOutput.maxItems` rows and
  `maxChars`), `api_request` GET-only for tools and kept off protected paths, `toolPolicy` opt-in, `nodeOnly`.
- **Output:** JSON written with JavaScript's number formatting (`768.0` is `768`, `1e21` is `1e+21`), keys in the
  API's order, so tool `text` is the Node.js plugin's text.

The export script refuses what rest-kit does not implement (OAuth2, custom signing, basic auth, jobs, downloads,
binary responses, file and multipart bodies, `idempotencyKeyHeader`, base URL functions without a hook), so a port
never silently drops behaviour.

## Prerequisites
- Rust 1.95 (`wasm/crates/rust-toolchain.toml`) with the `wasm32-unknown-unknown` target; Node.js >= 20 for the export
- graphrt 0.6.1+ built with `wasm` and `http` to run the modules

## Installation
Not installed on its own: each port depends on it by path. Dependencies: `serde_json` (`alloc`, `preserve_order`,
`float_roundtrip`) and `ryu` (`small`). The ABI (four exports and the `graphrt::http` import) is implemented here,
without the guest SDK, which saves its serde derive code.

## Quick Start
A port is a crate with this `src/lib.rs`, a `rest-port.json` and the generated files:

```rust
pub struct OpenMeteo;
impl rest_kit::Hooks for OpenMeteo {}

pub const MANIFEST: &str = include_str!("../manifest.json");
pub const SPEC: &str = include_str!("../spec.jsonl");
rest_kit::export_rest_plugin!(MANIFEST, SPEC, OpenMeteo);
```

```json
{"definition": "pluginDefinition", "apis": {"main": "pluginDefinition"}, "module": "open_meteo.wasm"}
```

Add the crate to `wasm/crates/Cargo.toml` and the port lists of `build.sh`, add an install directory
`wasm/<port>/` (README) and a `wasm/builds.json` entry, then run `wasm/crates/rest-kit/build.sh <port>`.

## Usage
`Hooks` has two optional methods:

| Method | When |
| --- | --- |
| `base_url(kit, api)` | The API's `baseUrl` is a function of the environment in Node.js (the spec has `null`). Errors become `Invalid API base URL configuration: ...`, and the result is checked like `checkBaseUrl` (https, `allowedHostSuffix`). |
| `call(kit, name, raw_arguments)` | Runs operation `name` itself (`Some(result)`), or `None` for the declarative default. |

The building blocks of `Kit` follow the Node.js runner's order: `validate` (outer schema), `client` (credential,
then base URL), `run_rest_operation` (tool policy, request, shaping, tool truncation), `validate_for` (another API's
operation schema), `run_api_request`, `env`.

## Configuration
Compiled once per plugin (opt-level z, LTO, one codegen unit, `panic = "abort"`, stripped) by `build.sh`; see
[`wasm/README.md`](../../README.md#why-one-module-per-plugin) for why each plugin gets its own module.

## API Reference
`cargo doc -p rest-kit --open` in `wasm/crates/`.

## Contributing
`cargo test` (unit, ABI and credential tests, host target), `cargo clippy --all-targets`, `cargo fmt` in
`wasm/crates/`, then `npm test` at the repo root (parity tests against the committed modules) and `build.sh --check`.

## License
Apache-2.0
