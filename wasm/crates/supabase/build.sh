#!/usr/bin/env bash
# Builds both supabase WebAssembly modules from src/ (Rust -> wasm32-unknown-unknown, opt-level z, LTO, stripped):
#   wasm/supabase/supabase.wasm          the default tool mode
#   wasm/supabase-rpc/supabase_rpc.wasm  SUPABASE_TOOL_MODE=user_rpc (feature `user-rpc`)
# and prints their sizes and SHA-256. `--check` fails when a committed module differs from a fresh build.
#
#   wasm/crates/supabase/build.sh [--check]
#
# Needs Rust with the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown).
set -euo pipefail
cd "$(dirname "$0")"
# Same bytes wherever the checkout is on one host platform: no home or checkout paths in the module (panic
# locations), pinned toolchain (rust-toolchain.toml). Other host platforms give other bytes (LLVM on Linux and
# macOS inlines differently); the committed modules are built on macOS arm64, and CI rebuilds them on Linux and
# runs the parity tests against that build.
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$PWD=/src"
built=target/wasm32-unknown-unknown/release/supabase.wasm
status=0

build_module() { # <cargo feature args...> -- <committed module path>
  local features=()
  while [ "$1" != "--" ]; do features+=("$1"); shift; done
  local committed=$2
  cargo build --quiet --locked --release --target wasm32-unknown-unknown ${features[@]+"${features[@]}"}
  if [ "$check" = 1 ]; then
    cmp -s "$built" "$committed" || { echo "$committed is out of date: run wasm/crates/supabase/build.sh" >&2; status=1; }
  else
    cp "$built" "$committed"
  fi
  echo "$(basename "$committed"): $(wc -c < "$committed" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$committed" | cut -d' ' -f1)"
}

check=0
[ "${1:-}" = "--check" ] && check=1
build_module -- ../../supabase/supabase.wasm
build_module --features user-rpc -- ../../supabase-rpc/supabase_rpc.wasm
exit $status
