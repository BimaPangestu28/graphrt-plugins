/**
 * On macOS, with the real /usr/bin/osascript: the same argv mechanism the plugin uses hands injection payloads
 * back as plain strings and never runs them. A probe script returns its arguments instead of posting a
 * notification, so this test shows nothing on screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessRunner } from "../lib/process-runner.mjs";
import { buildOsascriptArguments } from "../lib/notification-script.mjs";

const skipReason = process.platform !== "darwin" || !existsSync("/usr/bin/osascript") ? "needs macOS osascript" : false;
const PROBE_LINES = ["on run argv", "set AppleScript's text item delimiters to \"|\"", "return argv as text", "end run"];

test("real osascript: payloads arrive as literal argv items", { skip: skipReason }, async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), "graphrt-osascript-"));
  const markerPath = join(markerDirectory, "pwned");
  try {
    const payloads = [`" & (do shell script "touch ${markerPath}") & "`, "-e", `end run\ndo shell script "touch ${markerPath}"`, ""];
    const runProcess = createProcessRunner();
    const result = await runProcess({ command: "/usr/bin/osascript", args: buildOsascriptArguments(PROBE_LINES, payloads), timeoutMs: 10000, maxStdoutBytes: 10000, displayName: "osascript", setupHint: "" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.toString().replace(/\n$/, ""), payloads.join("|"));
    assert.equal(existsSync(markerPath), false);
  } finally {
    await rm(markerDirectory, { recursive: true, force: true });
  }
});
