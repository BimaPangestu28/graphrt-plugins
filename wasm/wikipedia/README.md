# wikipedia (WebAssembly build)

**Status:** experimental · **ToS risk:** none (as the [Node.js plugin](../../wikipedia/)).

## Overview
The [wikipedia](../../wikipedia/) plugin compiled from Rust to a sandboxed `wasm32-unknown-unknown` module
(`wikipedia.wasm`) on [rest-kit](../crates/rest-kit/): Wikipedia in any language (no API key): search, summaries, plain-text content, media lists, nearby pages, language links and `api_request`. It runs inside graphrt's wasmi interpreter, with no
Node.js process; outbound HTTP goes through graphrt's SSRF-safe egress.

Same plugin name, node kinds, tool names, parameters, env variables, results, error kinds and messages as the
Node.js plugin, so workflows and agents keep `wikipedia.<operation>` and `wikipedia/<operation>`. `crates/wikipedia/manifest.json` and
`spec.jsonl` are exported from [`wikipedia/definition.mjs`](../../wikipedia/definition.mjs); plugin-specific code
([`crates/wikipedia/src/lib.rs`](../crates/wikipedia/src/lib.rs)): `language` on every operation but `api_request` (another wiki, still on wikipedia.org) and `get_page_content`'s `max_chars` cap with not_found for missing pages.

## Prerequisites
- graphrt 0.6.1+ built with `wasm` and `http` (the default CLI build has both)
- No Node.js

## Installation
```sh
graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/wikipedia
```
or point `--plugins` at this directory. The release catalog lists the build in the plugin's
`runtimes` (install command and module hash). Install either this build or the Node.js
plugin (they share the name); see [picking a runtime](../README.md#picking-a-runtime).

## Configuration
| Variable | Required | Meaning |
| --- | --- | --- |
| `WIKIPEDIA_LANGUAGE` | no | Default wiki, e.g. `id` (default `en`); a plain wiki code only |

## Differences from the Node.js plugin
The common ones are listed in [`../README.md`](../README.md#differences-from-the-nodejs-plugins) (transport error
text, retries without waiting, ASCII case folding).
- `get_page_content` never cuts a character in two at `max_chars` (JavaScript's `slice` can split an emoji's surrogate pair).

## Building
```sh
rustup target add wasm32-unknown-unknown
wasm/crates/rest-kit/build.sh wikipedia           # export the spec, rebuild wikipedia.wasm (opt-level z, LTO, stripped)
wasm/crates/rest-kit/build.sh --check wikipedia   # fails if the committed files are stale
```

## License
Apache-2.0
