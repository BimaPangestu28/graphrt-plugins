/**
 * On macOS: the real notification script compiles with osacompile (compiling never runs it, so nothing is shown).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTIFICATION_SCRIPT_LINES } from "../lib/notification-script.mjs";

const skip = process.platform !== "darwin" || !existsSync("/usr/bin/osacompile") ? "needs macOS osacompile" : false;

test("NOTIFICATION_SCRIPT_LINES compile as AppleScript", { skip }, async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "graphrt-osacompile-"));
  try {
    const compiledPath = join(outputDirectory, "notify.scpt");
    const result = spawnSync("/usr/bin/osacompile", ["-o", compiledPath, ...NOTIFICATION_SCRIPT_LINES.flatMap((line) => ["-e", line])], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await stat(compiledPath)).size > 0);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
