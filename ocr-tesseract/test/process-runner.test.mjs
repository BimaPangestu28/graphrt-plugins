/**
 * The process runner with real child processes (node itself): exit codes, output caps, timeouts, cancel,
 * missing programs, and no shell. Identical in the ffmpeg and ocr-tesseract plugins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProcessRunner } from "../lib/process-runner.mjs";

const runProcess = createProcessRunner();
const baseRequest = { command: process.execPath, timeoutMs: 10000, maxStdoutBytes: 1000, displayName: "test program", setupHint: "Install it." };

test("collects stdout and stderr and reports the exit code", async () => {
  const result = await runProcess({ ...baseRequest, args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3"] });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout.toString(), "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.stdoutTruncated, false);
});

test("stdout over the cap is cut, flagged and the program is stopped", async () => {
  const result = await runProcess({ ...baseRequest, maxStdoutBytes: 10, args: ["-e", "setInterval(() => process.stdout.write('x'.repeat(100)), 5)"] });
  assert.equal(result.stdout.length, 10);
  assert.equal(result.stdoutTruncated, true);
});

test("a program past its timeout is killed with a timeout error", async () => {
  const startedAt = Date.now();
  await assert.rejects(runProcess({ ...baseRequest, timeoutMs: 200, args: ["-e", "setTimeout(() => {}, 60000)"] }), { kind: "timeout" });
  assert.ok(Date.now() - startedAt < 5000);
});

test("cancel kills the program; an already-aborted signal never starts it", async () => {
  const controller = new AbortController();
  const running = runProcess({ ...baseRequest, signal: controller.signal, args: ["-e", "setTimeout(() => {}, 60000)"] });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, { kind: "cancelled" });
  await assert.rejects(runProcess({ ...baseRequest, signal: AbortSignal.abort(), args: ["-e", ""] }), { kind: "cancelled" });
});

test("a missing program is setup_required with the hint", async () => {
  await assert.rejects(runProcess({ ...baseRequest, command: "/nonexistent/graphrt-missing-program", args: [] }), (error) => error.kind === "setup_required" && /Install it\./.test(error.message));
});

test("arguments are passed verbatim, never through a shell", async () => {
  const shellText = "$(echo hacked); `id` | cat > /tmp/x";
  const result = await runProcess({ ...baseRequest, args: ["-e", "process.stdout.write(process.argv[1])", shellText] });
  assert.equal(result.stdout.toString(), shellText);
});
