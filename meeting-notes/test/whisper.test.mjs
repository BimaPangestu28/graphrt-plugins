import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePinnedFile, ensureWhisper, findWhisper, MODEL, PROGRAMS, whisperArguments } from "../lib/whisper.mjs";
import { readSettings } from "../lib/settings.mjs";

async function withDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), "graphrt-meeting-whisper-test-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeDownload(body, calls) {
  return async (url, options) => {
    calls.push({ url, ...options });
    const path = join(options.directory, `${options.fileBaseName}.bin`);
    await writeFile(path, body);
    return { url, path, bytes: body.length };
  };
}

const pinnedFor = (body) => ({ url: "https://example.com/whisper-cli", sha256: createHash("sha256").update(body).digest("hex"), file: "whisper-cli", bytes: body.length });

test("downloads a pinned file once, checks its SHA-256 and makes programs executable", async () => {
  await withDirectory(async (directory) => {
    const calls = [];
    const body = Buffer.from("#!/bin/sh\n");
    const path = await ensurePinnedFile(pinnedFor(body), { directory, download: fakeDownload(body, calls), executable: true });
    assert.equal(path, join(directory, "whisper-cli"));
    assert.equal((await stat(path)).mode & 0o111, 0o111);
    await ensurePinnedFile(pinnedFor(body), { directory, download: fakeDownload(body, calls) });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].maxBytes >= body.length);
  });
});

test("a download that is not the pinned file is discarded", async () => {
  await withDirectory(async (directory) => {
    const pinned = pinnedFor(Buffer.from("good"));
    await assert.rejects(ensurePinnedFile(pinned, { directory, download: fakeDownload(Buffer.from("evil"), []) }), /not the expected file/);
    await assert.rejects(stat(join(directory, "whisper-cli")));
  });
});

test("uses whisper-cli from PATH, refuses platforms without a download", async () => {
  await withDirectory(async (directory) => {
    const bin = join(directory, "bin");
    await (await import("node:fs/promises")).mkdir(bin);
    await writeFile(join(bin, "whisper-cli"), "");
    const found = await findWhisper(join(directory, "whisper"), bin);
    assert.deepEqual(found, { program: join(bin, "whisper-cli"), model: null });
    await assert.rejects(ensureWhisper({ whisperDirectory: join(directory, "w"), searchPath: "", download: fakeDownload(Buffer.from(""), []), platform: "win32-x64" }), { kind: "not_found" });
  });
});

test("pins the published whisper-cli and the Hugging Face model", () => {
  assert.match(PROGRAMS["linux-x64"].url, /^https:\/\/github\.com\/Graphrt\/graphrt-builder-desktop\/releases\/download\/whisper-cpp-v1\.9\.6\//);
  assert.equal(PROGRAMS["linux-x64"].sha256.length, 64);
  assert.match(MODEL.url, /^https:\/\/huggingface\.co\//);
  assert.equal(
    whisperArguments({ model: "/m/ggml-base.bin", audio: "/r/mic.wav", language: "auto", threads: 4, outputPrefix: "/r/mic.whisper" }).join(" "),
    "-m /m/ggml-base.bin -f /r/mic.wav -l auto -t 4 -oj -of /r/mic.whisper -np",
  );
});

test("settings default under the user's data folder and are checked", () => {
  const defaults = readSettings({ HOME: "/home/u" });
  assert.equal(defaults.meetingsDirectory, "/home/u/.local/share/graphrt-meeting-notes");
  assert.equal(defaults.whisperDirectory, "/home/u/.local/share/graphrt-meeting-notes/whisper");
  assert.equal(defaults.autoStopSeconds, 30);
  assert.equal(readSettings({ HOME: "/h", MEETING_NOTES_DIR: "~/notes" }).meetingsDirectory, "/h/notes");
  assert.throws(() => readSettings({ HOME: "/h", MEETING_NOTES_DIR: "notes" }), { kind: "invalid_input" });
  assert.throws(() => readSettings({ HOME: "/h", MEETING_NOTES_AUTO_STOP_SECONDS: "2" }), { kind: "invalid_input" });
  assert.throws(() => readSettings({ HOME: "/h", MEETING_NOTES_LANGUAGE: "english" }), { kind: "invalid_input" });
});
