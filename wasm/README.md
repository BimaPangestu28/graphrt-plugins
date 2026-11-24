# WebAssembly builds

Sandboxed WebAssembly builds of catalog plugins, for agents where a Node.js process is too slow to start or too
large (scale-to-zero agents, small containers). They run inside graphrt's wasmi interpreter with fuel and memory
limits; outbound HTTP goes through graphrt's SSRF-safe egress. The Node.js plugin stays the default and the
fallback; the catalog lists the builds as `runtimes` of their plugin ([Picking a runtime](#picking-a-runtime)).

| Build | Replaces | What it does |
| --- | --- | --- |
| [supabase](supabase/) | [supabase](../supabase/) in the default tool mode | Every agent tool except `download_object`: rows, writes behind `SUPABASE_TOOL_ALLOW_WRITES`, RPC, Storage reads and uploads, `api_request` |
| [supabase-rpc](supabase-rpc/) | [supabase](../supabase/) with `SUPABASE_TOOL_MODE=user_rpc` | The per-user `call_function` tool (RPC as the signed-in end user, JWT from `tool_context`) |

Both supabase modules are built from one crate, [`crates/supabase`](crates/supabase/) (`build.sh` builds both;
`--check` fails when a committed module is stale). They are tools only: workflow nodes need the Node.js plugin.

## Picking a runtime
| | Node.js plugin (default) | WebAssembly build |
| --- | --- | --- |
| Install | `graphrt plugin install supabase` (catalog tarball) | `graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/supabase` (or `wasm/supabase-rpc` for `user_rpc`) |
| Offers | Every node and tool | The agent tools of one tool mode |
| Needs | Node.js 20+ | graphrt with `wasm` and `http` (0.6.1+; `upload_object` needs binary HTTP bodies: the graphrt release after 0.6.1, or graphrt main from 824ccf6 until it is out) |

Both have the manifest name `supabase`, so a workflow does not change; install one of them (or point `--plugins` at
its directory). [`builds.json`](builds.json) lists the builds per plugin; the release catalog (`index.json` and
`index-v2.json`) gives such a plugin a `runtimes` list: `{runtime: "process", default: true}` for the tarball, then
each build with `runtime: "wasm"`, `tool_mode`, `tools`, `module_sha256`, `module_size_bytes` and its `install`
command (`scripts/lib/plugin-runtimes.mjs`).

## Tests
[`test/`](test/) runs every case against the Node.js plugin and the WebAssembly build (through
[`test/wasm-host.mjs`](test/wasm-host.mjs), a minimal host on Node's WebAssembly API) and requires the same results
(`text` and `data`), error kinds, messages and `retryable` flags, and HTTP requests (method, URL, headers, body):
102 cases for the default mode ([`supabase-tools.test.mjs`](test/supabase-tools.test.mjs)) and 36 for `user_rpc`
([`supabase-user-rpc.test.mjs`](test/supabase-user-rpc.test.mjs)), plus manifest, mode and deadline checks. They use
the committed `.wasm`; `crates/supabase/build.sh --check` (needs Rust) checks they are built from the source (the
bytes are reproducible per host platform; the committed modules come from macOS arm64, and CI rebuilds them on
Linux and runs the tests against that build).

## Node.js vs WebAssembly
Measured on Linux aarch64 (4-vCPU VM, Node.js 22), graphrt `serve,llm,plugins,trust-gateway,wasm,http` min-size musl
build with binary HTTP bodies (graphrt PR #57, now main 824ccf6), mock model and Supabase, one tool call per run, 50 cold and 300 warm
runs, 2026-11-24.

Default tool mode, `select_rows` with a filter ([`bench/supabase_tools.py`](bench/supabase_tools.py), which also
checks every Supabase request):

| | Node.js plugin | WebAssembly build |
| --- | ---: | ---: |
| On disk | 363 KB + Node.js (61 MiB `libnode`) | 320 KB (`.wasm` 302 KB) + wasmi in graphrt (+1.0 MiB with `http`) |
| Cold `graphrt run`, p50 / p95 | 116.6 / 125.6 ms | 23.5 / 25.7 ms |
| First run on a fresh `serve` | 133.4 ms | 11.4 ms |
| Warm run, p50 / p95 | 1.62 / 2.60 ms | 2.26 / 2.57 ms |
| RSS after runs (serve + plugin) | 129.3 MiB | 10.2 MiB |

`user_rpc`, `call_function` (graphrt's `bench/wasm-plugin/supabase_tool.py`, examples/supabase-chatbot):

| | Node.js plugin | WebAssembly build |
| --- | ---: | ---: |
| On disk | 363 KB + Node.js | 219 KB (`.wasm` 214 KB) + wasmi in graphrt |
| Cold `graphrt run`, p50 / p95 | 123.1 / 149.8 ms | 19.8 / 33.8 ms |
| First run on a fresh `serve` | 128.0 ms | 10.5 ms |
| Warm run, p50 / p95 | 1.88 / 3.20 ms | 1.88 / 2.09 ms |
| RSS after runs (serve + plugin) | 136.4 MiB | 9.9 MiB |

A warm call is a fresh instance of the module per call: the default module's warm median is ~0.6 ms above the
Node.js plugin's (argument validation and filter encoding interpreted by wasmi), with a tighter p95. The pilot's
earlier `user_rpc` run measured 18.4 / 19.4 ms cold; the p95 above is from a noisier VM.

Behaviour differences by design are listed in each build's README (no retries, no file system, transport error
text, HTTP reason phrases, serde_json number formatting).
