#!/usr/bin/env python3
"""Node.js plugins vs their rest-kit WebAssembly builds (wasm/<plugin>), one plugin call per run.

For each plugin (open-meteo, currency-rates, web-search) a workflow calls one operation against a mock upstream,
once with the Node.js plugin and once with the WebAssembly build. `--mode node` runs it as a workflow node;
`--mode agent` as an agent tool (a mock OpenAI model asks for the tool, then answers from its result: two model
turns, one tool call). It measures:

- cold: `graphrt run` per sample, exec -> exit (process start, plugin load or start, the call, one HTTP request;
  currency-rates `convert` and web-search `search` run their plugin-specific code too);
- warm: one `graphrt serve`, sequential streamed runs, request -> run_succeeded;
- RSS of the serve process plus its children (the Node.js plugin) after the warm runs;
- the plugin's files on disk.

The plugins call fixed https API hosts. Both builds get the same patch: the base URL string is replaced, at the same
length, by `http://127.0.0.1:<port>/<padding>` (in definition.mjs / lib/*.mjs for Node.js, in the module's embedded
spec for WebAssembly), so the code that runs is the shipped code. The mock answers in well under a millisecond.
Standard library only.

  wasm/bench/rest_plugins.py --graphrt BIN [--plugins-repo .] [--plugin open-meteo] [--mode node|agent] \\
      [--cold 50] [--warm 300] [--json OUT]
"""

from __future__ import annotations

import argparse
import http.client
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from supabase_tools import disk_bytes, free_port, summary, tree_rss_mib  # noqa: E402

FORECAST = {"latitude": -6.9, "longitude": 107.6, "elevation": 768.0, "current_units": {"temperature_2m": "°C"},
            "current": {"time": "2026-11-24T10:00", "temperature_2m": 24.5, "weather_code": 3},
            "daily": {"time": ["2026-11-24"], "temperature_2m_max": [28.5], "temperature_2m_min": [21.0]}}
PAIR = {"date": "2026-11-24", "base": "USD", "quote": "IDR", "rate": 16250.5}
BRAVE = {"web": {"results": [{"title": f"Borobudur {index}", "url": f"https://example.org/{index}", "description": "Temple",
                              "meta_url": {"hostname": "example.org"}} for index in range(10)]}}

# name: (Node.js files holding the base URL, base URL, node kind, config, env, mock body, text the run must output)
SCENARIOS = {
    "open-meteo": (["definition.mjs"], "https://api.open-meteo.com", "open-meteo.get_forecast",
                   {"latitude": -6.9, "longitude": 107.6}, {}, FORECAST, "768"),
    "currency-rates": (["definition.mjs"], "https://api.frankfurter.dev", "currency-rates.convert",
                       {"amount": 100, "from": "USD", "to": "IDR"}, {}, PAIR, "1625050"),
    "web-search": (["lib/search-providers.mjs"], "https://api.search.brave.com/res/v1", "web-search.search",
                   {"query": "borobudur", "max_results": 5}, {"WEB_SEARCH_PROVIDER": "brave", "WEB_SEARCH_API_KEY": "mock-key"},
                   BRAVE, "Borobudur 4"),
}
WASM_DIRS = {"open-meteo": "open-meteo", "currency-rates": "currency-rates", "web-search": "web-search"}


def completion_chunk(delta: dict, finish_reason: str | None = None) -> dict:
    return {"id": "mock", "object": "chat.completion.chunk", "model": "mock",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}


def model_reply(request: dict, arguments: dict, expect: str) -> bytes:
    """First turn: call the only tool with `arguments`; then answer whether its result holds `expect`."""
    tool_results = [message for message in request.get("messages", []) if message.get("role") == "tool"]
    if not tool_results:
        call = {"index": 0, "id": "call_1", "type": "function",
                "function": {"name": request["tools"][0]["function"]["name"], "arguments": json.dumps(arguments)}}
        chunks = [completion_chunk({"role": "assistant", "tool_calls": [call]}), completion_chunk({}, "tool_calls")]
    else:
        found = expect if expect in str(tool_results[-1].get("content")) else "missing"
        chunks = [completion_chunk({"role": "assistant", "content": f"tool said {found}"}), completion_chunk({}, "stop")]
    return b"".join(f"data: {json.dumps(chunk)}\n\n".encode() for chunk in chunks) + b"data: [DONE]\n\n"


def start_mock(body: dict, arguments: dict, expect: str) -> tuple[int, http.server.ThreadingHTTPServer]:
    """The plugin's upstream (any path) and an OpenAI-compatible model (`/v1/chat/completions`) on one port."""
    payload = json.dumps(body).encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        # Headers and body are separate writes: without this, Nagle and delayed ACKs add ~40 ms per request.
        disable_nagle_algorithm = True

        def answer(self) -> None:
            length = int(self.headers.get("content-length") or 0)
            request_body = self.rfile.read(length) if length else b""
            is_model = self.path.endswith("/chat/completions")
            reply = model_reply(json.loads(request_body or b"{}"), arguments, expect) if is_model else payload
            self.send_response(200)
            self.send_header("content-type", "text/event-stream" if is_model else "application/json")
            self.send_header("content-length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        do_GET = do_POST = answer

        def log_message(self, *_args) -> None:
            pass

    port = free_port()
    while len(str(port)) != 5:
        port = free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return port, server


def local_base(original: str, port: int) -> str:
    prefix = f"http://127.0.0.1:{port}/"
    if len(prefix) >= len(original):
        sys.exit(f"rest_plugins: base URL {original} is too short to patch")
    return prefix + "p" * (len(original) - len(prefix))


def patched_copy(source: Path, work: Path, files: list[str], original: str, replacement: str) -> Path:
    target = work / source.name
    shutil.copytree(source, target, ignore=shutil.ignore_patterns("test", "*.md"))
    found = 0
    for relative in files:
        path = target / relative
        data = path.read_bytes()
        found += data.count(original.encode())
        path.write_bytes(data.replace(original.encode(), replacement.encode()))
    if found == 0:
        sys.exit(f"rest_plugins: {original} not found in {source} {files}")
    return target


def write_workflow(work: Path, kind: str, config: dict, mode: str) -> Path:
    if mode == "node":
        call = {"id": "call", "type": kind, **config}
        answer = "{{#call.data#}}"
    else:
        plugin, _, operation = kind.partition(".")
        call = {"id": "call", "type": "agent", "model": {"provider": "openai", "name": "mock"},
                "instruction": "Use the tool.", "query": "Go.", "tools": [f"{plugin}/{operation}"], "max_iterations": 2}
        answer = "{{#call.text#}}"
    workflow = {
        "version": "1", "name": "bench",
        "graph": {
            "nodes": [{"id": "start", "type": "start", "variables": []}, call, {"id": "done", "type": "answer", "answer": answer}],
            "edges": [{"source": "start", "target": "call"}, {"source": "call", "target": "done"}],
        },
    }
    path = work / "bench.yaml"
    path.write_text(json.dumps(workflow))
    return path


def run_args(plugin_dir: Path, name: str) -> list[str]:
    return ["--plugins", str(plugin_dir), "--no-default-plugins", "--trust-plugin", name, "--allow-private-network"]


def cold_runs(graphrt: Path, workflow: Path, plugin_dir: Path, name: str, env: dict, expect: str, samples: int) -> list[float]:
    command = [str(graphrt), "run", str(workflow), *run_args(plugin_dir, name)]
    times = []
    for _ in range(samples):
        began = time.perf_counter()
        done = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
        times.append((time.perf_counter() - began) * 1000)
        if done.returncode != 0 or expect not in done.stdout:
            sys.exit(f"rest_plugins: cold run failed ({plugin_dir}): {done.stdout[-500:]} {done.stderr[-1500:]}")
    return times


def stream_run(port: int, expect: str) -> float:
    body = json.dumps({"stream": True, "inputs": {}})
    began = time.perf_counter()
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    connection.request("POST", "/v1/workflows/bench/runs", body, {"content-type": "application/json"})
    response = connection.getresponse()
    text = b""
    while b"event: run_succeeded" not in text and b"event: run_failed" not in text:
        chunk = response.read1(65536)
        if not chunk:
            break
        text += chunk
    elapsed = (time.perf_counter() - began) * 1000
    connection.close()
    if b"event: run_succeeded" not in text or expect.encode() not in text:
        sys.exit(f"rest_plugins: warm run failed: {text[-800:]!r}")
    return elapsed


def warm_runs(graphrt: Path, workflow: Path, plugin_dir: Path, name: str, env: dict, expect: str, samples: int) -> tuple[list[float], dict]:
    port = free_port()
    command = [str(graphrt), "serve", str(workflow), "--addr", f"127.0.0.1:{port}", *run_args(plugin_dir, name)]
    server = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        deadline = time.time() + 15
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                if server.poll() is not None or time.time() > deadline:
                    sys.exit(f"rest_plugins: serve did not start: {server.stderr.read().decode()[-1500:]}")
                time.sleep(0.02)
        idle = tree_rss_mib(server.pid)
        first = stream_run(port, expect)
        times = [stream_run(port, expect) for _ in range(samples)]
        return times, {"idle_mib": idle, "after_runs_mib": tree_rss_mib(server.pid), "first_run_ms": round(first, 2)}
    finally:
        server.terminate()
        server.wait(timeout=10)


def bench_plugin(args: argparse.Namespace, name: str, work: Path) -> dict:
    files, original, kind, config, extra_env, body, expect = SCENARIOS[name]
    port, mock = start_mock(body, config, expect)
    try:
        replacement = local_base(original, port)
        wasm_dir = args.plugins_repo / "wasm" / WASM_DIRS[name]
        module = json.loads((wasm_dir / "graphrt-plugin.json").read_text())["module"]
        builds = {
            "node": (args.plugins_repo / name, patched_copy(args.plugins_repo / name, work / "node", files, original, replacement)),
            "wasm": (wasm_dir, patched_copy(wasm_dir, work / "wasm", [module], original, replacement)),
        }
        workflow = write_workflow(work, kind, config, args.mode)
        env = {key: value for key, value in os.environ.items() if not key.startswith(("GRAPHRT_", "OPENAI_"))}
        env.update(extra_env)
        env.update({"OPENAI_API_KEY": "mock", "OPENAI_BASE_URL": f"http://127.0.0.1:{port}/v1"})
        results = {}
        for label, (source_dir, plugin_dir) in builds.items():
            warm, rss = warm_runs(args.graphrt, workflow, plugin_dir, name, env, expect, args.warm)
            cold = cold_runs(args.graphrt, workflow, plugin_dir, name, env, expect, args.cold)
            results[label] = {"dir": str(source_dir), "disk_bytes": disk_bytes(source_dir), "cold_run_ms": summary(cold),
                              "warm_run_ms": summary(warm), **rss}
            print(f"{name} {args.mode} {label}: {json.dumps(results[label])}", flush=True)
        return results
    finally:
        mock.shutdown()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--graphrt", type=Path, required=True, help="graphrt build with serve, plugins, wasm and http")
    parser.add_argument("--plugins-repo", type=Path, default=HERE.parent.parent, help="graphrt-plugins checkout (default: this one)")
    parser.add_argument("--plugin", action="append", choices=sorted(SCENARIOS), help="default: all")
    parser.add_argument("--mode", choices=["node", "agent"], default="node", help="workflow node or agent tool")
    parser.add_argument("--cold", type=int, default=50)
    parser.add_argument("--warm", type=int, default=300)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    args.plugins_repo, args.graphrt = args.plugins_repo.resolve(), args.graphrt.resolve()
    results = {}
    for name in args.plugin or list(SCENARIOS):
        with tempfile.TemporaryDirectory(prefix=f"rest-bench-{name}-") as work:
            results[name] = bench_plugin(args, name, Path(work))
    if args.json:
        args.json.write_text(json.dumps({"graphrt": str(args.graphrt), "mode": args.mode, "results": results}, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
