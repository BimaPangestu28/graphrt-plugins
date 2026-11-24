#!/usr/bin/env bash
# Builds the rest-kit plugins (Rust -> wasm32-unknown-unknown, opt-level z, LTO, stripped) and prints each module's
# size and SHA-256. Exports manifest.json/spec.jsonl/graphrt-plugin.json from the Node.js definitions first.
# `--check` fails when a committed module or exported file differs from a fresh build.
#
#   wasm/build-rest.sh [--check] [plugin ...]
#
# Needs Node.js and Rust with the wasm32-unknown-unknown target (rust-toolchain.toml pins the toolchain).
#
# Same bytes on every machine: the sources are copied to a fixed directory and built there (cargo's metadata hash of
# a path dependency depends on where it is checked out), and no home or checkout path reaches the module.
set -euo pipefail
cd "$(dirname "$0")"
check=""
if [ "${1:-}" = "--check" ]; then check="--check"; shift; fi
ports=("$@")
if [ ${#ports[@]} -eq 0 ]; then ports=(open-meteo currency-rates wikipedia web-search); fi
node scripts/export-rest-spec.mjs $check "${ports[@]}"

build_root="${REST_KIT_BUILD_ROOT:-/tmp/graphrt-plugins-rest-kit-build}"
rm -rf "$build_root/src"
mkdir -p "$build_root/src"
cp Cargo.toml Cargo.lock rust-toolchain.toml "$build_root/src/"
for crate in rest-kit open-meteo currency-rates wikipedia web-search; do
  mkdir -p "$build_root/src/$crate"
  cp -R "$crate/Cargo.toml" "$crate/src" "$build_root/src/$crate/"
  for data in manifest.json spec.jsonl; do
    if [ -f "$crate/$data" ]; then cp "$crate/$data" "$build_root/src/$crate/"; fi
  done
done
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$build_root/src=/src"
target_dir="${CARGO_TARGET_DIR:-$build_root/target}"
status=0
for port in "${ports[@]}"; do
  (cd "$build_root/src" && CARGO_TARGET_DIR="$target_dir" cargo build --quiet --locked --release --target wasm32-unknown-unknown -p "$port")
  module="$(echo "$port" | tr - _).wasm"
  built="$target_dir/wasm32-unknown-unknown/release/$module"
  if [ -n "$check" ]; then
    cmp -s "$built" "$port/$module" || { echo "wasm/$port/$module is out of date: run wasm/build-rest.sh $port" >&2; status=1; }
  else
    cp "$built" "$port/$module"
  fi
  echo "$port/$module: $(wc -c < "$port/$module" | tr -d ' ') bytes, sha256 $(sha256sum "$port/$module" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$port/$module" | cut -d' ' -f1)"
done
exit $status
