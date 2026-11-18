/**
 * Minimal deterministic tar.gz writer and reader for plugin release tarballs.
 *
 * Why not the system `tar`: bsdtar on macOS adds AppleDouble (`._*`) entries and
 * extended attributes, and GNU/BSD tar differ in ordering and metadata. Release
 * tarballs must be byte-for-byte reproducible from the same inputs, so entries are
 * written here in sorted order with a fixed mtime, uid/gid 0 and normalized modes.
 *
 * Only regular files and directories are supported; symlinks and other entry
 * types are rejected on write and on read (graphrt refuses pinned symlinks).
 * Paths longer than ustar allows are written with a PAX `path` record.
 */
import { gzipSync, gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const FILE_TYPE = "0";
const DIRECTORY_TYPE = "5";
const PAX_HEADER_TYPE = "x";

/**
 * Builds a gzip-compressed tar archive from in-memory entries.
 *
 * @param entries - Archive entries ({path: string, type: "file"|"directory", content?: Buffer, executable?: boolean}[])
 * @param options - Archive options
 * @param options.mtimeSeconds - Modification time written for every entry (number, Unix seconds)
 * @returns The .tar.gz bytes (Buffer)
 * @throws Error - When an entry has an unsupported type or an unsafe path
 */
export function createTarGz(entries, { mtimeSeconds }) {
  const sortedEntries = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const blocks = sortedEntries.flatMap((entry) => encodeEntry(entry, mtimeSeconds));
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/**
 * Reads a gzip-compressed tar archive produced by createTarGz (or any plain ustar/PAX archive).
 *
 * @param archiveBytes - The .tar.gz bytes (Buffer)
 * @returns Entries ({path: string, type: "file"|"directory", content: Buffer, mode: number}[])
 * @throws Error - When the archive contains a symlink, hard link or other unsupported entry
 */
export function readTarGz(archiveBytes) {
  const tarBytes = gunzipSync(archiveBytes);
  const entries = [];
  let offset = 0;
  let pendingPaxPath = null;
  while (offset + BLOCK_SIZE <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(readString(header, 124, 12).trim() || "0", 8);
    const typeFlag = readString(header, 156, 1) || FILE_TYPE;
    const content = tarBytes.subarray(offset + BLOCK_SIZE, offset + BLOCK_SIZE + size);
    offset += BLOCK_SIZE + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (typeFlag === PAX_HEADER_TYPE) {
      pendingPaxPath = parsePaxPath(content);
      continue;
    }
    const prefix = readString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${readString(header, 0, 100)}` : readString(header, 0, 100);
    const entryPath = (pendingPaxPath ?? headerPath).replace(/\/$/, "");
    pendingPaxPath = null;
    if (typeFlag !== FILE_TYPE && typeFlag !== DIRECTORY_TYPE) {
      throw new Error(`unsupported tar entry type \`${typeFlag}\` for \`${entryPath}\` (only files and directories are allowed)`);
    }
    const mode = parseInt(readString(header, 100, 8).trim() || "0", 8);
    entries.push({ path: entryPath, type: typeFlag === DIRECTORY_TYPE ? "directory" : "file", content: Buffer.from(content), mode });
  }
  return entries;
}

function encodeEntry(entry, mtimeSeconds) {
  assertSafeArchivePath(entry.path);
  if (entry.type !== "file" && entry.type !== "directory") {
    throw new Error(`unsupported entry type \`${entry.type}\` for \`${entry.path}\``);
  }
  const isDirectory = entry.type === "directory";
  const headerPath = isDirectory ? `${entry.path}/` : entry.path;
  const content = isDirectory ? Buffer.alloc(0) : entry.content;
  const mode = isDirectory || entry.executable ? 0o755 : 0o644;
  const blocks = [];
  const splitPath = splitUstarPath(headerPath);
  if (!splitPath) {
    const paxRecord = encodePaxRecord("path", headerPath);
    blocks.push(encodeHeader({ name: "PaxHeader", prefix: "", size: paxRecord.length, mode: 0o644, typeFlag: PAX_HEADER_TYPE, mtimeSeconds }));
    blocks.push(padToBlock(paxRecord));
  }
  const { name, prefix } = splitPath ?? { name: headerPath.slice(-100), prefix: "" };
  blocks.push(encodeHeader({ name, prefix, size: content.length, mode, typeFlag: isDirectory ? DIRECTORY_TYPE : FILE_TYPE, mtimeSeconds }));
  if (content.length > 0) blocks.push(padToBlock(content));
  return blocks;
}

function encodeHeader({ name, prefix, size, mode, typeFlag, mtimeSeconds }) {
  const header = Buffer.alloc(BLOCK_SIZE);
  writeString(header, name, 0, 100);
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, mtimeSeconds, 136, 12);
  header.fill(0x20, 148, 156);
  writeString(header, typeFlag, 156, 1);
  writeString(header, "ustar", 257, 6);
  writeString(header, "00", 263, 2);
  writeString(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function splitUstarPath(headerPath) {
  if (Buffer.byteLength(headerPath) <= 100) return { name: headerPath, prefix: "" };
  for (let slashIndex = headerPath.indexOf("/"); slashIndex !== -1; slashIndex = headerPath.indexOf("/", slashIndex + 1)) {
    const prefix = headerPath.slice(0, slashIndex);
    const name = headerPath.slice(slashIndex + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { name, prefix };
  }
  return null;
}

function encodePaxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let recordLength = Buffer.byteLength(body) + 1;
  while (String(recordLength).length + Buffer.byteLength(body) !== recordLength) {
    recordLength = String(recordLength).length + Buffer.byteLength(body);
  }
  return Buffer.from(`${recordLength}${body}`);
}

function parsePaxPath(paxContent) {
  for (const record of paxContent.toString("utf8").split("\n")) {
    const match = record.match(/^\d+ path=(.*)$/);
    if (match) return match[1];
  }
  return null;
}

function assertSafeArchivePath(archivePath) {
  const segments = archivePath.split("/");
  if (archivePath.startsWith("/") || segments.some((segment) => segment === ".." || segment === "" || segment === ".")) {
    throw new Error(`unsafe archive path \`${archivePath}\``);
  }
}

function padToBlock(content) {
  const paddedLength = Math.ceil(content.length / BLOCK_SIZE) * BLOCK_SIZE;
  return content.length === paddedLength ? content : Buffer.concat([content, Buffer.alloc(paddedLength - content.length)]);
}

function writeString(header, value, offset, length) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(header, value, offset, length) {
  writeString(header, `${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
}

function readString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? length : terminator).toString("utf8");
}
