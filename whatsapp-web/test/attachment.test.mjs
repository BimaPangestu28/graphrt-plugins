import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMediaFile, resolveAttachment } from "../lib/attachment.mjs";

async function withDirectories(testBody) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "wa-attach-"));
  const allowedDirectory = join(rootDirectory, "outbox");
  const privateDirectory = join(rootDirectory, "private");
  await mkdir(allowedDirectory);
  await mkdir(privateDirectory);
  try {
    await testBody({ allowedDirectory, privateDirectory });
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
}

test("isMediaFile tells photos/videos from documents", () => {
  assert.equal(isMediaFile("/a/b/photo.JPG"), true);
  assert.equal(isMediaFile("clip.mp4"), true);
  assert.equal(isMediaFile("invoice.pdf"), false);
});

test("a local file inside an allowed directory is accepted", () =>
  withDirectories(async ({ allowedDirectory }) => {
    const filePath = join(allowedDirectory, "invoice.pdf");
    await writeFile(filePath, "pdf");
    const attachment = await resolveAttachment(filePath, { allowedDirectories: [allowedDirectory] });
    assert.ok(attachment.filePath.endsWith("invoice.pdf"));
  }));

test("local files are refused when no directory is allowed", () =>
  withDirectories(async ({ allowedDirectory }) => {
    const filePath = join(allowedDirectory, "a.txt");
    await writeFile(filePath, "x");
    await assert.rejects(resolveAttachment(filePath, { allowedDirectories: [] }), (error) => error.kind === "invalid_input" && /WHATSAPP_WEB_ALLOWED_FILE_DIRS/.test(error.message));
  }));

test("a file outside the allowed directories is refused, also through a symlink", () =>
  withDirectories(async ({ allowedDirectory, privateDirectory }) => {
    const secretPath = join(privateDirectory, "id_rsa");
    await writeFile(secretPath, "secret");
    await assert.rejects(resolveAttachment(secretPath, { allowedDirectories: [allowedDirectory] }), { kind: "invalid_input" });
    const linkPath = join(allowedDirectory, "innocent.txt");
    await symlink(secretPath, linkPath);
    await assert.rejects(resolveAttachment(linkPath, { allowedDirectories: [allowedDirectory] }), { kind: "invalid_input" });
  }));

test("a missing local file is not_found", () =>
  withDirectories(async ({ allowedDirectory }) => {
    await assert.rejects(resolveAttachment(join(allowedDirectory, "nope.png"), { allowedDirectories: [allowedDirectory] }), { kind: "not_found" });
  }));

test("an https URL is downloaded to a temporary file that cleanup removes", async () => {
  const fakeFetch = async (url) => new Response("image-bytes", { status: 200, headers: { "content-length": "11" } });
  const attachment = await resolveAttachment("https://files.example.com/path/photo%201.png?x=1", { allowedDirectories: [], fetchImpl: fakeFetch });
  assert.ok(attachment.filePath.endsWith("photo 1.png"));
  assert.equal(await readFile(attachment.filePath, "utf8"), "image-bytes");
  await attachment.cleanup();
  assert.equal(existsSync(dirname(attachment.filePath)), false);
});

test("URL failures map to not_found / invalid_input", async () => {
  const notFoundFetch = async () => new Response("", { status: 404 });
  await assert.rejects(resolveAttachment("https://x.example/a.png", { allowedDirectories: [], fetchImpl: notFoundFetch }), { kind: "not_found" });
  const hugeFetch = async () => new Response("", { status: 200, headers: { "content-length": String(500 * 1024 * 1024) } });
  await assert.rejects(resolveAttachment("https://x.example/a.png", { allowedDirectories: [], fetchImpl: hugeFetch }), { kind: "invalid_input" });
  await assert.rejects(resolveAttachment("ftp://x.example/a.png", { allowedDirectories: [] }), { kind: "invalid_input" });
});
