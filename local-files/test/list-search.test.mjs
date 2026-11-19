/**
 * list_directory and search_files: bounded walks that never follow symlinks and never read refused files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AS_TOOL, withLocalFiles } from "./helpers.mjs";

async function createTree(allowed) {
  await mkdir(join(allowed, "docs", "deep"), { recursive: true });
  await writeFile(join(allowed, "readme.md"), "Hello World\nsecond line\n");
  await writeFile(join(allowed, ".env"), "TOKEN=hidden\n");
  await writeFile(join(allowed, "docs", "guide.md"), "hello again\n");
  await writeFile(join(allowed, "docs", "deep", "notes.txt"), "nothing here\nHELLO deep\n");
  await writeFile(join(allowed, "docs", "image.bin"), Buffer.from([104, 101, 108, 108, 111, 0, 1]));
}

test("list_directory: one level by default, sorted, hidden entries only on request", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await createTree(allowed);
    const { data } = await runOperation("list_directory", { path: allowed }, AS_TOOL);
    assert.deepEqual(data.entries.map((entry) => [entry.name, entry.type]), [["docs", "directory"], ["readme.md", "file"]]);
    assert.equal(data.truncated, false);
    const withHidden = await runOperation("list_directory", { path: allowed, include_hidden: true }, AS_TOOL);
    assert.ok(withHidden.data.entries.some((entry) => entry.name === ".env"));
  });
});

test("list_directory: max_depth recurses, limit truncates", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await createTree(allowed);
    const deep = await runOperation("list_directory", { path: ".", max_depth: 3 }, AS_TOOL);
    assert.ok(deep.data.entries.some((entry) => entry.relative_path === join("docs", "deep", "notes.txt")));
    const limited = await runOperation("list_directory", { path: ".", max_depth: 3, limit: 2 }, AS_TOOL);
    assert.equal(limited.data.entries.length, 2);
    assert.equal(limited.data.truncated, true);
  });
});

test("list_directory: symlinks are listed as symlinks and never followed; outside directories are not_found", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, outside }) => {
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(allowed, "escape"));
    const { data } = await runOperation("list_directory", { path: ".", max_depth: 5 }, AS_TOOL);
    assert.deepEqual(data.entries.map((entry) => [entry.name, entry.type]), [["escape", "symlink"]]);
    await assert.rejects(runOperation("list_directory", { path: outside }, AS_TOOL), { kind: "not_found" });
    await assert.rejects(runOperation("list_directory", { path: "escape" }, AS_TOOL), { kind: "not_found" });
  });
});

test("list_directory: a file path is invalid_input", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await writeFile(join(allowed, "a.txt"), "a");
    await assert.rejects(runOperation("list_directory", { path: "a.txt" }, AS_TOOL), { kind: "invalid_input" });
  });
});

test("search_files: name_pattern globs match file names", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await createTree(allowed);
    const { data } = await runOperation("search_files", { name_pattern: "*.md" }, AS_TOOL);
    assert.deepEqual(data.matches.map((match) => match.relative_path).sort(), [join("docs", "guide.md"), "readme.md"]);
  });
});

test("search_files: content search is a case-insensitive substring by default, skips binary files, reports lines", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await createTree(allowed);
    const { data } = await runOperation("search_files", { content: "hello" }, AS_TOOL);
    const found = data.matches.map((match) => `${match.relative_path}:${match.line_number}`).sort();
    assert.deepEqual(found, [join("docs", "deep", "notes.txt:2"), join("docs", "guide.md:1"), "readme.md:1"]);
    assert.equal(data.skipped_files.binary, 1);
    const exact = await runOperation("search_files", { content: "HELLO", case_sensitive: true }, AS_TOOL);
    assert.deepEqual(exact.data.matches.map((match) => match.line), ["HELLO deep"]);
  });
});

test("search_files: never reads through symlinks or hard links, and max_results truncates", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, outside }) => {
    await writeFile(join(outside, "secret.txt"), "hello secret");
    await symlink(join(outside, "secret.txt"), join(allowed, "soft.txt"));
    await link(join(outside, "secret.txt"), join(allowed, "hard.txt"));
    for (let index = 0; index < 5; index += 1) await writeFile(join(allowed, `file-${index}.txt`), "hello\n");
    const { data } = await runOperation("search_files", { content: "hello", max_results: 3 }, AS_TOOL);
    assert.equal(data.matches.length, 3);
    assert.equal(data.truncated, true);
    assert.ok(data.matches.every((match) => !match.line.includes("secret")));
    const all = await runOperation("search_files", { content: "secret" }, AS_TOOL);
    assert.equal(all.data.matches.length, 0);
    assert.equal(all.data.skipped_files.hard_linked, 1);
  });
});

test("search_files: needs a name_pattern or content", async () => {
  await withLocalFiles({}, async ({ runOperation }) => {
    await assert.rejects(runOperation("search_files", {}, AS_TOOL), { kind: "invalid_input" });
  });
});

test("search_files: directories count toward LOCAL_FILES_MAX_SEARCH_FILES too", async () => {
  await withLocalFiles({ environment: { LOCAL_FILES_MAX_SEARCH_FILES: "10" } }, async ({ runOperation, allowed }) => {
    for (let index = 0; index < 30; index += 1) await mkdir(join(allowed, `d-${String(index).padStart(2, "0")}`));
    const { data } = await runOperation("search_files", { name_pattern: "*.txt" }, AS_TOOL);
    assert.equal(data.entries_scanned, 10);
    assert.equal(data.truncated, true);
  });
});

test("search_files: max_matches_per_file caps the lines reported from one file", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await writeFile(join(allowed, "many.txt"), "hit\n".repeat(200));
    await writeFile(join(allowed, "other.txt"), "hit\n");
    const { data } = await runOperation("search_files", { content: "hit" }, AS_TOOL);
    assert.equal(data.matches.filter((match) => match.relative_path === "many.txt").length, 10);
    assert.equal(data.matches.filter((match) => match.relative_path === "other.txt").length, 1);
    assert.equal(data.files_with_more_matches, 1);
    const three = await runOperation("search_files", { content: "hit", max_matches_per_file: 3 }, AS_TOOL);
    assert.equal(three.data.matches.filter((match) => match.relative_path === "many.txt").length, 3);
  });
});

test("search_files: a hostile name_pattern does not stall the walk", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await writeFile(join(allowed, "a".repeat(200)), "x");
    const started = Date.now();
    const { data } = await runOperation("search_files", { name_pattern: `${"*a".repeat(20)}b` }, AS_TOOL);
    assert.equal(data.matches.length, 0);
    assert.ok(Date.now() - started < 1000);
  });
});

test("search_files: LOCAL_FILES_MAX_SEARCH_FILES bounds the walk", async () => {
  await withLocalFiles({ environment: { LOCAL_FILES_MAX_SEARCH_FILES: "10" } }, async ({ runOperation, allowed }) => {
    for (let index = 0; index < 20; index += 1) await writeFile(join(allowed, `f-${String(index).padStart(2, "0")}.txt`), "x");
    const { data } = await runOperation("search_files", { name_pattern: "*.txt", max_results: 1000 }, AS_TOOL);
    assert.equal(data.entries_scanned, 10);
    assert.equal(data.truncated, true);
  });
});

test("search_files: a cancelled signal stops the walk", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await createTree(allowed);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runOperation("search_files", { content: "x" }, { source: "tool", signal: controller.signal }), { kind: "cancelled" });
  });
});
