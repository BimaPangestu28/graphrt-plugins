# WebAssembly builds

Sandboxed WebAssembly builds of catalog plugins, for agents where a Node.js process is too slow to start or too
large (scale-to-zero agents, small containers). They run inside graphrt's wasmi interpreter with fuel and memory
limits; outbound HTTP goes through graphrt's SSRF-safe egress. The Node.js plugin stays the default and the
fallback; the catalog lists the builds as `runtimes` of their plugin ([Picking a runtime](#picking-a-runtime)).

| Build | Replaces | What it does |
| --- | --- | --- |
| [open-meteo](open-meteo/) | [open-meteo](../open-meteo/) | Every node and tool (declarative, no hooks) |
| [currency-rates](currency-rates/) | [currency-rates](../currency-rates/) | Every node and tool; `convert` as a hook |
| [wikipedia](wikipedia/) | [wikipedia](../wikipedia/) | Every node and tool; `language` and `max_chars` as hooks |
| [web-search](web-search/) | [web-search](../web-search/) | `search` and `search_news` (nodes and tools) on Tavily, Brave Search or SerpAPI |
| [supabase](supabase/) | [supabase](../supabase/) in the default tool mode | Every agent tool except `download_object`: rows, writes behind `SUPABASE_TOOL_ALLOW_WRITES`, RPC, Storage reads and uploads, `api_request` |
| [supabase-rpc](supabase-rpc/) | [supabase](../supabase/) with `SUPABASE_TOOL_MODE=user_rpc` | The per-user `call_function` tool (RPC as the signed-in end user, JWT from `tool_context`) |

Each directory above is what gets installed: the `runtime: wasm` manifest, the module and a README. The sources are
in [`crates/`](crates/):

- [`crates/rest-kit`](crates/rest-kit/) is a small declarative REST runtime. A plugin built on it is its Node.js
  `defineRestPlugin` definition exported as data (`export-spec.mjs` writes the crate's `manifest.json` and
  `spec.jsonl` and the build's `graphrt-plugin.json`), plus Rust hooks where the Node.js plugin has hand-written
  code; [`crates/open-meteo`](crates/open-meteo/), [`crates/currency-rates`](crates/currency-rates/),
  [`crates/wikipedia`](crates/wikipedia/) and [`crates/web-search`](crates/web-search/) are 10 to 230 lines each.
  `crates/rest-kit/build.sh` builds them (`--check` fails when a module or exported file is stale).
- Both supabase modules are built from one crate, [`crates/supabase`](crates/supabase/) (`build.sh` builds both).
  They are tools only: workflow nodes need the Node.js plugin.

notion-api and airtable-api are not ported: they are hand-written plugins (rich-text and property-value builders, a
formula builder, base and people guards, per-user tokens), not `defineRestPlugin` definitions, so moving them needs a
Rust port of that code (like supabase) rather than a spec for rest-kit.

## Picking a runtime
| | Node.js plugin (default) | WebAssembly build |
| --- | --- | --- |
| Install | `graphrt plugin install <name>` (catalog tarball) | `graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/<build>` |
| Offers | Every node and tool | rest-kit builds: every node and tool; supabase: the agent tools of one tool mode |
| Needs | Node.js 20+ | graphrt with `wasm` and `http` (0.6.1+; supabase's `upload_object` needs binary HTTP bodies: the graphrt release after 0.6.1, or graphrt main from 824ccf6 until it is out) |
| Best for | Warm servers calling a plugin many times a second (1–3 ms faster per call) | Cold starts (~6× faster) and memory (~12× less) |

A build has its plugin's manifest name, so a workflow does not change; install one of them (or point `--plugins` at
its directory). [`builds.json`](builds.json) lists the builds per plugin; the release catalog (`index.json` and
`index-v2.json`) gives such a plugin a `runtimes` list: `{runtime: "process", default: true}` for the tarball, then
each build with `runtime: "wasm"`, `tool_mode`, `tools`, `module_sha256`, `module_size_bytes` and its `install`
command (`scripts/lib/plugin-runtimes.mjs`).

## Why one module per plugin
The rest-kit builds compile rest-kit once per plugin, with the plugin's manifest and spec embedded, instead of one
shared rest-kit module plus a per-plugin manifest:

- graphrt cannot hand a module data from its manifest: a guest receives only the call and the `permissions.env`
  values, so a shared module would need a new host ABI;
- a shared module would read and parse its whole spec on every call (one fresh instance per call), which in the
  interpreter cost about half of a call when measured; embedded, the spec sits in the data segment and a call
  parses only the lines of `spec.jsonl` it uses;
- the per-plugin part is small: modules differ by the spec (3–5 KB), the manifest (4–11 KB) and the hooks
  (0–8 KB) on ~230 KB of shared code, and graphrt compiles each plugin's module at load either way, so the cost is
  ~240 KB of disk per extra installed build and nothing at run time;
- each build installs and versions on its own, like its Node.js plugin.

Size: opt-level z, LTO, one codegen unit, `panic = "abort"`, stripped; no guest SDK (rest-kit implements the four
exports and the `graphrt::http` import itself, without serde derive code), `serde_json` without `std` and `ryu`
with small tables. open-meteo is 245 KB, the others 256–260 KB.

## Differences from the Node.js plugins
Every rest-kit build:

- **Transport errors** carry graphrt's error text instead of undici's (`Network error: ...`; a timeout is
  `Network error: request timed out` in both).
- **Retries do not wait:** there is no clock in WebAssembly. Server errors and network failures of safe requests
  are retried at once (as often as in Node.js); a rate limit (429, or a `rate_limited` body error) is returned at
  once with `retryable: true` instead of waiting for `Retry-After`. Calls that are never retried (writes, paid
  searches) behave the same.
- **HTTP status text** is the standard phrase of the status (`Not Found`), as servers send it; graphrt's replies
  carry none.
- **Case folding is ASCII** (enum matching, country and language codes); JavaScript also folds a few non-ASCII
  letters. URLs with non-ASCII hosts (IDNA) are not parsed.
- **JSON:** numbers are written as JavaScript writes them (`768.0` is `768`), but object keys keep the API's order,
  also integer-like keys that JavaScript moves first; text previews never split a character (JavaScript's `slice`
  can split a surrogate pair).

The supabase builds list theirs in their READMEs (no retries, no file system, transport error text, HTTP reason
phrases, serde_json number formatting).

## Tests
[`test/`](test/) runs every case against the Node.js plugin and the WebAssembly build (through
[`test/wasm-host.mjs`](test/wasm-host.mjs), a minimal host on Node's WebAssembly API) and requires the same results
(`text` and `data`, node outputs), error kinds, messages and `retryable` flags, and HTTP requests (method, URL,
headers, body): for the rest-kit builds 103 cases, each as an agent tool and as a workflow node
([`rest-parity.mjs`](test/rest-parity.mjs) and one file per plugin), 102 for supabase's default mode
([`supabase-tools.test.mjs`](test/supabase-tools.test.mjs)) and 36 for `user_rpc`
([`supabase-user-rpc.test.mjs`](test/supabase-user-rpc.test.mjs)), plus manifest, mode and deadline checks. rest-kit
also has Rust unit and ABI tests (`cargo test` in `crates/`), including the credential paths the ported plugins do
not use (a node's `access_token`, the end user's token from `tool_context`).

The tests use the committed `.wasm`; `crates/rest-kit/build.sh --check` and `crates/supabase/build.sh --check`
(need Rust) check they are built from the source. The bytes are reproducible per host platform (the committed
modules come from macOS arm64); CI rebuilds them on Linux and runs the tests against that build, and
`npm run check` fails when a ported plugin's definition changed without a new export.

## Node.js vs WebAssembly
### rest-kit builds
Measured with [`bench/rest_plugins.py`](bench/rest_plugins.py): one call per run against a mock upstream (and, for
the agent mode, a mock model: two model turns, one tool call), both builds patched the same way to call the mock,
graphrt 0.6.1 `serve,llm,plugins,trust-gateway,wasm,http` min-size musl, Linux aarch64 (4-vCPU VM), Node.js 22,
50 cold and 300 warm runs, 2026-11-24. On disk is the install directory (Node.js itself, 61 MiB `libnode`, and
graphrt's wasmi, +1.0 MiB with `http`, not counted); RSS is serve plus plugin processes after the warm runs.

As a workflow node (`--mode node`):

| Plugin (call) | Build | On disk | Cold run p50 / p95 | First run on `serve` | Warm run p50 / p95 | RSS after runs |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| open-meteo (`get_forecast`) | Node.js | 287 KB | 102.9 / 112.5 ms | 101.5 ms | 0.72 / 1.41 ms | 126.4 MiB |
| | WebAssembly | 259 KB (`.wasm` 245 KB) | 16.5 / 17.0 ms | 11.2 ms | 2.42 / 3.06 ms | 9.4 MiB |
| currency-rates (`convert`) | Node.js | 296 KB | 104.5 / 114.7 ms | 107.1 ms | 0.68 / 1.24 ms | 112.2 MiB |
| | WebAssembly | 278 KB (`.wasm` 257 KB) | 16.3 / 17.1 ms | 11.6 ms | 1.80 / 2.14 ms | 9.3 MiB |
| web-search (`search`, Brave) | Node.js | 293 KB | 106.3 / 116.3 ms | 119.4 ms | 0.71 / 1.01 ms | 117.8 MiB |
| | WebAssembly | 270 KB (`.wasm` 260 KB) | 18.1 / 20.0 ms | 13.1 ms | 3.36 / 3.85 ms | 10.1 MiB |

As an agent tool (`--mode agent`):

| Plugin (tool) | Build | Cold run p50 / p95 | First run on `serve` | Warm run p50 / p95 | RSS after runs |
| --- | --- | ---: | ---: | ---: | ---: |
| open-meteo (`get_forecast`) | Node.js | 107.0 / 115.4 ms | 103.4 ms | 1.16 / 1.60 ms | 116.8 MiB |
| | WebAssembly | 19.2 / 19.8 ms | 14.5 ms | 2.95 / 3.16 ms | 9.8 MiB |
| currency-rates (`convert`) | Node.js | 110.9 / 162.5 ms | 117.4 ms | 1.07 / 1.46 ms | 112.8 MiB |
| | WebAssembly | 19.7 / 30.2 ms | 15.8 ms | 2.21 / 2.44 ms | 9.8 MiB |
| web-search (`search`, Brave) | Node.js | 109.0 / 127.1 ms | 135.2 ms | 1.12 / 1.55 ms | 126.3 MiB |
| | WebAssembly | 21.1 / 22.4 ms | 15.1 ms | 3.94 / 4.06 ms | 9.9 MiB |

A cold run is 5–6× faster and a warm server holds ~12× less memory. A warm call is 1–3 ms slower: every call is
a fresh instance, and wasmi interprets the JSON parsing and building that V8 runs JIT-compiled. wikipedia is not
in the bench (its base URL is built from the language at run time, so the bench cannot point it at the mock); it
runs the same rest-kit code.

### supabase
Measured on Linux aarch64 (4-vCPU VM, Node.js 22), graphrt `serve,llm,plugins,trust-gateway,wasm,http` min-size musl
build with binary HTTP bodies (graphrt PR #57, now main 824ccf6), mock model and Supabase, one tool call per run, 50
cold and 300 warm runs, 2026-11-24.

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
