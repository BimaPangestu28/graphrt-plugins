/**
 * The file allowlist: reads only regular files inside the input (or output) directories, after realpath;
 * writes only new, generated names in the output directory. Identical in every local media plugin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNameHint, buildOutputFileName, createFileAccess, readFileAccessSettings, redactPathsOutside } from "../lib/file-access.mjs";

const SETTINGS_OPTIONS = { prefix: "TEST", defaultMaxInputBytes: 4096, defaultMaxOutputBytes: 4096, maxBytesCeiling: 1e9 };

async function withDirectories(work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-file-access-")));
  const directories = { input: join(baseDirectory, "in"), inputLookalike: join(baseDirectory, "in-evil"), output: join(baseDirectory, "out"), outside: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  try {
    const settings = readFileAccessSettings({ TEST_INPUT_DIRS: directories.input, TEST_OUTPUT_DIR: directories.output }, SETTINGS_OPTIONS);
    return await work({ ...directories, fileAccess: createFileAccess(settings), settings });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

test("settings: comma-separated input directories, ~ expansion, caps from the environment, relative paths refused", () => {
  // resolve() gives each path the form of the system the tests run on (a drive letter on Windows).
  const settings = readFileAccessSettings({ HOME: resolve("/home/u"), TEST_INPUT_DIRS: `~/a, ${resolve("/b")} ,`, TEST_OUTPUT_DIR: resolve("/c"), TEST_MAX_INPUT_BYTES: "2048" }, SETTINGS_OPTIONS);
  assert.deepEqual(settings.inputDirectories, [resolve("/home/u/a"), resolve("/b")]);
  assert.equal(settings.outputDirectory, resolve("/c"));
  assert.equal(settings.maxInputBytes, 2048);
  assert.throws(() => readFileAccessSettings({ TEST_INPUT_DIRS: "relative/dir" }, SETTINGS_OPTIONS), { kind: "invalid_input" });
  assert.throws(() => readFileAccessSettings({ TEST_MAX_INPUT_BYTES: "lots" }, SETTINGS_OPTIONS), { kind: "invalid_input" });
});

test("no directories configured: setup_required for reads and for writes", async () => {
  const fileAccess = createFileAccess(readFileAccessSettings({}, SETTINGS_OPTIONS));
  await assert.rejects(fileAccess.resolveInputFile("/etc/hosts"), { kind: "setup_required" });
  await assert.rejects(fileAccess.writeOutputFile({ nameHint: "x", extension: "txt" }, Buffer.from("x")), { kind: "setup_required" });
});

test("reads a regular file inside the input directory, by absolute or relative path", () =>
  withDirectories(async ({ input, fileAccess }) => {
    await writeFile(join(input, "a.txt"), "hello");
    assert.deepEqual(await fileAccess.resolveInputFile(join(input, "a.txt")), { path: join(input, "a.txt"), sizeBytes: 5 });
    assert.equal((await fileAccess.readInputFile("a.txt")).bytes.toString(), "hello");
  }));

test("outside files, look-alike prefixes, ../ escapes and symlinks out are all not_found (same message as missing)", () =>
  withDirectories(async ({ input, inputLookalike, outside, fileAccess }) => {
    await writeFile(join(outside, "secret.txt"), "secret");
    await writeFile(join(inputLookalike, "x.txt"), "x");
    await symlink(join(outside, "secret.txt"), join(input, "link.txt"));
    for (const candidate of [join(outside, "secret.txt"), join(inputLookalike, "x.txt"), "../outside/secret.txt", join(input, "link.txt"), join(input, "missing.txt"), "/etc/hosts"]) {
      await assert.rejects(fileAccess.readInputFile(candidate), { kind: "not_found" }, candidate);
    }
  }));

test("directories, FIFOs and oversized files are refused; a symlink inside the allowlist is followed", () =>
  withDirectories(async ({ input, fileAccess }) => {
    await mkdir(join(input, "sub"));
    await assert.rejects(fileAccess.resolveInputFile(join(input, "sub")), { kind: "invalid_input" });
    // Windows has no FIFOs in a folder.
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [join(input, "pipe")]);
      await assert.rejects(fileAccess.readInputFile(join(input, "pipe")), { kind: "invalid_input" });
    }
    await writeFile(join(input, "big.bin"), Buffer.alloc(5000));
    await assert.rejects(fileAccess.resolveInputFile(join(input, "big.bin")), { kind: "invalid_input" });
    await writeFile(join(input, "real.txt"), "r");
    await symlink(join(input, "real.txt"), join(input, "alias.txt"));
    assert.equal((await fileAccess.resolveInputFile(join(input, "alias.txt"))).path, join(input, "real.txt"));
  }));

test("extension allowlist and NUL characters", () =>
  withDirectories(async ({ input, fileAccess }) => {
    await writeFile(join(input, "a.txt"), "a");
    await assert.rejects(fileAccess.resolveInputFile(join(input, "a.txt"), { extensions: ["srt"] }), { kind: "invalid_input" });
    await assert.rejects(fileAccess.resolveInputFile(`${input}/a.txt\0.srt`), { kind: "invalid_input" });
  }));

test("outputs: generated names, exclusive create, cap enforced, readable as the next input", () =>
  withDirectories(async ({ output, fileAccess }) => {
    const first = await fileAccess.writeOutputFile({ nameHint: "../../etc/passwd", extension: "txt" }, Buffer.from("one"));
    assert.match(first.file_name, /^etc-passwd-\d{8}-\d{6}-[0-9a-f]{8}\.txt$/);
    assert.equal(first.path, join(output, first.file_name));
    assert.equal(await readFile(first.path, "utf8"), "one");
    await assert.rejects(fileAccess.writeOutputFile({ nameHint: "big", extension: "bin" }, Buffer.alloc(5000)), { kind: "invalid_input" });
    assert.equal((await readdir(output)).length, 1);
    assert.equal((await fileAccess.readInputFile(first.path)).bytes.toString(), "one");
  }));

test("a taken name is never overwritten: the next random suffix is used", () =>
  withDirectories(async ({ output, settings }) => {
    const suffixes = ["aaaa0000", "aaaa0000", "bbbb1111"];
    const fixedDate = new Date("2026-11-19T08:01:02Z");
    const fileAccess = createFileAccess(settings, { now: () => fixedDate, randomSuffix: () => suffixes.shift() });
    const first = await fileAccess.writeOutputFile({ nameHint: "x", extension: "txt" }, Buffer.from("first"));
    const second = await fileAccess.writeOutputFile({ nameHint: "x", extension: "txt" }, Buffer.from("second"));
    assert.equal(first.file_name, "x-20261119-080102-aaaa0000.txt");
    assert.equal(second.file_name, "x-20261119-080102-bbbb1111.txt");
    assert.equal(await readFile(join(output, first.file_name), "utf8"), "first");
  }));

test("reserved outputs over the cap are removed by checkOutputFile", () =>
  withDirectories(async ({ output, fileAccess }) => {
    const reservedPath = await fileAccess.reserveOutputPath({ nameHint: "clip", extension: "mp4" });
    await writeFile(reservedPath, Buffer.alloc(5000));
    await assert.rejects(fileAccess.checkOutputFile(reservedPath), { kind: "invalid_input" });
    assert.deepEqual(await readdir(output), []);
  }));

test("name hints keep letters, digits, - and _ only", () => {
  assert.equal(buildNameHint(undefined, "/a/My Photo (1).JPG"), "My-Photo-1");
  assert.equal(buildNameHint("--", undefined), "output");
  assert.equal(buildOutputFileName({ nameHint: "a b", extension: "png" }, new Date("2026-01-02T03:04:05Z"), "ff"), "a-b-20260102-030405-ff.png");
});

test("review regression: an input with more than one hard link is refused (it could alias a file outside)", () =>
  withDirectories(async ({ input, outside, fileAccess }) => {
    await writeFile(join(outside, "secret.txt"), "secret");
    await link(join(outside, "secret.txt"), join(input, "alias.txt"));
    await assert.rejects(fileAccess.readInputFile(join(input, "alias.txt")), (error) => error.kind === "invalid_input" && /hard links/.test(error.message));
  }));

test("review regression: staged outputs are linked to a fresh name, never replace a file, and leave no staging dir", () =>
  withDirectories(async ({ output, settings }) => {
    const fixedDate = new Date("2026-11-19T08:01:02Z");
    const suffixes = ["aaaa0000", "aaaa0000", "bbbb1111"];
    const fileAccess = createFileAccess(settings, { now: () => fixedDate, randomSuffix: () => suffixes.shift() });
    await writeFile(join(output, "clip-20261119-080102-aaaa0000.mp4"), "existing");
    const staging = await fileAccess.createStagingOutput({ nameHint: "clip", extension: "mp4" });
    assert.ok(staging.stagingPath.startsWith(join(output, ".staging-")));
    await writeFile(staging.stagingPath, "new");
    const publishedPath = await staging.publish();
    assert.equal(publishedPath, join(output, "clip-20261119-080102-bbbb1111.mp4"));
    assert.equal(await readFile(join(output, "clip-20261119-080102-aaaa0000.mp4"), "utf8"), "existing");
    assert.deepEqual((await readdir(output)).sort(), ["clip-20261119-080102-aaaa0000.mp4", "clip-20261119-080102-bbbb1111.mp4"]);
    assert.equal((await fileAccess.readInputFile(publishedPath)).bytes.toString(), "new");
    const abandoned = await fileAccess.createStagingOutput({ nameHint: "x", extension: "mp4" });
    await abandoned.discard();
    assert.equal((await readdir(output)).length, 2);
  }));

test("review regression: writeOutputFiles is all or nothing and names what it removed", () =>
  withDirectories(async ({ output, fileAccess }) => {
    const items = [{ naming: { nameHint: "a", extension: "txt" }, bytes: Buffer.from("a") }, { naming: { nameHint: "b", extension: "txt" }, bytes: Buffer.alloc(5000) }];
    await assert.rejects(fileAccess.writeOutputFiles(items), (error) => error.kind === "invalid_input" && /removed the 1 file\(s\) already written: a-/.test(error.message));
    assert.deepEqual(await readdir(output), []);
  }));

test("review regression: paths outside the allowed directories are redacted from messages", () => {
  const message = "dyld: Library not loaded: /opt/homebrew/lib/x.dylib; reading file:/data/in/a.mp4 from /tmp/graphrt-1/list";
  assert.equal(redactPathsOutside(message, ["/data/in"]), "dyld: Library not loaded: [path]; reading file:/data/in/a.mp4 from [path]");
});

test("Windows paths outside the allowed directories are redacted: drive, UNC and \\\\?\\ forms, either separator", () => {
  const allowed = ["C:\\Data\\In", "\\\\nas\\media\\out"];
  const redact = (message) => redactPathsOutside(message, allowed, "win32");
  // Outside: hidden, whatever the form.
  assert.equal(redact("Cannot load C:\\Users\\budi\\AppData\\Local\\Temp\\x.dll: not found"), "Cannot load [path]: not found");
  assert.equal(redact("Cannot load C:/Users/budi/AppData/Local/Temp/x.dll"), "Cannot load [path]");
  assert.equal(redact("open \\\\fileserver\\home\\budi\\notes.txt failed"), "open [path] failed");
  assert.equal(redact("open //fileserver/home/budi/notes.txt failed"), "open [path] failed");
  assert.equal(redact("open \\\\?\\D:\\secret\\a.txt, then \\\\?\\UNC\\fileserver\\home\\b.txt"), "open [path], then [path]");
  assert.equal(redact("device \\\\.\\PhysicalDrive0 busy"), "device [path] busy");
  assert.equal(redact("Error opening input file file:D:\\other\\a.mp4."), "Error opening input file file:[path]");
  assert.equal(redact("'c:\\windows\\system32\\x.dll' (C:\\ProgramData\\y)"), "'[path]' ([path])");
  // Folder names with spaces do not leave their second half behind.
  assert.equal(redact("C:\\Users\\Budi Santoso\\AppData\\Local\\Temp\\graphrt-1\\list.txt: denied"), "[path]: denied");
  assert.equal(redact("load C:\\Program Files (x86)\\ffmpeg\\bin\\avcodec.dll failed"), "load [path] failed");
  // Inside: kept, also when written with other letter case, the other separator or the long form.
  assert.equal(redact("reading C:\\Data\\In\\clip.mp4 and c:/data/in/sub/b.mp4"), "reading C:\\Data\\In\\clip.mp4 and c:/data/in/sub/b.mp4");
  assert.equal(redact("reading \\\\?\\C:\\Data\\In\\clip.mp4"), "reading \\\\?\\C:\\Data\\In\\clip.mp4");
  assert.equal(redact("wrote \\\\NAS\\media\\out\\a.png and \\\\?\\UNC\\nas\\media\\out\\b.png"), "wrote \\\\NAS\\media\\out\\a.png and \\\\?\\UNC\\nas\\media\\out\\b.png");
  // Not inside: a look-alike folder, the folder's parent, a way back out with "..", another share.
  assert.equal(redact("C:\\Data\\In-evil\\a.txt C:\\Data C:\\Data\\In\\..\\..\\Users\\budi \\\\nas\\media\\private\\a"), "[path] [path] [path] [path]");
  // Paths with a single leading "/" stay hidden on Windows, as before; plain text is untouched.
  assert.equal(redact("dyld: /opt/homebrew/lib/x.dylib; ratio 4:3, time 00:00:01, a\\b, see https://example.com/x"), "dyld: [path]; ratio 4:3, time 00:00:01, a\\b, see https:[path]");
  assert.equal(redact(undefined), "");
});

test("on Linux and macOS only / paths are looked at: Windows-looking text stays as it is", () => {
  for (const platform of ["linux", "darwin"]) {
    const message = "note C:\\Users\\budi\\x and \\\\server\\share\\y; reading /data/in/a.mp4 from /tmp/graphrt-1/list";
    assert.equal(redactPathsOutside(message, ["/data/in"], platform), "note C:\\Users\\budi\\x and \\\\server\\share\\y; reading /data/in/a.mp4 from [path]");
  }
});

test("redaction uses the system's own path form by default", () =>
  withDirectories(async ({ input, outside, fileAccess }) => {
    const message = `could not read ${join(outside, "secret.txt")} while opening ${join(input, "a.txt")}`;
    assert.equal(fileAccess.redactPaths(message), `could not read [path] while opening ${join(input, "a.txt")}`);
  }));
