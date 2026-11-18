import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createJxaRunner, JXA_SCRIPT_NAMES, loadJxaSource, OSASCRIPT_PATH, parseJxaOutput } from "../lib/jxa-runner.mjs";
import { mapOsascriptFailure, mapScreenCaptureFailure, mapScriptFailure } from "../lib/osascript-errors.mjs";
import { runProcess } from "../lib/process-runner.mjs";

/** A child-process double: records stdin, can emit output and exit, records kill signals. */
function createFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.killSignals = [];
  child.stdinText = "";
  child.stdin.on("data", (chunk) => (child.stdinText += chunk));
  child.kill = (signalName) => {
    child.killed = true;
    child.killSignals.push(signalName);
  };
  child.finish = (exitCode, stdoutText = "", stderrText = "") => {
    child.stdout.end(stdoutText);
    child.stderr.end(stderrText);
    setImmediate(() => {
      child.exitCode = exitCode;
      child.emit("close", exitCode);
    });
  };
  return child;
}

function createFakeSpawn(onSpawn) {
  const spawnCalls = [];
  const fakeSpawn = (file, args, options) => {
    const child = createFakeChild();
    spawnCalls.push({ file, args, options, child });
    onSpawn?.(child);
    return child;
  };
  fakeSpawn.calls = spawnCalls;
  return fakeSpawn;
}

test("runJxa passes input as JSON on stdin and never inside the script source", async () => {
  const recordedRuns = [];
  const runJxa = createJxaRunner({
    runProcessImpl: async (file, args, options) => {
      recordedRuns.push({ file, args, options });
      return { exitCode: 0, stdout: '{"ok":true,"result":{"done":1}}\n', stderr: "" };
    },
  });
  const hostileInput = { app: 'Finder"); doShellScript("rm -rf ~', text: "`${evil}`" };
  const result = await runJxa("focus_app", hostileInput, { timeoutMs: 1234 });
  assert.deepEqual(result, { done: 1 });
  const [run] = recordedRuns;
  assert.equal(run.file, OSASCRIPT_PATH);
  assert.deepEqual(run.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.equal(run.args[3], loadJxaSource("focus_app"));
  assert.ok(!run.args[3].includes("doShellScript"));
  assert.deepEqual(JSON.parse(run.options.stdinText), hostileInput);
  assert.equal(run.options.timeoutMs, 1234);
});

test("loadJxaSource only loads known scripts and prepends the prelude", () => {
  assert.throws(() => loadJxaSource("../../etc/passwd"), /Unknown JXA script/);
  for (const scriptName of JXA_SCRIPT_NAMES) {
    const source = loadJxaSource(scriptName);
    assert.match(source, /function run\(\)/);
    assert.match(source, /function main\(/);
  }
});

test("parseJxaOutput maps structured script failures", () => {
  const failureOutput = (error) => ({ exitCode: 0, stdout: JSON.stringify({ ok: false, error }), stderr: "" });
  assert.equal(capture(() => parseJxaOutput(failureOutput({ kind: "stale_ref", message: "Element w1/3 no longer exists; call read_ui again" }))).kind, "not_found");
  assert.equal(capture(() => parseJxaOutput(failureOutput({ kind: "not_found", message: "App is not running" }))).kind, "not_found");
  assert.equal(capture(() => parseJxaOutput(failureOutput({ kind: "invalid_input", message: "outside" }))).kind, "invalid_input");
  assert.equal(capture(() => parseJxaOutput(failureOutput({ kind: "action_failed", message: "no" }))).kind, "action_failed");
  const accessibilityError = capture(() => parseJxaOutput(failureOutput({ kind: "accessibility_denied", message: "x" })));
  assert.equal(accessibilityError.kind, "permission_denied");
  assert.match(accessibilityError.message, /System Settings → Privacy & Security → Accessibility/);
  const scriptError = capture(() => parseJxaOutput(failureOutput({ kind: "script_error", message: "System Events got an error: osascript is not allowed assistive access.", number: -1719 })));
  assert.equal(scriptError.kind, "permission_denied");
  assert.equal(capture(() => parseJxaOutput({ exitCode: 0, stdout: "not json", stderr: "" })).kind, "plugin_error");
  const focusLost = capture(() => parseJxaOutput(failureOutput({ kind: "permission_denied", message: "focus left WhatsApp; stopped" })));
  assert.equal(focusLost.kind, "permission_denied");
  assert.equal(focusLost.message, "focus left WhatsApp; stopped");
});

const OSASCRIPT_FAILURES = [
  ["execution error: System Events got an error: osascript is not allowed assistive access. (-1719)", "permission_denied", /Accessibility/],
  ["execution error: Error: AX API disabled (-25211)", "permission_denied", /Accessibility/],
  ["execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)", "permission_denied", /Accessibility/],
  ["execution error: Not authorized to send Apple events to System Events. (-1743)", "permission_denied", /Automation/],
  ["execution error: Error: Application can't be found. (-2700)", "not_found", /App not found/],
  ["execution error: Error: SyntaxError: Unexpected token (-2700)", "plugin_error", /osascript failed/],
  // -1719 alone is also AppleScript's "invalid index", and "accessibility" can appear in any AX error text.
  ["execution error: Error: Invalid index. (-1719)", "plugin_error", /osascript failed/],
  ["execution error: Error: Can't get accessibility description of element. (-1728)", "plugin_error", /osascript failed/],
];

for (const [stderrText, expectedKind, expectedMessage] of OSASCRIPT_FAILURES) {
  test(`osascript failure "${stderrText.slice(17, 70)}" → ${expectedKind}`, () => {
    const error = capture(() => parseJxaOutput({ exitCode: 1, stdout: "", stderr: stderrText }));
    assert.equal(error.kind, expectedKind);
    assert.match(error.message, expectedMessage);
  });
}

test("mapScriptFailure falls back to text mapping for unknown kinds", () => {
  assert.equal(mapScriptFailure(undefined).kind, "plugin_error");
  assert.equal(mapOsascriptFailure("").message, "osascript failed: no error output");
});

test("screencapture failures map to permission_denied naming Screen Recording", () => {
  for (const stderrText of ["could not create image from display", ""]) {
    const error = mapScreenCaptureFailure(stderrText);
    assert.equal(error.kind, "permission_denied");
    assert.match(error.message, /Screen & System Audio Recording/);
  }
  assert.equal(mapScreenCaptureFailure("invalid region").kind, "plugin_error");
  assert.equal(mapScreenCaptureFailure("could not write file: permission denied").kind, "plugin_error");
});

test("runProcess writes stdin, collects output and resolves on close", async () => {
  const fakeSpawn = createFakeSpawn((child) => setImmediate(() => child.finish(0, "out ✓", "err")));
  const result = await runProcess("/usr/bin/osascript", ["-e", "x"], { stdinText: '{"a":1}', spawnProcess: fakeSpawn });
  assert.deepEqual(result, { exitCode: 0, stdout: "out ✓", stderr: "err" });
  assert.equal(fakeSpawn.calls[0].child.stdinText, '{"a":1}');
  assert.deepEqual(fakeSpawn.calls[0].args, ["-e", "x"]);
});

test("runProcess kills the process on timeout", async () => {
  const fakeSpawn = createFakeSpawn();
  await assert.rejects(runProcess("/usr/bin/osascript", [], { timeoutMs: 5, spawnProcess: fakeSpawn }), (error) => error.kind === "timeout");
  assert.deepEqual(fakeSpawn.calls[0].child.killSignals, ["SIGKILL"]);
});

test("runProcess kills the process when cancelled", async () => {
  const controller = new AbortController();
  const fakeSpawn = createFakeSpawn(() => setImmediate(() => controller.abort()));
  await assert.rejects(runProcess("/usr/bin/osascript", [], { signal: controller.signal, spawnProcess: fakeSpawn }), (error) => error.kind === "cancelled");
  assert.deepEqual(fakeSpawn.calls[0].child.killSignals, ["SIGKILL"]);
});

test("runProcess does not start when already cancelled", async () => {
  const fakeSpawn = createFakeSpawn();
  await assert.rejects(runProcess("/usr/bin/osascript", [], { signal: AbortSignal.abort(), spawnProcess: fakeSpawn }), (error) => error.kind === "cancelled");
  assert.equal(fakeSpawn.calls.length, 0);
});

test("runProcess reports a process that cannot start", async () => {
  const fakeSpawn = createFakeSpawn((child) => setImmediate(() => child.emit("error", new Error("spawn ENOENT"))));
  await assert.rejects(runProcess("/nope", [], { spawnProcess: fakeSpawn }), (error) => error.kind === "plugin_error" && /ENOENT/.test(error.message));
});

test("runProcess runs a real child process without a shell", async () => {
  const echoScript = "process.stdin.pipe(process.stdout)";
  const result = await runProcess(process.execPath, ["-e", echoScript], { stdinText: "héllo $(whoami)" });
  assert.deepEqual(result, { exitCode: 0, stdout: "héllo $(whoami)", stderr: "" });
});

function capture(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}
