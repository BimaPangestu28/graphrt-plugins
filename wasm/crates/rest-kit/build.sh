#!/usr/bin/env bash
# Builds the rest-kit plugins (Rust -> wasm32-unknown-unknown, opt-level z, LTO, stripped) into their install
# directories (wasm/<plugin>/<module>.wasm) and prints each module's size and SHA-256. Exports
# manifest.json/spec.jsonl (wasm/crates/<plugin>/) and graphrt-plugin.json (wasm/<plugin>/) from the Node.js
# definitions first. `--check` fails when a committed module or exported file differs from a fresh build.
#
#   wasm/crates/rest-kit/build.sh [--check] [plugin ...]
#
# Needs Node.js and Rust with the wasm32-unknown-unknown target (wasm/crates/rust-toolchain.toml pins it).
#
# Same bytes wherever the checkout is on one host platform: the workspace is copied to a fixed directory and built
# there (cargo's metadata hash of a path dependency depends on its location), and no home or checkout path reaches
# the module. Other host platforms give other bytes (LLVM on Linux and macOS inlines differently); the committed
# modules are built on macOS arm64, and CI rebuilds them on Linux and runs the parity tests against that build.
set -euo pipefail
crates="$(cd "$(dirname "$0")/.." && pwd)"
wasm="$(dirname "$crates")"
check=""
if [ "${1:-}" = "--check" ]; then check="--check"; shift; fi
ports=("$@")
if [ ${#ports[@]} -eq 0 ]; then ports=(open-meteo currency-rates wikipedia web-search); fi
node "$crates/rest-kit/export-spec.mjs" $check "${ports[@]}"

build_root="${REST_KIT_BUILD_ROOT:-/tmp/graphrt-plugins-rest-kit-build}"
rm -rf "$build_root/src"
mkdir -p "$build_root/src"
cp "$crates/Cargo.toml" "$crates/Cargo.lock" "$crates/rust-toolchain.toml" "$build_root/src/"
for crate in rest-kit open-meteo currency-rates wikipedia web-search; do
  mkdir -p "$build_root/src/$crate"
  cp -R "$crates/$crate/Cargo.toml" "$crates/$crate/src" "$build_root/src/$crate/"
  for data in manifest.json spec.jsonl; do
    if [ -f "$crates/$crate/$data" ]; then cp "$crates/$crate/$data" "$build_root/src/$crate/"; fi
  done
done
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$build_root/src=/src"
target_dir="${CARGO_TARGET_DIR:-$build_root/target}"
status=0
for port in "${ports[@]}"; do
  (cd "$build_root/src" && CARGO_TARGET_DIR="$target_dir" cargo build --quiet --locked --release --target wasm32-unknown-unknown -p "$port")
  module="$(echo "$port" | tr - _).wasm"
  built="$target_dir/wasm32-unknown-unknown/release/$module"
  committed="$wasm/$port/$module"
  if [ -n "$check" ]; then
    cmp -s "$built" "$committed" || { echo "wasm/$port/$module is out of date: run wasm/crates/rest-kit/build.sh $port" >&2; status=1; }
  else
    cp "$built" "$committed"
  fi
  sha="$( (sha256sum "$committed" 2>/dev/null || shasum -a 256 "$committed") | cut -d' ' -f1)"
  echo "$port/$module: $(wc -c < "$committed" | tr -d ' ') bytes, sha256 $sha"
done
exit $status
