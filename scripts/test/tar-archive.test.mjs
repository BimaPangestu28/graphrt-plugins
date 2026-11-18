import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createTarGz, readTarGz } from "../lib/tar-archive.mjs";

const fixedTime = { mtimeSeconds: 1_700_000_000 };

test("round-trips files and directories in sorted order", () => {
  const archive = createTarGz(
    [
      { path: "demo/plugin.mjs", type: "file", content: Buffer.from("console.log(1)\n") },
      { path: "demo", type: "directory" },
      { path: "demo/lib", type: "directory" },
      { path: "demo/lib/run.sh", type: "file", content: Buffer.from("#!/bin/sh\n"), executable: true },
    ],
    fixedTime,
  );
  const entries = readTarGz(archive);
  assert.deepEqual(entries.map((entry) => [entry.path, entry.type]), [
    ["demo", "directory"],
    ["demo/lib", "directory"],
    ["demo/lib/run.sh", "file"],
    ["demo/plugin.mjs", "file"],
  ]);
  assert.equal(entries[3].content.toString(), "console.log(1)\n");
  assert.equal(entries[2].mode, 0o755);
  assert.equal(entries[3].mode, 0o644);
});

test("is byte-for-byte reproducible", () => {
  const entries = [{ path: "demo/a.json", type: "file", content: Buffer.from("{}") }];
  assert.deepEqual(createTarGz(entries, fixedTime), createTarGz([...entries].reverse(), fixedTime));
});

test("keeps long paths with a ustar prefix or a PAX record", () => {
  const prefixedPath = `demo/${"d".repeat(90)}/${"f".repeat(60)}.js`;
  const paxPath = `demo/${"x".repeat(180)}.js`;
  const entries = readTarGz(
    createTarGz(
      [
        { path: prefixedPath, type: "file", content: Buffer.from("a") },
        { path: paxPath, type: "file", content: Buffer.from("b") },
      ],
      fixedTime,
    ),
  );
  assert.deepEqual(entries.map((entry) => entry.path).sort(), [prefixedPath, paxPath].sort());
});

test("rejects unsafe paths and unsupported entry types on write", () => {
  assert.throws(() => createTarGz([{ path: "../evil", type: "file", content: Buffer.alloc(0) }], fixedTime), /unsafe archive path/);
  assert.throws(() => createTarGz([{ path: "/abs", type: "file", content: Buffer.alloc(0) }], fixedTime), /unsafe archive path/);
  assert.throws(() => createTarGz([{ path: "demo/link", type: "symlink" }], fixedTime), /unsupported entry type/);
});

test("rejects symlink entries on read", () => {
  const header = Buffer.alloc(512);
  header.write("demo/link", 0);
  header.write("0000644\0", 100);
  header.write("00000000000\0", 124);
  header.write("2", 156);
  header.write("ustar", 257);
  const archive = gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
  assert.throws(() => readTarGz(archive), /unsupported tar entry type `2`/);
});
