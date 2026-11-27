/**
 * read_file, stat and list_allowed_directories: the allowlist (realpath on both sides, separator-suffixed
 * prefix), refused file types and the read cap with its `truncated` flag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AS_NODE, AS_TOOL, makeFifo, withLocalFiles } from "./helpers.mjs";

test("no allowed directories: setup_required", async () => {
  await withLocalFiles({ environment: { LOCAL_FILES_ALLOWED_DIRS: "" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("read_file", { path: "/etc/hosts" }, AS_TOOL), { kind: "setup_required" });
  });
});

test("read_file: whole UTF-8 file, by absolute and by relative path", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await writeFile(join(allowed, "notes.txt"), "héllo\nworld\n");
    const absolute = await runOperation("read_file", { path: join(allowed, "notes.txt") }, AS_TOOL);
    assert.equal(absolute.data.content, "héllo\nworld\n");
    assert.equal(absolute.data.truncated, false);
    assert.equal(absolute.data.size_bytes, 13);
    const relative = await runOperation("read_file", { path: "notes.txt" }, AS_TOOL);
    assert.equal(relative.data.path, join(allowed, "notes.txt"));
  });
});

test("read_file: max_bytes caps the read, sets truncated and never splits a UTF-8 character", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await writeFile(join(allowed, "accents.txt"), "aé€b");
    const { data } = await runOperation("read_file", { path: "accents.txt", max_bytes: 4 }, AS_TOOL);
    assert.equal(data.content, "aé");
    assert.equal(data.bytes_read, 3);
    assert.equal(data.truncated, true);
    assert.equal(data.next_offset, 3);
    const rest = await runOperation("read_file", { path: "accents.txt", offset: data.next_offset }, AS_TOOL);
    assert.equal(rest.data.content, "€b");
    assert.equal(rest.data.truncated, false);
  });
});

test("read_file: LOCAL_FILES_MAX_READ_BYTES bounds max_bytes", async () => {
  await withLocalFiles({ environment: { LOCAL_FILES_MAX_READ_BYTES: "1024" } }, async ({ runOperation, allowed }) => {
    await writeFile(join(allowed, "big.txt"), "x".repeat(5000));
    const { data } = await runOperation("read_file", { path: "big.txt", max_bytes: 4096 }, AS_TOOL);
    assert.equal(data.content.length, 1024);
    assert.equal(data.truncated, true);
  });
});

test("read_file: base64 for binary files; invalid UTF-8 as text is refused with a hint", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await writeFile(join(allowed, "blob.bin"), Buffer.from([0, 255, 1, 254]));
    const { data } = await runOperation("read_file", { path: "blob.bin", encoding: "base64" }, AS_TOOL);
    assert.equal(data.content, Buffer.from([0, 255, 1, 254]).toString("base64"));
    await assert.rejects(runOperation("read_file", { path: "blob.bin" }, AS_TOOL), { kind: "invalid_input", message: /base64/ });
  });
});

test("read_file: outside, lookalike prefix, ../ escape, symlink out and missing all give the same not_found", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, lookalike, outside }) => {
    await writeFile(join(outside, "secret.txt"), "secret");
    await writeFile(join(lookalike, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(allowed, "link.txt"));
    const attempts = [join(outside, "secret.txt"), join(lookalike, "secret.txt"), join(allowed, "..", "outside", "secret.txt"), join(allowed, "link.txt"), join(allowed, "missing.txt")];
    for (const attempt of attempts) {
      await assert.rejects(runOperation("read_file", { path: attempt }, AS_TOOL), (error) => {
        assert.equal(error.kind, "not_found", attempt);
        assert.doesNotMatch(error.message, /secret"?$/);
        return true;
      });
    }
  });
});

test("read_file: a symlink that stays inside the allowlist is followed", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, second }) => {
    await writeFile(join(second, "real.txt"), "inside");
    await symlink(join(second, "real.txt"), join(allowed, "alias.txt"));
    const { data } = await runOperation("read_file", { path: "alias.txt" }, AS_TOOL);
    assert.equal(data.content, "inside");
    assert.equal(data.path, join(second, "real.txt"));
  });
});

test("read_file: directories, FIFOs and hard-linked files are refused", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, outside }) => {
    await mkdir(join(allowed, "folder"));
    const hasFifo = makeFifo(join(allowed, "pipe"));
    await writeFile(join(outside, "target.txt"), "outside");
    await link(join(outside, "target.txt"), join(allowed, "hard.txt"));
    await assert.rejects(runOperation("read_file", { path: "folder" }, AS_TOOL), { kind: "invalid_input" });
    if (hasFifo) await assert.rejects(runOperation("read_file", { path: "pipe" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("read_file", { path: "hard.txt" }, AS_TOOL), { kind: "invalid_input", message: /hard link/ });
  });
});

test("read_file: NUL characters and a device path are refused", async () => {
  await withLocalFiles({}, async ({ runOperation }) => {
    await assert.rejects(runOperation("read_file", { path: "a\0b" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("read_file", { path: "/dev/zero" }, AS_TOOL), { kind: "not_found" });
  });
});

test("stat: files, directories (an allowed root too) and FIFOs are described without being opened", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed }) => {
    await writeFile(join(allowed, "a.txt"), "abc");
    const hasFifo = makeFifo(join(allowed, "pipe"));
    const fileStat = await runOperation("stat", { path: "a.txt" }, AS_TOOL);
    assert.equal(fileStat.data.type, "file");
    assert.equal(fileStat.data.size_bytes, 3);
    assert.match(fileStat.data.modified_at, /^\d{4}-\d\d-\d\dT/);
    assert.match(fileStat.data.mode, /^0[0-7]{3}$/);
    const rootStat = await runOperation("stat", { path: allowed }, AS_TOOL);
    assert.equal(rootStat.data.type, "directory");
    if (hasFifo) assert.equal((await runOperation("stat", { path: "pipe" }, AS_NODE)).data.type, "fifo");
  });
});

test("stat: a hard-linked file is refused (its metadata may belong to a file outside the allowlist)", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, outside }) => {
    await writeFile(join(outside, "target.txt"), "outside");
    await link(join(outside, "target.txt"), join(allowed, "hard.txt"));
    await assert.rejects(runOperation("stat", { path: "hard.txt" }, AS_TOOL), { kind: "invalid_input", message: /hard link/ });
  });
});

test("list_allowed_directories: the real paths of the configured roots, with whether each exists", async () => {
  await withLocalFiles({}, async ({ runOperation, allowed, second }) => {
    const { data } = await runOperation("list_allowed_directories", {}, AS_TOOL);
    assert.deepEqual(data.directories.map((directory) => directory.path), [allowed, second]);
    assert.ok(data.directories.every((directory) => directory.exists));
  });
});
