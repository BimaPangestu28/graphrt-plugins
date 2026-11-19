/**
 * write_file and delete_path: tool writes need LOCAL_FILES_TOOL_ALLOW_WRITES=1, overwrites and deletes are
 * node only, writes are staged and published without replacing anything unless asked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as realFileSystem } from "node:fs";
import { link, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AS_NODE, AS_TOOL, makeFifo, withLocalFiles } from "./helpers.mjs";
import { pluginDefinition } from "../definition.mjs";
import { buildManifest } from "../lib/shared/operations.mjs";

const TOOL_WRITES = { environment: { LOCAL_FILES_TOOL_ALLOW_WRITES: "1" } };

test("write_file from a tool without the opt-in is permission_denied and writes nothing", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await assert.rejects(runOperation("write_file", { path: "new.txt", content: "x" }, AS_TOOL), { kind: "permission_denied", message: /LOCAL_FILES_TOOL_ALLOW_WRITES/ });
    assert.deepEqual(await readdir(allowed), []);
  });
});

test("write_file: creates a new file (tool with opt-in), leaves no staging file", async () => {
  await withLocalFiles(TOOL_WRITES, async ({ runOperation, allowed }) => {
    const { data } = await runOperation("write_file", { path: "new.txt", content: "hello" }, AS_TOOL);
    assert.deepEqual(data, { path: join(allowed, "new.txt"), size_bytes: 5, created: true });
    assert.equal(await readFile(join(allowed, "new.txt"), "utf8"), "hello");
    assert.deepEqual(await readdir(allowed), ["new.txt"]);
  });
});

test("write_file: base64 content; malformed base64 is invalid_input", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await runOperation("write_file", { path: "blob.bin", content: Buffer.from([0, 1, 255]).toString("base64"), encoding: "base64" }, AS_NODE);
    assert.deepEqual([...(await readFile(join(allowed, "blob.bin")))], [0, 1, 255]);
    await assert.rejects(runOperation("write_file", { path: "bad.bin", content: "not base64!", encoding: "base64" }, AS_NODE), { kind: "invalid_input" });
  });
});

test("write_file: an existing file is never replaced unless a node asks with overwrite", async () => {
  await withLocalFiles(TOOL_WRITES, async ({ runOperation, allowed }) => {
    await writeFile(join(allowed, "keep.txt"), "original", { mode: 0o640 });
    await assert.rejects(runOperation("write_file", { path: "keep.txt", content: "new" }, AS_NODE), { kind: "invalid_input", message: /already exists/ });
    await assert.rejects(runOperation("write_file", { path: "keep.txt", content: "new", overwrite: true }, AS_TOOL), { kind: "permission_denied" });
    assert.equal(await readFile(join(allowed, "keep.txt"), "utf8"), "original");
    const { data } = await runOperation("write_file", { path: "keep.txt", content: "replaced", overwrite: true }, AS_NODE);
    assert.equal(data.created, false);
    assert.equal(await readFile(join(allowed, "keep.txt"), "utf8"), "replaced");
    assert.equal((await stat(join(allowed, "keep.txt"))).mode & 0o777, 0o640);
    assert.deepEqual(await readdir(allowed), ["keep.txt"]);
  });
});

test("write_file: refuses to overwrite symlinks, hard-linked files, FIFOs and directories", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, outside }) => {
    await writeFile(join(outside, "target.txt"), "outside");
    await symlink(join(outside, "target.txt"), join(allowed, "soft.txt"));
    await link(join(outside, "target.txt"), join(allowed, "hard.txt"));
    makeFifo(join(allowed, "pipe"));
    await mkdir(join(allowed, "folder"));
    for (const name of ["soft.txt", "hard.txt", "pipe", "folder"]) {
      await assert.rejects(runOperation("write_file", { path: name, content: "x", overwrite: true }, AS_NODE), { kind: "invalid_input" }, name);
    }
    assert.equal(await readFile(join(outside, "target.txt"), "utf8"), "outside");
  });
});

test("write_file: targets outside the allowlist (lookalike prefix, ../, symlinked parent) are not_found", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, lookalike, outside }) => {
    await symlink(outside, join(allowed, "escape"));
    for (const target of [join(lookalike, "x.txt"), join(allowed, "..", "outside", "x.txt"), join(allowed, "escape", "x.txt"), join(outside, "x.txt")]) {
      await assert.rejects(runOperation("write_file", { path: target, content: "x" }, AS_NODE), { kind: "not_found" }, target);
    }
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(lookalike), []);
  });
});

test("write_file: an allowed root itself cannot be a write target", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await assert.rejects(runOperation("write_file", { path: allowed, content: "x", overwrite: true }, AS_NODE), { kind: "invalid_input" });
  });
});

test("write_file: create_parents makes missing directories inside the allowlist only", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await assert.rejects(runOperation("write_file", { path: "a/b/c.txt", content: "x" }, AS_NODE), { kind: "not_found", message: /create_parents/ });
    const { data } = await runOperation("write_file", { path: "a/b/c.txt", content: "x", create_parents: true }, AS_NODE);
    assert.equal(data.path, join(allowed, "a", "b", "c.txt"));
    assert.equal(await readFile(data.path, "utf8"), "x");
  });
});

test("write_file: LOCAL_FILES_MAX_WRITE_BYTES caps the content", async () => {
  await withLocalFiles({ environment: { LOCAL_FILES_MAX_WRITE_BYTES: "1024" } }, async ({ runOperation, allowed }) => {
    await assert.rejects(runOperation("write_file", { path: "big.txt", content: "x".repeat(2000) }, AS_NODE), { kind: "invalid_input", message: /1024/ });
    assert.deepEqual(await readdir(allowed), []);
  });
});

test("write_file: a failure while writing removes the staging file", async () => {
  const failingFileSystem = {
    ...realFileSystem,
    open: async (...openArguments) => {
      const fileHandle = await realFileSystem.open(...openArguments);
      return { ...fileHandle, stat: () => fileHandle.stat(), close: () => fileHandle.close(), sync: () => fileHandle.sync(), writeFile: async () => { throw new Error("disk full"); } };
    },
  };
  await withLocalFiles({ dependencies: { fileSystem: failingFileSystem } }, async ({ runOperation, allowed }) => {
    await assert.rejects(runOperation("write_file", { path: "x.txt", content: "x" }, AS_NODE), { kind: "plugin_error", message: /disk full/ });
    assert.deepEqual(await readdir(allowed), []);
  });
});

test("delete_path: node only; deletes files and empty directories, refuses roots and non-empty directories", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, outside }) => {
    await writeFile(join(allowed, "old.txt"), "x");
    await mkdir(join(allowed, "empty"));
    await mkdir(join(allowed, "full"));
    await writeFile(join(allowed, "full", "f.txt"), "x");
    await symlink(join(outside), join(allowed, "escape"));
    await writeFile(join(outside, "keep.txt"), "x");
    await assert.rejects(runOperation("delete_path", { path: "old.txt" }, AS_TOOL), { kind: "invalid_input", message: /Unknown operation/ });
    assert.deepEqual((await runOperation("delete_path", { path: "old.txt" }, AS_NODE)).data, { path: join(allowed, "old.txt"), deleted: "file" });
    assert.equal((await runOperation("delete_path", { path: "empty" }, AS_NODE)).data.deleted, "directory");
    await assert.rejects(runOperation("delete_path", { path: "full" }, AS_NODE), { kind: "invalid_input", message: /not empty/ });
    await assert.rejects(runOperation("delete_path", { path: allowed }, AS_NODE), { kind: "invalid_input" });
    await assert.rejects(runOperation("delete_path", { path: join("escape", "keep.txt") }, AS_NODE), { kind: "not_found" });
    assert.equal((await runOperation("delete_path", { path: "escape" }, AS_NODE)).data.deleted, "symlink");
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "x");
  });
});

test("manifest: local only, no secrets, delete_path is not a tool", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  assert.ok(manifest.permissions.env.includes("LOCAL_FILES_ALLOWED_DIRS"));
  const toolNames = manifest.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("write_file"));
  assert.ok(!toolNames.includes("delete_path"));
  assert.ok(manifest.nodes.some((node) => node.kind === "local-files.delete_path"));
});
