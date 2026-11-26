import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "../lib/plugin-package.mjs";
import { createTarGz } from "../lib/tar-archive.mjs";
import { assertOnlyFilesAndDirectories, verifyTarball } from "../lib/tarball-verification.mjs";
import { rawDirectory, rawFile, rawHeader, rawPaxHeader, rawTarGz } from "./fixtures/raw-tar.mjs";

const PLUGIN_SOURCE = "export default 1;\n";

function withScratchDirectory(action) {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "tarball-verification-test-"));
  try {
    return action(scratchDirectory);
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

function writeDemoTarball(scratchDirectory) {
  const manifest = { name: "demo", version: "1.0.0", command: "node", args: ["plugin.mjs"], checksums: { "plugin.mjs": sha256Hex(Buffer.from(PLUGIN_SOURCE)) }, nodes: [] };
  const tarballPath = join(scratchDirectory, "demo-1.0.0.tar.gz");
  writeFileSync(tarballPath, createTarGz([
    { path: "demo", type: "directory" },
    { path: "demo/plugin.mjs", type: "file", content: Buffer.from(PLUGIN_SOURCE) },
    { path: "demo/graphrt-plugin.json", type: "file", content: Buffer.from(JSON.stringify(manifest)) },
  ], { mtimeSeconds: 0 }));
  return tarballPath;
}

/** A fake graphrt that logs its arguments and writes a marker into the `--dir` it is given. */
function writeFakeGraphrt(scratchDirectory, pluginName) {
  const logPath = join(scratchDirectory, "graphrt-calls.log");
  const graphrtPath = join(scratchDirectory, "fake-graphrt.sh");
  writeFileSync(graphrtPath, [
    "#!/bin/sh",
    `echo "$@" >> '${logPath}'`,
    'if [ "$2" = install ]; then mkdir -p "$5" && touch "$5/WRITTEN-BY-INSTALL"; exit 0; fi',
    `echo '[{"name":"${pluginName}","nodes":[]}]'`,
    "",
  ].join("\n"));
  chmodSync(graphrtPath, 0o755);
  return { graphrtPath, readCalls: () => readFileSync(logPath, "utf8").trim().split("\n").map((line) => line.split(" ")) };
}

test("refuses the audit's hidden top-level symlink (probe-symlink) and writes nothing through it", () => {
  withScratchDirectory((scratchDirectory) => {
    const victimDirectory = join(scratchDirectory, "victim-dir");
    mkdirSync(victimDirectory);
    const manifest = { name: "evil", version: "1.0.0", checksums: { "plugin.mjs": sha256Hex(Buffer.from(PLUGIN_SOURCE)) }, nodes: [] };
    const hiddenLink = Buffer.concat([...rawPaxHeader({ linkpath: victimDirectory }).flat(), rawHeader({ name: "installed", type: "2", linkname: "x" })]);
    const tarballPath = join(scratchDirectory, "evil-1.0.0.tar.gz");
    writeFileSync(tarballPath, rawTarGz([
      rawDirectory("evil"), rawFile("evil/plugin.mjs", PLUGIN_SOURCE), rawFile("evil/graphrt-plugin.json", JSON.stringify(manifest)),
      rawPaxHeader({ size: "0" }), [rawHeader({ name: "evil/pad.txt", size: hiddenLink.length }), hiddenLink],
    ]));
    const { graphrtPath } = writeFakeGraphrt(scratchDirectory, "evil");
    assert.throws(() => verifyTarball(tarballPath, { graphrtBinary: graphrtPath }), /PAX key `size` is not allowed/);
    assert.deepEqual(readdirSync(victimDirectory), []);
  });
});

test("refuses a symlink or other non-regular entry anywhere under the temporary root", () => {
  withScratchDirectory((scratchDirectory) => {
    const extractionRoot = join(scratchDirectory, "root");
    mkdirSync(join(extractionRoot, "demo", "lib"), { recursive: true });
    writeFileSync(join(extractionRoot, "demo", "plugin.mjs"), PLUGIN_SOURCE);
    assert.doesNotThrow(() => assertOnlyFilesAndDirectories(extractionRoot));
    symlinkSync(scratchDirectory, join(extractionRoot, "installed"));
    assert.throws(() => assertOnlyFilesAndDirectories(extractionRoot), /`installed` is a symlink/);
    rmSync(join(extractionRoot, "installed"));
    symlinkSync("/etc/passwd", join(extractionRoot, "demo", "lib", "passwd"));
    assert.throws(() => assertOnlyFilesAndDirectories(extractionRoot), /`demo\/lib\/passwd` is a symlink/);
  });
});

test("extracts with our own parser, never the system tar", () => {
  withScratchDirectory((scratchDirectory) => {
    const tarballPath = writeDemoTarball(scratchDirectory);
    const fakeBinDirectory = join(scratchDirectory, "bin");
    mkdirSync(fakeBinDirectory);
    writeFileSync(join(fakeBinDirectory, "tar"), "#!/bin/sh\necho 'system tar must not run' >&2\nexit 1\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDirectory}:${originalPath}`;
    try {
      assert.deepEqual(verifyTarball(tarballPath), { name: "demo", version: "1.0.0", pinnedFiles: 1 });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

test("runs graphrt plugin install into its own temporary directory, outside the extraction root", () => {
  withScratchDirectory((scratchDirectory) => {
    const tarballPath = writeDemoTarball(scratchDirectory);
    const { graphrtPath, readCalls } = writeFakeGraphrt(scratchDirectory, "demo");
    verifyTarball(tarballPath, { graphrtBinary: graphrtPath });
    const [installCall, listCall] = readCalls();
    assert.deepEqual(installCall.slice(0, 2), ["plugin", "install"]);
    const [pluginDirectory, installDirectory] = [installCall[2], installCall[4]];
    const extractionRoot = dirname(pluginDirectory);
    assert.ok(!installDirectory.startsWith(`${extractionRoot}/`), `install dir ${installDirectory} must not be inside ${extractionRoot}`);
    assert.notEqual(dirname(installDirectory), extractionRoot);
    assert.equal(listCall.at(-1), installDirectory);
    assert.ok(!existsSync(extractionRoot) && !existsSync(installDirectory), "both temporary directories are removed");
  });
});

test("runs graphrt with an isolated environment: no tokens, a temporary HOME, PATH kept", () => {
  withScratchDirectory((scratchDirectory) => {
    const tarballPath = writeDemoTarball(scratchDirectory);
    const environmentLogPath = join(scratchDirectory, "graphrt-env.log");
    const graphrtPath = join(scratchDirectory, "env-graphrt.sh");
    writeFileSync(graphrtPath, `#!/bin/sh\nenv >> '${environmentLogPath}'\nif [ "$2" = install ]; then exit 0; fi\necho '[{"name":"demo","nodes":[]}]'\n`, { mode: 0o755 });
    const savedVariables = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY };
    Object.assign(process.env, { GH_TOKEN: "ghp_test_secret", GITHUB_TOKEN: "ghs_test_secret", AWS_SECRET_ACCESS_KEY: "aws_test_secret" });
    try {
      verifyTarball(tarballPath, { graphrtBinary: graphrtPath });
    } finally {
      for (const [name, value] of Object.entries(savedVariables)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const loggedEnvironment = readFileSync(environmentLogPath, "utf8");
    assert.doesNotMatch(loggedEnvironment, /test_secret/);
    assert.match(loggedEnvironment, new RegExp(`^PATH=${process.env.PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    const homeDirectory = /^HOME=(.*)$/m.exec(loggedEnvironment)[1];
    assert.notEqual(homeDirectory, process.env.HOME);
    assert.match(homeDirectory, /graphrt-plugin-install-/);
  });
});

test("accepts an MCP preset without plugin.mjs when its guide is pinned", () => {
  withScratchDirectory((scratchDirectory) => {
    const guide = Buffer.from("- use {server}/find_jobs\n");
    const presetTarball = (checksums) => {
      const manifest = { name: "demo", version: "1.0.0", runtime: "mcp", mcp: { url: "https://mcp.example.com/mcp", guide: "guide.md" }, checksums };
      const tarballPath = join(scratchDirectory, "demo-1.0.0.tar.gz");
      writeFileSync(tarballPath, createTarGz([
        { path: "demo", type: "directory" },
        { path: "demo/guide.md", type: "file", content: guide },
        { path: "demo/graphrt-plugin.json", type: "file", content: Buffer.from(JSON.stringify(manifest)) },
      ], { mtimeSeconds: 0 }));
      return tarballPath;
    };
    assert.equal(verifyTarball(presetTarball({ "guide.md": sha256Hex(guide) })).pinnedFiles, 1);
    assert.throws(() => verifyTarball(presetTarball({})), /must pin its files|guide guide.md must be pinned/);
    assert.throws(() => verifyTarball(presetTarball({ "guide.md": "0".repeat(64) })), /checksum mismatch/);
  });
});
