# open-meteo (WebAssembly build)

**Status:** experimental · **ToS risk:** none (as the [Node.js plugin](../../open-meteo/)).

## Overview
The [open-meteo](../../open-meteo/) plugin compiled from Rust to a sandboxed `wasm32-unknown-unknown` module
(`open_meteo.wasm`) on [rest-kit](../crates/rest-kit/): Open-Meteo weather (no API key): `search_locations`, `get_forecast` and `api_request`. It runs inside graphrt's wasmi interpreter, with no
Node.js process; outbound HTTP goes through graphrt's SSRF-safe egress.

Same plugin name, node kinds, tool names, parameters, env variables, results, error kinds and messages as the
Node.js plugin, so workflows and agents keep `open-meteo.<operation>` and `open-meteo/<operation>`. `crates/open-meteo/manifest.json` and
`spec.jsonl` are exported from [`open-meteo/definition.mjs`](../../open-meteo/definition.mjs); plugin-specific code
([`crates/open-meteo/src/lib.rs`](../crates/open-meteo/src/lib.rs)): None: the whole plugin is the exported spec.

## Prerequisites
- graphrt 0.6.1+ built with `wasm` and `http` (the default CLI build has both)
- No Node.js

## Installation
```sh
graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/open-meteo
```
or point `--plugins` at this directory. The release catalog lists the build in the plugin's
`runtimes` (install command and module hash). Install either this build or the Node.js
plugin (they share the name); see [picking a runtime](../README.md#picking-a-runtime).

## Configuration
None, like the Node.js plugin.

## Differences from the Node.js plugin
The common ones are listed in [`../README.md`](../README.md#differences-from-the-nodejs-plugins) (transport error
text, retries without waiting, ASCII case folding).

## Building
```sh
rustup target add wasm32-unknown-unknown
wasm/crates/rest-kit/build.sh open-meteo           # export the spec, rebuild open_meteo.wasm (opt-level z, LTO, stripped)
wasm/crates/rest-kit/build.sh --check open-meteo   # fails if the committed files are stale
```

## License
Apache-2.0
