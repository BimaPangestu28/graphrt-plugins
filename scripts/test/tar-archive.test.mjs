import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createTarGz, readTarGz } from "../lib/tar-archive.mjs";
import { padToBlock, rawDirectory, rawFile, rawHeader, rawPaxHeader, rawTar, rawTarGz } from "./fixtures/raw-tar.mjs";

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
  const archive = rawTarGz([[rawHeader({ name: "demo/link", type: "2", linkname: "/etc" })]]);
  assert.throws(() => readTarGz(archive), /unsupported tar entry type `2`/);
});

// Strict reading: anything the system `tar` could read differently from us is refused (audit probe-tar.mjs).
const benignManifest = JSON.stringify({ name: "evil", version: "1.0.0", description: "harmless" });
const hostileManifest = JSON.stringify({ name: "evil", version: "1.0.0", description: "INSTALLED", permissions: { secrets: true } });
const benignPrefix = () => [rawDirectory("evil"), rawFile("evil/plugin.mjs", "export default 1;\n"), rawFile("evil/graphrt-plugin.json", benignManifest)];

test("refuses duplicate paths, where the system tar keeps the last copy", () => {
  assert.throws(() => readTarGz(rawTarGz([...benignPrefix(), rawFile("evil/graphrt-plugin.json", hostileManifest)])), /duplicate archive path `evil\/graphrt-plugin.json`/);
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), rawDirectory("evil")])), /duplicate archive path `evil`/);
});

test("refuses paths that collide on a case-insensitive or normalising file system", () => {
  assert.throws(() => readTarGz(rawTarGz([...benignPrefix(), rawFile("evil/GRAPHRT-PLUGIN.JSON", hostileManifest)])), /duplicate archive path `evil\/GRAPHRT-PLUGIN.JSON`/);
  const composed = "evil/café.json";
  const decomposed = "evil/café.json";
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), rawFile(composed, "{}"), rawFile(decomposed, "{}")])), /duplicate archive path/);
});

test("refuses a PAX size override that hides entries from our reader", () => {
  const hidden = Buffer.concat([...rawFile("evil/graphrt-plugin.json", hostileManifest), ...rawFile("evil/unpinned.mjs", "evil()")]);
  const blocks = [...benignPrefix(), rawPaxHeader({ size: "0" }), [rawHeader({ name: "evil/pad.txt", size: hidden.length }), hidden]];
  assert.throws(() => readTarGz(rawTarGz(blocks)), /PAX key `size` is not allowed/);
});

test("refuses PAX keys other than path, global headers and records that are malformed", () => {
  assert.throws(() => readTarGz(rawTarGz([rawPaxHeader({ linkpath: "/etc" }), rawDirectory("evil")])), /PAX key `linkpath` is not allowed/);
  assert.throws(() => readTarGz(rawTarGz([rawPaxHeader({ path: "evil/graphrt-plugin.json\u0000x" }), rawFile("evil/other.txt", hostileManifest)])), /PAX record .*NUL/);
  assert.throws(() => readTarGz(rawTarGz([rawPaxHeader(Buffer.from("99 path=evil\n")), rawDirectory("evil")])), /malformed PAX record/);
  assert.throws(() => readTarGz(rawTarGz([rawPaxHeader(Buffer.from("garbage")), rawDirectory("evil")])), /malformed PAX record/);
  assert.throws(() => readTarGz(rawTarGz([rawPaxHeader({ path: "evil/a" }), rawPaxHeader({ path: "evil/b" }), rawFile("evil/c", "")])), /PAX header followed by another PAX header/);
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), rawPaxHeader({ path: "evil/a" })])), /PAX header without an entry/);
  assert.throws(() => readTarGz(rawTarGz([[rawHeader({ name: "pax_global_header", type: "g" })], rawDirectory("evil")])), /unsupported tar entry type `g`/);
});

test("refuses base-256 and non-octal size fields", () => {
  const base256Size = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(10), Buffer.from([0x05])]);
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), [rawHeader({ name: "evil/a", sizeField: base256Size }), Buffer.alloc(512)]])), /size field of `evil\/a` is not octal/);
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), [rawHeader({ name: "evil/a", sizeField: "0000000009\0\0" })]])), /size field of `evil\/a` is not octal/);
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), [rawHeader({ name: "evil/a", sizeField: " 1\0" }), Buffer.alloc(512)]])), /size field of `evil\/a` is not octal/);
});

test("refuses a header with a bad checksum", () => {
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), rawFile("evil/a", "x", { checksumDelta: 1 })])), /bad header checksum for `evil\/a`/);
});

test("refuses hard links, symlinks, GNU long names and other typeflags", () => {
  for (const typeFlag of ["1", "2", "3", "4", "6", "7", "L", "K", "S", "V"]) {
    assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), [rawHeader({ name: "evil/x", type: typeFlag })]])), new RegExp(`unsupported tar entry type \`${typeFlag}\``));
  }
});

test("refuses data after the end-of-archive blocks, such as a lone zero block followed by more entries", () => {
  const loneZeroBlock = [...benignPrefix(), [Buffer.alloc(512)], rawFile("evil/graphrt-plugin.json", hostileManifest), rawFile("evil/hidden.mjs", "evil()")];
  assert.throws(() => readTarGz(rawTarGz(loneZeroBlock)), /data after the end-of-archive marker/);
  const trailingAfterEnd = Buffer.concat([rawTar(benignPrefix()), padToBlock(Buffer.from("x"))]);
  assert.throws(() => readTarGz(gzipSync(trailingAfterEnd)), /data after the end-of-archive marker/);
});

test("accepts zero padding after the end of the archive, as tar writes up to a 10 KiB record", () => {
  const archive = rawTar(benignPrefix());
  const recordPadded = Buffer.concat([archive, Buffer.alloc(10240 - (archive.length % 10240))]);
  assert.deepEqual(readTarGz(gzipSync(recordPadded)).map((entry) => entry.path), ["evil", "evil/plugin.mjs", "evil/graphrt-plugin.json"]);
});

test("refuses archives without an end-of-archive marker, truncated entries and partial blocks", () => {
  assert.throws(() => readTarGz(gzipSync(Buffer.concat(benignPrefix().flat()))), /no end-of-archive marker/);
  const truncated = Buffer.concat([rawHeader({ name: "evil/a", size: 4096 }), Buffer.alloc(512)]);
  assert.throws(() => readTarGz(gzipSync(truncated)), /`evil\/a` is truncated/);
  assert.throws(() => readTarGz(gzipSync(Buffer.concat([rawTar(benignPrefix()), Buffer.alloc(7)]))), /not a whole number of 512-byte blocks/);
});

test("refuses multi-member gzip and bytes after the gzip member", () => {
  const firstMember = rawTarGz(benignPrefix());
  const secondMember = gzipSync(rawTar([rawFile("evil/hidden.mjs", "evil()")]));
  assert.throws(() => readTarGz(Buffer.concat([firstMember, secondMember])), /data after the gzip member/);
  assert.throws(() => readTarGz(Buffer.concat([firstMember, Buffer.from("junk")])), /data after the gzip member/);
  assert.throws(() => readTarGz(Buffer.from("not gzip at all")), /not a gzip file/);
  const corruptedCrc = Buffer.from(firstMember);
  corruptedCrc[corruptedCrc.length - 8] ^= 0xff;
  assert.throws(() => readTarGz(corruptedCrc), /gzip CRC32 mismatch/);
});

test("refuses unnormalised paths, a file used as a directory and files named like directories", () => {
  assert.throws(() => readTarGz(rawTarGz([...benignPrefix(), rawFile("./evil/graphrt-plugin.json", hostileManifest)])), /unsafe archive path `\.\/evil\/graphrt-plugin.json`/);
  assert.throws(() => readTarGz(rawTarGz([...benignPrefix(), rawFile("evil//graphrt-plugin.json", hostileManifest)])), /unsafe archive path `evil\/\/graphrt-plugin.json`/);
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), rawFile("evil/lib", "x"), rawFile("evil/lib/a.mjs", "x")])), /`evil\/lib\/a.mjs` is inside the file `evil\/lib`/);
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), rawFile("evil/lib/", "")])), /unsafe archive path `evil\/lib\/`/);
  assert.throws(() => readTarGz(rawTarGz([rawDirectory("evil"), rawFile("evil/a\u0001b", "")])), /control characters/);
});
