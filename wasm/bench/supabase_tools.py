#!/usr/bin/env python3
"""Node.js plugin vs WebAssembly build of the supabase tools (default tool mode), through a real agent.

Runs agent.yaml next to this script (one `select_rows` tool call per run, the model and Supabase mocked here) once
per plugin directory, and measures like graphrt's bench/wasm-plugin/supabase_tool.py:

- cold: `graphrt run` per sample, exec -> exit (process start, plugin load or start, two model turns, one tool call);
- warm: one `graphrt serve`, sequential streamed runs, request -> run_succeeded;
- RSS of the serve process plus its children (the Node.js host) after the warm runs;
- the plugin's files on disk.

It also checks every run's Supabase request (path, query, apikey), so both builds are measured doing the same work.
Standard library only.

  wasm/bench/supabase_tools.py --graphrt BIN --plugin node=supabase --plugin wasm=wasm/supabase \\
      [--cold 50] [--warm 300] [--json OUT]
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
AGENT = HERE / "agent.yaml"
KEY = "sb_publishable_bench_0123456789"
EXPECTED_PATH = "/rest/v1/profiles?select=id%2Cdisplay_name&and=%28id.eq.%221%22%29&limit=5"
TOOL_ARGUMENTS = {"table": "profiles", "columns": "id,display_name", "filters": [{"column": "id", "operator": "eq", "value": 1}], "limit": 5}
seen_requests: list[dict] = []


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, max(0, round(fraction * len(ordered)) - 1))], 2)


def summary(values: list[float]) -> dict:
    return {"p50": percentile(values, 0.5), "p95": percentile(values, 0.95), "samples": len(values)}


def sse(handler: BaseHTTPRequestHandler, chunks: list[dict]) -> None:
    handler.send_response(200)
    handler.send_header("content-type", "text/event-stream")
    handler.end_headers()
    for chunk in chunks:
        handler.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
    handler.wfile.write(b"data: [DONE]\n\n")


def chunk(delta: dict, finish_reason: str | None = None) -> dict:
    return {"id": "mock", "object": "chat.completion.chunk", "model": "mock", "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}


class OpenAi(BaseHTTPRequestHandler):
    """First turn: call the first tool with TOOL_ARGUMENTS; then answer with the row's display_name."""

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        results = [message for message in request.get("messages", []) if message.get("role") == "tool"]
        if not results:
            call = {"index": 0, "id": "call_1", "type": "function", "function": {"name": request["tools"][0]["function"]["name"], "arguments": json.dumps(TOOL_ARGUMENTS)}}
            sse(self, [chunk({"role": "assistant", "tool_calls": [call]}), chunk({}, "tool_calls")])
            return
        name = "Ada" if "Ada" in str(results[-1].get("content")) else "unknown"
        sse(self, [chunk({"role": "assistant", "content": f"Your display name is {name}."}), chunk({}, "stop")])


class Supabase(BaseHTTPRequestHandler):
    """The Data API: one profile row."""

    def log_message(self, *_):
        pass

    def do_GET(self):
        seen_requests.append({"path": self.path, "apikey": self.headers.get("apikey")})
        payload = json.dumps([{"id": 1, "display_name": "Ada"}]).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def plugin_env(openai_port: int, supabase_port: int) -> dict:
    env = {name: value for name, value in os.environ.items() if not name.startswith(("GRAPHRT_", "SUPABASE_", "OPENAI_"))}
    env.update({"OPENAI_API_KEY": "mock", "OPENAI_BASE_URL": f"http://127.0.0.1:{openai_port}/v1", "SUPABASE_URL": f"http://127.0.0.1:{supabase_port}", "SUPABASE_KEY": KEY})
    return env


def plugin_args(plugin_dir: Path) -> list[str]:
    return ["--plugins", str(plugin_dir), "--no-default-plugins", "--allow-private-network"]


def check_requests(label: str, runs: int) -> None:
    wrong = [request for request in seen_requests if request != {"path": EXPECTED_PATH, "apikey": KEY}]
    if len(seen_requests) != runs or wrong:
        sys.exit(f"supabase_tools: {label} sent {len(seen_requests)} Supabase requests for {runs} runs; unexpected: {wrong[:2]}")
    seen_requests.clear()


def cold_runs(graphrt: Path, plugin_dir: Path, env: dict, samples: int) -> list[float]:
    command = [str(graphrt), "run", str(AGENT), *plugin_args(plugin_dir), "--input", "message=What is my display name?"]
    times = []
    for _ in range(samples):
        began = time.perf_counter()
        done = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
        times.append((time.perf_counter() - began) * 1000)
        if done.returncode != 0 or "Ada" not in done.stdout:
            sys.exit(f"supabase_tools: cold run failed ({plugin_dir}): {done.stdout[-500:]} {done.stderr[-1500:]}")
    return times


def stream_run(port: int) -> float:
    body = json.dumps({"stream": True, "inputs": {"message": "What is my display name?"}})
    began = time.perf_counter()
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    connection.request("POST", "/v1/workflows/agent/runs", body, {"content-type": "application/json"})
    response = connection.getresponse()
    text = b""
    while b"event: run_succeeded" not in text and b"event: run_failed" not in text:
        data = response.read1(65536)
        if not data:
            break
        text += data
    elapsed = (time.perf_counter() - began) * 1000
    connection.close()
    if b"event: run_succeeded" not in text or b"Ada" not in text:
        sys.exit(f"supabase_tools: warm run failed: {text[-800:]!r}")
    return elapsed


def tree_rss_mib(pid: int) -> float:
    """RSS of `pid` and its descendants (ps works on Linux and macOS)."""
    table = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,rss="], capture_output=True, text=True).stdout
    rows = [tuple(int(field) for field in line.split()) for line in table.splitlines() if line.strip()]
    family, changed = {pid}, True
    while changed:
        changed = False
        for child, parent, _ in rows:
            if parent in family and child not in family:
                family.add(child)
                changed = True
    return round(sum(rss for child, _, rss in rows if child in family) / 1024, 1)


def warm_runs(graphrt: Path, plugin_dir: Path, env: dict, samples: int) -> tuple[list[float], dict]:
    port = free_port()
    command = [str(graphrt), "serve", str(AGENT), "--addr", f"127.0.0.1:{port}", *plugin_args(plugin_dir)]
    server = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        deadline = time.time() + 15
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                if server.poll() is not None or time.time() > deadline:
                    sys.exit(f"supabase_tools: serve did not start: {server.stderr.read().decode()[-1500:]}")
                time.sleep(0.02)
        idle = tree_rss_mib(server.pid)
        first = stream_run(port)
        times = [stream_run(port) for _ in range(samples)]
        return times, {"idle_mib": idle, "after_runs_mib": tree_rss_mib(server.pid), "first_run_ms": round(first, 2)}
    finally:
        server.terminate()
        server.wait(timeout=10)


# What an install holds: no tests, sources or build output.
SKIPPED_PARTS = {"test", "target", "src", "node_modules", "crates", "bench"}


def disk_bytes(plugin_dir: Path) -> int:
    files = [path for path in plugin_dir.rglob("*") if path.is_file()]
    return sum(path.stat().st_size for path in files if not SKIPPED_PARTS & set(path.relative_to(plugin_dir).parts))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--graphrt", type=Path, required=True, help="graphrt build with serve, llm, plugins, wasm and http")
    parser.add_argument("--plugin", action="append", required=True, help="LABEL=DIR, e.g. node=supabase or wasm=wasm/supabase")
    parser.add_argument("--cold", type=int, default=50)
    parser.add_argument("--warm", type=int, default=300)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    openai_port, supabase_port = free_port(), free_port()
    for handler, port in ((OpenAi, openai_port), (Supabase, supabase_port)):
        threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever, daemon=True).start()
    env = plugin_env(openai_port, supabase_port)
    results = {}
    for spec in args.plugin:
        label, _, directory = spec.partition("=")
        plugin_dir = Path(directory).resolve()
        warm, rss = warm_runs(args.graphrt, plugin_dir, env, args.warm)
        check_requests(label, args.warm + 1)
        cold = cold_runs(args.graphrt, plugin_dir, env, args.cold)
        check_requests(label, args.cold)
        results[label] = {"dir": str(plugin_dir), "disk_bytes": disk_bytes(plugin_dir), "cold_run_ms": summary(cold), "warm_run_ms": summary(warm), **rss}
        print(f"{label}: {json.dumps(results[label])}", flush=True)
    if args.json:
        args.json.write_text(json.dumps({"graphrt": str(args.graphrt), "results": results}, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
