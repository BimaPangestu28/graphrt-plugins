/**
 * Raw tar builders for tests: they write archives our own writer never would (duplicate entries, PAX overrides,
 * links, bad sizes), the way a hostile tarball could, so the strict reader and the verification can be checked
 * against them. Adapted from the audit probes (differential parsing against the system `tar`).
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

/**
 * Builds one ustar header block.
 *
 * @param fields - Header fields (object)
 * @param fields.name - Entry name (string)
 * @param fields.size - Size written as octal (number, default 0)
 * @param fields.type - Typeflag (string, default "0")
 * @param fields.linkname - Link target (string, default "")
 * @param fields.mode - Mode (number, default 0o644)
 * @param fields.sizeField - Raw bytes for the 12-byte size field instead of `size` (Buffer|string)
 * @param fields.checksumDelta - Added to the computed checksum to corrupt it (number, default 0)
 * @returns The header (Buffer)
 */
export function rawHeader({ name, size = 0, type = "0", linkname = "", mode = 0o644, sizeField = undefined, checksumDelta = 0 }) {
  const header = Buffer.alloc(BLOCK_SIZE);
  header.write(name, 0, 100);
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  if (sizeField === undefined) header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  else Buffer.from(sizeField, "latin1").copy(header, 124, 0, 12);
  header.write("00000000000\0", 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1);
  header.write(linkname, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0) + checksumDelta;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

/** @returns The bytes padded with zeros to a whole number of blocks (Buffer) */
export function padToBlock(bytes) {
  const paddedLength = Math.ceil(bytes.length / BLOCK_SIZE) * BLOCK_SIZE;
  return Buffer.concat([bytes, Buffer.alloc(paddedLength - bytes.length)]);
}

/** @returns Header and padded content blocks of a regular file (Buffer[]) */
export function rawFile(name, content, headerOverrides = {}) {
  const contentBytes = Buffer.from(content);
  return [rawHeader({ name, size: contentBytes.length, ...headerOverrides }), padToBlock(contentBytes)];
}

/** @returns The header block of a directory (Buffer[]) */
export function rawDirectory(name) {
  return [rawHeader({ name: `${name}/`, type: "5", mode: 0o755 })];
}

/** Encodes PAX records (`<length> <key>=<value>\n`) with correct lengths. */
export function encodePaxRecords(records) {
  return Buffer.from(Object.entries(records).map(([key, value]) => {
    const body = ` ${key}=${value}\n`;
    let recordLength = Buffer.byteLength(body) + 1;
    while (String(recordLength).length + Buffer.byteLength(body) !== recordLength) recordLength = String(recordLength).length + Buffer.byteLength(body);
    return `${recordLength}${body}`;
  }).join(""));
}

/** @returns A PAX extended header (type `x`) holding the records, or the raw body when given a Buffer (Buffer[]) */
export function rawPaxHeader(recordsOrBody) {
  const body = Buffer.isBuffer(recordsOrBody) ? recordsOrBody : encodePaxRecords(recordsOrBody);
  return [rawHeader({ name: "PaxHeader", size: body.length, type: "x" }), padToBlock(body)];
}

/** @returns The uncompressed tar: the blocks plus the two zero end-of-archive blocks (Buffer) */
export function rawTar(blocks) {
  return Buffer.concat([...blocks.flat(), Buffer.alloc(BLOCK_SIZE * 2)]);
}

/** @returns The gzip-compressed tar of the blocks (Buffer) */
export function rawTarGz(blocks) {
  return gzipSync(rawTar(blocks));
}

/** @returns Lowercase hex sha256 (string) */
export function sha256OfBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
