# web-search (WebAssembly build)

**Status:** experimental · **ToS risk:** low (as the [Node.js plugin](../../web-search/)).

## Overview
The [web-search](../../web-search/) plugin compiled from Rust to a sandboxed `wasm32-unknown-unknown` module
(`web_search.wasm`) on [rest-kit](../crates/rest-kit/): Web and news search through Tavily, Brave Search or SerpAPI (provider and key from env; paid per query): `search` and `search_news`. It runs inside graphrt's wasmi interpreter, with no
Node.js process; outbound HTTP goes through graphrt's SSRF-safe egress.

Same plugin name, node kinds, tool names, parameters, env variables, results, error kinds and messages as the
Node.js plugin, so workflows and agents keep `web-search.<operation>` and `web-search/<operation>`. `crates/web-search/manifest.json` and
`spec.jsonl` are exported from [`web-search/definition.mjs`](../../web-search/definition.mjs); plugin-specific code
([`crates/web-search/src/lib.rs`](../crates/web-search/src/lib.rs)): `search` and `search_news`: the provider from `WEB_SEARCH_PROVIDER`, the neutral arguments mapped to the provider's, and its response mapped to `{provider, query, answer, results}`. The three providers are declarative APIs in the spec (no retry of a paid call after an unknown outcome).

## Prerequisites
- graphrt 0.6.1+ built with `wasm` and `http` (the default CLI build has both)
- No Node.js

## Installation
```sh
graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/web-search
```
or point `--plugins` at this directory. Trust it (`--trust-plugin web-search`) only when nodes pass `access_token` from a secret. The release catalog lists the build in the plugin's
`runtimes` (install command and module hash). Install either this build or the Node.js
plugin (they share the name); see [picking a runtime](../README.md#picking-a-runtime).

## Configuration
| Variable | Required | Meaning |
| --- | --- | --- |
| `WEB_SEARCH_PROVIDER` | yes | `tavily`, `brave` or `serpapi` |
| `WEB_SEARCH_API_KEY` | yes | That provider's key (a node's `access_token` overrides it; agent tools never can) |

## Differences from the Node.js plugin
The common ones are listed in [`../README.md`](../README.md#differences-from-the-nodejs-plugins) (transport error
text, retries without waiting, ASCII case folding).
- `country`/`language` are case-converted as ASCII only (providers take ASCII codes).
- A result's `source` falls back to the URL's host only for http(s) URLs with ASCII hosts; JavaScript also reads other schemes and IDNA hosts.

## Building
```sh
rustup target add wasm32-unknown-unknown
wasm/crates/rest-kit/build.sh web-search           # export the spec, rebuild web_search.wasm (opt-level z, LTO, stripped)
wasm/crates/rest-kit/build.sh --check web-search   # fails if the committed files are stale
```

## License
Apache-2.0
