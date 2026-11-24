#!/usr/bin/env bash
# Builds supabase_rpc.wasm from src/ (Rust -> wasm32-unknown-unknown, opt-level z, LTO, stripped)
# and prints its size and SHA-256. `--check` fails when the committed module differs from a fresh build.
#
#   wasm/supabase-rpc/build.sh [--check]
#
# Needs Rust with the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown).
set -euo pipefail
cd "$(dirname "$0")"
# Same bytes on every machine: no home or checkout paths in the module (panic locations), pinned toolchain
# (rust-toolchain.toml).
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$PWD=/src"
cargo build --quiet --locked --release --target wasm32-unknown-unknown
built=target/wasm32-unknown-unknown/release/supabase_rpc.wasm
if [ "${1:-}" = "--check" ]; then
  cmp -s "$built" supabase_rpc.wasm || { echo "supabase_rpc.wasm is out of date: run wasm/supabase-rpc/build.sh" >&2; exit 1; }
else
  cp "$built" supabase_rpc.wasm
fi
echo "supabase_rpc.wasm: $(wc -c < supabase_rpc.wasm | tr -d ' ') bytes, sha256 $(shasum -a 256 supabase_rpc.wasm | cut -d' ' -f1)"
