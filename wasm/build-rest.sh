#!/usr/bin/env bash
# Builds the rest-kit plugins (Rust -> wasm32-unknown-unknown, opt-level z, LTO, stripped) and prints each module's
# size and SHA-256. Exports manifest.json/spec.json/graphrt-plugin.json from the Node.js definitions first.
# `--check` fails when a committed module or exported file differs from a fresh build.
#
#   wasm/build-rest.sh [--check] [plugin ...]
#
# Needs Node.js and Rust with the wasm32-unknown-unknown target (rust-toolchain.toml pins the toolchain).
set -euo pipefail
cd "$(dirname "$0")"
check=""
if [ "${1:-}" = "--check" ]; then check="--check"; shift; fi
ports=("$@")
if [ ${#ports[@]} -eq 0 ]; then ports=(open-meteo currency-rates wikipedia web-search); fi
node scripts/export-rest-spec.mjs $check "${ports[@]}"
# Same bytes on every machine: no home or checkout paths in the module (panic locations).
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$PWD=/src"
target_dir="${CARGO_TARGET_DIR:-$PWD/target}"
status=0
for port in "${ports[@]}"; do
  cargo build --quiet --locked --release --target wasm32-unknown-unknown -p "$port"
  module="$(echo "$port" | tr - _).wasm"
  built="$target_dir/wasm32-unknown-unknown/release/$module"
  if [ -n "$check" ]; then
    cmp -s "$built" "$port/$module" || { echo "wasm/$port/$module is out of date: run wasm/build-rest.sh $port" >&2; status=1; }
  else
    cp "$built" "$port/$module"
  fi
  echo "$port/$module: $(wc -c < "$port/$module" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$port/$module" | cut -d' ' -f1)"
done
exit $status
