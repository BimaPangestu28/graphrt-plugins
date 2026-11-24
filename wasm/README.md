# WebAssembly builds

Sandboxed WebAssembly builds of catalog plugins, for agents where a Node.js process is too slow to start or too
large (scale-to-zero agents, small containers). They run inside graphrt's wasmi interpreter with fuel and memory
limits; outbound HTTP goes through graphrt's SSRF-safe egress. They are pilots: not in the plugin catalog yet,
installed from a path.

| Build | Replaces | What it does |
| --- | --- | --- |
| [supabase-rpc](supabase-rpc/) | [supabase](../supabase/) with `SUPABASE_TOOL_MODE=user_rpc` | The per-user `call_function` tool (RPC as the signed-in end user) |

Tests: [`test/`](test/) runs every case against the Node.js plugin and the WebAssembly build (through
[`test/wasm-host.mjs`](test/wasm-host.mjs), a minimal host on Node's WebAssembly API) and requires the same results,
errors and HTTP requests. They use the committed `.wasm`; `supabase-rpc/build.sh --check` (needs Rust) checks it is
built from the committed source.

## Node.js vs WebAssembly (supabase `user_rpc`)
Measured with graphrt's `bench/wasm-plugin/supabase_tool.py` (examples/supabase-chatbot agent, one tool call per run,
mock model and Supabase, graphrt `serve,llm,plugins,trust-gateway,wasm,http` min-size, Linux aarch64 musl, 4-vCPU VM,
Node.js 22, 2026-11-24):

| | Node.js plugin | WebAssembly build |
| --- | ---: | ---: |
| On disk | 370 KB + Node.js (61 MiB `libnode`) | 220 KB (`.wasm` ≈214 KB) + wasmi in graphrt (+1.0 MiB with `http`) |
| Cold `graphrt run`, p50 / p95 | 118.8 / 122.2 ms | 18.4 / 19.4 ms |
| First run on a fresh `serve` | 172.9 ms | 10.9 ms |
| Warm run, p50 / p95 | 1.80 / 2.75 ms | 1.79 / 2.06 ms |
| RSS after runs (serve + plugin) | 127.0 MiB | 9.2 MiB |

Behaviour: the 36 shared cases in [`test/`](test/) give the same results, error kinds and messages and HTTP
requests (two message differences by design: transport errors, and the HTTP reason phrase); graphrt's
examples/supabase-chatbot smoke and security e2e (real PostgREST + Postgres, hostile model) pass with this build.
