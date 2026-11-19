/**
 * Operations against the fake server: remote paths confined to SFTP_ROOT, local paths to the allowlist,
 * tool writes opt-in, no overwrite unless a node asks, deletes node only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AS_NODE, AS_TOOL, withSftp } from "./helpers.mjs";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";

const TOOL_WRITES = { environment: { SFTP_TOOL_ALLOW_WRITES: "1" } };

test("list_directory: entries of SFTP_ROOT (default) or a subdirectory, sorted, with types", async () => {
  await withSftp({}, async ({ runOperation, serverRoot }) => {
    await mkdir(join(serverRoot, "reports"));
    await writeFile(join(serverRoot, "b.txt"), "bb");
    await writeFile(join(serverRoot, "reports", "q1.csv"), "x");
    const { data } = await runOperation("list_directory", {}, AS_TOOL);
    assert.equal(data.path, "/");
    assert.deepEqual(data.entries.map((entry) => [entry.name, entry.type, entry.path]), [["b.txt", "file", "/b.txt"], ["reports", "directory", "/reports"]]);
    assert.equal(data.entries[0].size_bytes, 2);
    const nested = await runOperation("list_directory", { path: "reports" }, AS_TOOL);
    assert.deepEqual(nested.data.entries.map((entry) => entry.path), ["/reports/q1.csv"]);
  });
});

test("remote paths: ../, absolute paths outside, lookalike siblings and symlinks out of SFTP_ROOT are not_found", async () => {
  await withSftp({}, async ({ runOperation, serverRoot, outsideRemote }) => {
    await writeFile(join(outsideRemote, "secret.txt"), "secret");
    await symlink(outsideRemote, join(serverRoot, "escape"));
    for (const path of ["../server-evil/secret.txt", "/../../server-evil/secret.txt", "escape/secret.txt", "escape"]) {
      await assert.rejects(runOperation("read_file", { path }, AS_TOOL), { kind: "not_found" }, path);
    }
  });
});

test("paths are shown relative to SFTP_ROOT, so the server's layout is not exposed", async () => {
  await withSftp({}, async ({ runOperation, serverRoot }) => {
    await writeFile(join(serverRoot, "a.txt"), "a");
    const { data } = await runOperation("stat", { path: "/a.txt" }, AS_TOOL);
    assert.deepEqual({ path: data.path, type: data.type, size_bytes: data.size_bytes }, { path: "/a.txt", type: "file", size_bytes: 1 });
    assert.match(data.modified_at, /^\d{4}-/);
  });
});

test("read_file: text with max_bytes and truncated; base64", async () => {
  await withSftp({}, async ({ runOperation, serverRoot }) => {
    await writeFile(join(serverRoot, "log.txt"), "0123456789");
    const { data } = await runOperation("read_file", { path: "log.txt", max_bytes: 4 }, AS_TOOL);
    assert.deepEqual({ content: data.content, truncated: data.truncated, size_bytes: data.size_bytes }, { content: "0123", truncated: true, size_bytes: 10 });
    const encoded = await runOperation("read_file", { path: "log.txt", encoding: "base64" }, AS_TOOL);
    assert.equal(Buffer.from(encoded.data.content, "base64").toString(), "0123456789");
  });
});

test("download: writes a new, generated file in SFTP_OUTPUT_DIR (allowed for tools)", async () => {
  await withSftp({}, async ({ runOperation, serverRoot, outputDirectory }) => {
    await writeFile(join(serverRoot, "report.csv"), "a,b\n1,2\n");
    const { data } = await runOperation("download", { path: "report.csv" }, AS_TOOL);
    assert.match(data.file_name, /^report-\d{8}-\d{6}-[0-9a-f]+\.csv$/);
    assert.equal(await readFile(data.path, "utf8"), "a,b\n1,2\n");
    assert.deepEqual((await readdir(outputDirectory)).filter((name) => name.startsWith(".")), []);
  });
});

test("download: over SFTP_MAX_OUTPUT_BYTES is refused before transfer", async () => {
  await withSftp({ environment: { SFTP_MAX_OUTPUT_BYTES: "1024" } }, async ({ runOperation, serverRoot, outputDirectory }) => {
    await writeFile(join(serverRoot, "big.bin"), Buffer.alloc(4096));
    await assert.rejects(runOperation("download", { path: "big.bin" }, AS_TOOL), { kind: "invalid_input", message: /1024/ });
    assert.deepEqual(await readdir(outputDirectory), []);
  });
});

test("upload: tools need SFTP_TOOL_ALLOW_WRITES=1", async () => {
  await withSftp({}, async ({ runOperation, inputDirectory, serverRoot }) => {
    await writeFile(join(inputDirectory, "up.txt"), "hi");
    await assert.rejects(runOperation("upload", { local_path: "up.txt", path: "up.txt" }, AS_TOOL), { kind: "permission_denied", message: /SFTP_TOOL_ALLOW_WRITES/ });
    assert.deepEqual(await readdir(serverRoot), []);
  });
});

test("upload: staged with an exclusive create, then renamed; existing files are never replaced by tools", async () => {
  await withSftp(TOOL_WRITES, async ({ runOperation, inputDirectory, serverRoot, log }) => {
    await writeFile(join(inputDirectory, "up.txt"), "hello");
    const { data } = await runOperation("upload", { local_path: "up.txt", path: "incoming/up.txt", create_parents: true }, AS_TOOL);
    assert.deepEqual(data, { path: "/incoming/up.txt", size_bytes: 5, created: true });
    assert.equal(await readFile(join(serverRoot, "incoming", "up.txt"), "utf8"), "hello");
    assert.deepEqual(await readdir(join(serverRoot, "incoming")), ["up.txt"]);
    assert.deepEqual(log.writeFlags, ["wx"]);
    await assert.rejects(runOperation("upload", { local_path: "up.txt", path: "incoming/up.txt" }, AS_TOOL), { kind: "invalid_input", message: /already exists/ });
    await assert.rejects(runOperation("upload", { local_path: "up.txt", path: "incoming/up.txt", overwrite: true }, AS_TOOL), { kind: "permission_denied" });
  });
});

test("upload: a target created during the upload is not replaced, even where rename would overwrite", async () => {
  const scenario = { renameOverwrites: true, afterUploadWrite: async () => {} };
  await withSftp({ scenario, ...TOOL_WRITES }, async ({ runOperation, inputDirectory, serverRoot }) => {
    scenario.afterUploadWrite = () => writeFileSync(join(serverRoot, "race.txt"), "theirs");
    await writeFile(join(inputDirectory, "race.txt"), "mine");
    await assert.rejects(runOperation("upload", { local_path: "race.txt", path: "race.txt" }, AS_TOOL), { kind: "invalid_input", message: /meanwhile/ });
    assert.equal(await readFile(join(serverRoot, "race.txt"), "utf8"), "theirs");
    assert.deepEqual(await readdir(serverRoot), ["race.txt"]);
  });
});

test("upload: a node may overwrite with overwrite: true", async () => {
  await withSftp({}, async ({ runOperation, inputDirectory, serverRoot }) => {
    await writeFile(join(serverRoot, "up.txt"), "old");
    await writeFile(join(inputDirectory, "up.txt"), "new");
    const { data } = await runOperation("upload", { local_path: "up.txt", path: "up.txt", overwrite: true }, AS_NODE);
    assert.equal(data.created, false);
    assert.equal(await readFile(join(serverRoot, "up.txt"), "utf8"), "new");
    assert.deepEqual(await readdir(serverRoot), ["up.txt"]);
  });
});

test("upload: local files outside SFTP_INPUT_DIRS or hard-linked are refused; remote targets outside the root too", async () => {
  await withSftp({}, async ({ runOperation, inputDirectory, outsideRemote }) => {
    await writeFile(join(outsideRemote, "local-secret.txt"), "secret");
    await link(join(outsideRemote, "local-secret.txt"), join(inputDirectory, "hard.txt"));
    await writeFile(join(inputDirectory, "ok.txt"), "ok");
    await assert.rejects(runOperation("upload", { local_path: join(outsideRemote, "local-secret.txt"), path: "x.txt" }, AS_NODE), { kind: "not_found" });
    await assert.rejects(runOperation("upload", { local_path: "hard.txt", path: "x.txt" }, AS_NODE), { kind: "invalid_input", message: /hard link/ });
    await assert.rejects(runOperation("upload", { local_path: "ok.txt", path: "../server-evil/x.txt" }, AS_NODE), { kind: "not_found" });
    assert.deepEqual(await readdir(outsideRemote), ["local-secret.txt"]);
  });
});

test("make_directory needs the opt-in for tools; delete_path is node only and never recursive", async () => {
  await withSftp({}, async ({ runOperation, serverRoot }) => {
    await assert.rejects(runOperation("make_directory", { path: "new" }, AS_TOOL), { kind: "permission_denied" });
    assert.deepEqual((await runOperation("make_directory", { path: "new" }, AS_NODE)).data, { path: "/new", created: true });
    await writeFile(join(serverRoot, "new", "f.txt"), "x");
    await assert.rejects(runOperation("delete_path", { path: "new/f.txt" }, AS_TOOL), { message: /Unknown operation/ });
    await assert.rejects(runOperation("delete_path", { path: "new" }, AS_NODE), { kind: "plugin_error" });
    assert.deepEqual((await runOperation("delete_path", { path: "new/f.txt" }, AS_NODE)).data, { path: "/new/f.txt", deleted: "file" });
    assert.equal((await runOperation("delete_path", { path: "new" }, AS_NODE)).data.deleted, "directory");
    await assert.rejects(runOperation("delete_path", { path: "/" }, AS_NODE), { kind: "invalid_input" });
  });
});

test("manifest: network and secrets, delete_path is not a tool, password env listed", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.permissions.network, true);
  assert.ok(manifest.permissions.env.includes("SFTP_PASSWORD"));
  assert.ok(manifest.permissions.env.includes("SFTP_HOST_FINGERPRINT"));
  assert.ok(!manifest.tools.some((tool) => tool.name === "delete_path"));
});
