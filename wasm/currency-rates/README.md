# currency-rates (WebAssembly build)

**Status:** experimental · **ToS risk:** none (as the [Node.js plugin](../../currency-rates/)).

## Overview
The [currency-rates](../../currency-rates/) plugin compiled from Rust to a sandboxed `wasm32-unknown-unknown` module
(`currency_rates.wasm`) on [rest-kit](../rest-kit/): Frankfurter exchange rates (no API key): latest, historical, time series, pair rates, currencies, providers, `convert` and `api_request`. It runs inside graphrt's wasmi interpreter, with no
Node.js process; outbound HTTP goes through graphrt's SSRF-safe egress.

Same plugin name, node kinds, tool names, parameters, env variables, results, error kinds and messages as the
Node.js plugin, so workflows and agents keep `currency-rates.<operation>` and `currency-rates/<operation>`. `manifest.json` and
`spec.jsonl` are exported from [`currency-rates/definition.mjs`](../../currency-rates/definition.mjs); plugin-specific code
([`src/lib.rs`](src/lib.rs)): `convert` (reads `get_pair_rate` and multiplies, rounded like JavaScript's `toFixed(6)`: half away from zero on the exact value).

## Prerequisites
- graphrt 0.6.1+ built with `wasm` and `http` (the default CLI build has both)
- No Node.js

## Installation
```sh
graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/currency-rates
```
or point `--plugins` at this directory. The release catalog lists the build under the plugin's
`wasm` field (install command and module hash). Install either this build or the Node.js
plugin (they share the name); see [choosing a runtime](../README.md#choosing-a-runtime).

## Configuration
None, like the Node.js plugin.

## Differences from the Node.js plugin
The common ones are listed in [`../README.md`](../README.md#differences-from-the-nodejs-plugins) (transport error
text, retries without waiting, ASCII case folding).
- `from`/`to` of `convert` are upper-cased ASCII only (Frankfurter's codes are ASCII).

## Building
```sh
rustup target add wasm32-unknown-unknown
wasm/build-rest.sh currency-rates           # export the spec, rebuild currency_rates.wasm (opt-level z, LTO, stripped)
wasm/build-rest.sh --check currency-rates   # fails if the committed files are stale
```

## License
Apache-2.0
