/**
 * snapshot, list_changes and wait_for_change over real temp directories, with an injected clock and sleep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { createPluginDefinition, pluginDefinition } from "../definition.mjs";
import { decodeCursor, encodeCursor } from "../lib/cursor.mjs";

const AS_TOOL = { source: "tool" };

async function withWatcher({ environment = {}, onSleep } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-file-watcher-test-")));
  const directories = { watched: join(baseDirectory, "watched"), lookalike: join(baseDirectory, "watched-evil"), outside: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const clock = { nowMs: 1_000_000, sleeps: [] };
  const definition = createPluginDefinition({
    now: () => clock.nowMs,
    sleep: async (milliseconds) => {
      clock.sleeps.push(milliseconds);
      clock.nowMs += milliseconds;
      await onSleep?.(clock.sleeps.length, directories);
    },
  });
  const runOperation = createOperationRunner(definition, { FILE_WATCHER_ALLOWED_DIRS: directories.watched, ...environment });
  try {
    return await work({ runOperation, clock, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

async function touch(filePath, content, mtimeSeconds) {
  await writeFile(filePath, content);
  if (mtimeSeconds) await utimes(filePath, mtimeSeconds, mtimeSeconds);
}

test("snapshot then list_changes reports added, modified and removed files and a new cursor", async () => {
  await withWatcher({}, async ({ runOperation, watched }) => {
    await touch(join(watched, "keep.txt"), "same", 1000);
    await touch(join(watched, "edit.txt"), "v1", 1000);
    await touch(join(watched, "gone.txt"), "x", 1000);
    const first = await runOperation("snapshot", { path: "." }, AS_TOOL);
    assert.equal(first.data.entry_count, 3);
    assert.match(first.data.cursor, /^fw1\./);
    await touch(join(watched, "edit.txt"), "version 2", 2000);
    await unlink(join(watched, "gone.txt"));
    await touch(join(watched, "new.txt"), "n", 1000);
    const changes = await runOperation("list_changes", { cursor: first.data.cursor }, AS_TOOL);
    assert.deepEqual(changes.data.added.map((entry) => entry.path), ["new.txt"]);
    assert.deepEqual(changes.data.modified.map((entry) => entry.path), ["edit.txt"]);
    assert.deepEqual(changes.data.removed.map((entry) => entry.path), ["gone.txt"]);
    assert.equal(changes.data.has_changes, true);
    const again = await runOperation("list_changes", { cursor: changes.data.cursor }, AS_TOOL);
    assert.equal(again.data.has_changes, false);
  });
});

test("recursion is bounded by max_depth; name_pattern and hidden files filter the snapshot", async () => {
  await withWatcher({}, async ({ runOperation, watched }) => {
    await mkdir(join(watched, "a", "b"), { recursive: true });
    await touch(join(watched, "a", "b", "deep.csv"), "x");
    await touch(join(watched, "top.csv"), "x");
    await touch(join(watched, "top.txt"), "x");
    await touch(join(watched, ".hidden.csv"), "x");
    const shallow = await runOperation("snapshot", { path: ".", max_depth: 1, name_pattern: "*.csv" }, AS_TOOL);
    assert.equal(shallow.data.entry_count, 1);
    const deep = await runOperation("snapshot", { path: ".", max_depth: 3, name_pattern: "*.csv", include_hidden: true }, AS_TOOL);
    assert.equal(deep.data.entry_count, 3);
  });
});

test("symlinks are recorded, never followed; outside, lookalike and symlinked directories are not_found", async () => {
  await withWatcher({}, async ({ runOperation, watched, outside, lookalike }) => {
    await touch(join(outside, "secret.txt"), "x");
    await symlink(outside, join(watched, "escape"));
    const { data } = await runOperation("snapshot", { path: ".", max_depth: 5 }, AS_TOOL);
    assert.equal(data.entry_count, 1);
    for (const path of [outside, lookalike, join(watched, "escape"), join(watched, "..", "outside")]) {
      await assert.rejects(runOperation("snapshot", { path }, AS_TOOL), { kind: "not_found" }, path);
    }
  });
});

test("FILE_WATCHER_MAX_ENTRIES caps a snapshot and marks it truncated", async () => {
  await withWatcher({ environment: { FILE_WATCHER_MAX_ENTRIES: "10" } }, async ({ runOperation, watched }) => {
    for (let index = 0; index < 15; index += 1) await touch(join(watched, `f${String(index).padStart(2, "0")}.txt`), "x");
    const { data } = await runOperation("snapshot", { path: "." }, AS_TOOL);
    assert.equal(data.entry_count, 10);
    assert.equal(data.truncated, true);
  });
});

test("a cursor is re-checked: tampered, foreign or out-of-allowlist cursors are refused", async () => {
  await withWatcher({}, async ({ runOperation, outside }) => {
    await assert.rejects(runOperation("list_changes", { cursor: "fw1.not-base64!!" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("list_changes", { cursor: "something-else" }, AS_TOOL), { kind: "invalid_input" });
    const foreign = encodeCursor({ root: outside, options: { maxDepth: 1, includeHidden: false, namePattern: null }, takenAt: 0, truncated: false, entries: [] });
    await assert.rejects(runOperation("list_changes", { cursor: foreign }, AS_TOOL), { kind: "not_found" });
  });
});

test("cursor round trip keeps entries; a decompression bomb is refused", () => {
  const snapshot = { root: "/x", options: { maxDepth: 2, includeHidden: false, namePattern: "*.md" }, takenAt: 5, truncated: false, entries: [["a.md", "file", 3, 1000]] };
  assert.deepEqual(decodeCursor(encodeCursor(snapshot)), snapshot);
  const bomb = encodeCursor({ ...snapshot, entries: Array.from({ length: 300000 }, (unused, index) => [`file-${index}.md`, "file", 1, 1]) });
  assert.throws(() => decodeCursor(bomb, { maxBytes: 1024 * 1024 }), { kind: "invalid_input" });
});

test("wait_for_change returns as soon as a poll sees a change", async () => {
  const onSleep = async (sleepCount, { watched }) => {
    if (sleepCount === 2) await touch(join(watched, "arrived.txt"), "x");
  };
  await withWatcher({ onSleep }, async ({ runOperation, clock }) => {
    const { data } = await runOperation("wait_for_change", { path: ".", timeout_seconds: 30, poll_interval_ms: 500 }, AS_TOOL);
    assert.equal(data.changed, true);
    assert.deepEqual(data.added.map((entry) => entry.path), ["arrived.txt"]);
    assert.deepEqual(clock.sleeps, [500, 500]);
    assert.equal(data.waited_ms, 1000);
    assert.match(data.cursor, /^fw1\./);
  });
});

test("wait_for_change from a cursor reports changes that happened before the call at once", async () => {
  await withWatcher({}, async ({ runOperation, watched, clock }) => {
    const { data: first } = await runOperation("snapshot", { path: "." }, AS_TOOL);
    await touch(join(watched, "early.txt"), "x");
    const { data } = await runOperation("wait_for_change", { cursor: first.cursor, timeout_seconds: 10 }, AS_TOOL);
    assert.equal(data.changed, true);
    assert.deepEqual(clock.sleeps, []);
  });
});

test("wait_for_change times out cleanly with changed: false and a cursor to continue from", async () => {
  await withWatcher({}, async ({ runOperation, clock }) => {
    const { data } = await runOperation("wait_for_change", { path: ".", timeout_seconds: 3, poll_interval_ms: 1000 }, AS_TOOL);
    assert.equal(data.changed, false);
    assert.equal(data.waited_ms, 3000);
    assert.equal(clock.sleeps.reduce((total, milliseconds) => total + milliseconds, 0), 3000);
    assert.match(data.cursor, /^fw1\./);
  });
});

test("wait_for_change stops when cancelled", async () => {
  await withWatcher({}, async ({ runOperation }) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runOperation("wait_for_change", { path: ".", timeout_seconds: 30 }, { source: "tool", signal: controller.signal }), { kind: "cancelled" });
  });
});

test("wait_for_change needs a path or a cursor", async () => {
  await withWatcher({}, async ({ runOperation }) => {
    await assert.rejects(runOperation("wait_for_change", {}, AS_TOOL), { kind: "invalid_input" });
  });
});

test("manifest: local only, the timeout covers the longest wait, three tools", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.permissions.network, false);
  assert.ok(manifest.limits.timeout_ms >= 300000 + 15000);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["snapshot", "list_changes", "wait_for_change"]);
});

const SAFE_OPTIONS = { maxDepth: 1, includeHidden: false, namePattern: null };
const isRefusal = (error) => ["invalid_input", "not_found"].includes(error.kind);

test("forged cursors: a relative root is refused and never walks the process cwd", async () => {
  await withWatcher({}, async ({ runOperation }) => {
    for (const root of [".", "", "watched", "../outside"]) {
      const forged = encodeCursor({ root, options: SAFE_OPTIONS, takenAt: 0, truncated: false, entries: [] });
      await assert.rejects(runOperation("list_changes", { cursor: forged }, AS_TOOL), isRefusal, root);
      await assert.rejects(runOperation("wait_for_change", { cursor: forged, timeout_seconds: 1 }, AS_TOOL), isRefusal, root);
    }
  });
});

test("forged cursors: a root that is a symlink (even to an allowed directory) is refused", async () => {
  await withWatcher({}, async ({ runOperation, watched }) => {
    await mkdir(join(watched, "real"));
    await symlink(join(watched, "real"), join(watched, "alias"));
    const forged = encodeCursor({ root: join(watched, "alias"), options: SAFE_OPTIONS, takenAt: 0, truncated: false, entries: [] });
    await assert.rejects(runOperation("list_changes", { cursor: forged }, AS_TOOL), { kind: "invalid_input", message: /canonical/ });
  });
});

test("forged cursors: options outside the schema limits are refused", async () => {
  await withWatcher({}, async ({ runOperation, watched }) => {
    const badOptions = [
      { ...SAFE_OPTIONS, maxDepth: 1000 },
      { ...SAFE_OPTIONS, maxDepth: 0 },
      { ...SAFE_OPTIONS, includeHidden: "yes" },
      { ...SAFE_OPTIONS, namePattern: "x".repeat(10000) },
      { ...SAFE_OPTIONS, namePattern: 5 },
    ];
    for (const options of badOptions) {
      const forged = encodeCursor({ root: watched, options, takenAt: 0, truncated: false, entries: [] });
      await assert.rejects(runOperation("list_changes", { cursor: forged }, AS_TOOL), { kind: "invalid_input" }, JSON.stringify(options).slice(0, 80));
    }
  });
});

test("forged cursors: more entries than FILE_WATCHER_MAX_ENTRIES are refused", async () => {
  await withWatcher({ environment: { FILE_WATCHER_MAX_ENTRIES: "10" } }, async ({ runOperation, watched }) => {
    const entries = Array.from({ length: 11 }, (unused, index) => [`f${index}`, "file", 1, 1]);
    const forged = encodeCursor({ root: watched, options: SAFE_OPTIONS, takenAt: 0, truncated: false, entries });
    await assert.rejects(runOperation("list_changes", { cursor: forged }, AS_TOOL), { kind: "invalid_input" });
  });
});

test("FILE_WATCHER_MAX_ENTRIES also counts entries the name_pattern skips", async () => {
  await withWatcher({ environment: { FILE_WATCHER_MAX_ENTRIES: "10" } }, async ({ runOperation, watched }) => {
    for (let index = 0; index < 30; index += 1) await touch(join(watched, `skip-${String(index).padStart(2, "0")}.txt`), "x");
    await touch(join(watched, "zz.csv"), "x");
    const { data } = await runOperation("snapshot", { path: ".", name_pattern: "*.csv" }, AS_TOOL);
    assert.equal(data.truncated, true);
    assert.equal(data.entry_count, 0);
  });
});
