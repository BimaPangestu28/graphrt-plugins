/**
 * Minimal deterministic tar.gz writer and STRICT reader for plugin release tarballs.
 *
 * Why not the system `tar`: bsdtar on macOS adds AppleDouble (`._*`) entries and
 * extended attributes, and GNU/BSD tar differ in ordering and metadata. Release
 * tarballs must be byte-for-byte reproducible from the same inputs, so entries are
 * written here in sorted order with a fixed mtime, uid/gid 0 and normalized modes.
 *
 * Only regular files and directories are supported; symlinks and other entry
 * types are rejected on write and on read (graphrt refuses pinned symlinks).
 * Paths longer than ustar allows are written with a PAX `path` record.
 *
 * The reader is strict on purpose: a community tarball comes from a third party, and an archive that another
 * tar implementation could read differently from us (so the manifest we check differs from the one a host
 * installs) is refused rather than interpreted. It refuses duplicate paths (also after case folding and Unicode
 * normalisation), PAX keys other than `path`, malformed PAX records or records holding NUL, size and mode
 * fields that are not plain octal (base-256 included), bad header checksums, every typeflag except files,
 * directories and PAX headers, data after the end-of-archive marker, and gzip input that is not exactly one
 * member. Nothing here extracts to disk: callers write the parsed entries themselves.
 */
import { gzipSync, inflateRawSync } from "node:zlib";

const BLOCK_SIZE = 512;
const FILE_TYPE = "0";
const LEGACY_FILE_TYPE = "";
const DIRECTORY_TYPE = "5";
const PAX_HEADER_TYPE = "x";
const USTAR_MAGIC = "ustar\0";
const USTAR_VERSION = "00";
/** PAX keys the reader accepts: our writer emits only `path`; every other key could change what tar extracts. */
const ALLOWED_PAX_KEYS = new Set(["path"]);
const OCTAL_FIELD_PATTERN = /^[0-7]+[ \0]*$/;
const CHECKSUM_FIELD_PATTERN = /^ *[0-7]+[ \0]*$/;
// C0/C1 controls, DEL, backslashes (a separator on Windows) and undecodable bytes have no place in a file name.
const UNSAFE_PATH_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\\�]/;
const GZIP_FLAG_HEADER_CRC = 0x02;
const GZIP_FLAG_EXTRA = 0x04;
const GZIP_FLAG_NAME = 0x08;
const GZIP_FLAG_COMMENT = 0x10;
const GZIP_RESERVED_FLAGS = 0xe0;
const GZIP_TRAILER_BYTES = 8;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Builds an uncompressed tar archive from in-memory entries.
 *
 * @param entries - Archive entries ({path: string, type: "file"|"directory", content?: Buffer, executable?: boolean}[])
 * @param options - Archive options
 * @param options.mtimeSeconds - Modification time written for every entry (number, Unix seconds)
 * @returns The .tar bytes (Buffer)
 * @throws Error - When an entry has an unsupported type or an unsafe path
 */
export function createTar(entries, { mtimeSeconds }) {
  const sortedEntries = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const blocks = sortedEntries.flatMap((entry) => encodeEntry(entry, mtimeSeconds));
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

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
  return gzipSync(createTar(entries, { mtimeSeconds }), { level: 9 });
}

/**
 * Reads a gzip-compressed ustar archive strictly (see the module comment for everything it refuses).
 *
 * @param archiveBytes - The .tar.gz bytes (Buffer)
 * @param options - Reading options
 * @param options.maxUnpackedBytes - Refuse archives that decompress to more than this (number, default: no limit)
 * @returns Entries in archive order ({path: string, type: "file"|"directory", content: Buffer, mode: number}[])
 * @throws Error - When the archive is not one gzip member holding one well-formed ustar archive of files and
 *   directories with unique, safe paths, or is too large unpacked
 */
export function readTarGz(archiveBytes, { maxUnpackedBytes = undefined } = {}) {
  const tarBytes = gunzipSingleMember(archiveBytes, maxUnpackedBytes);
  if (tarBytes.length % BLOCK_SIZE !== 0) throw new Error("tar data is not a whole number of 512-byte blocks");
  const entries = [];
  let offset = 0;
  let pendingPaxPath = null;
  while (offset + BLOCK_SIZE <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) {
      if (pendingPaxPath !== null) throw new Error("PAX header without an entry");
      assertEndOfArchive(tarBytes, offset);
      assertUniquePaths(entries);
      return entries;
    }
    const parsedHeader = parseHeader(header);
    const contentStart = offset + BLOCK_SIZE;
    if (contentStart + parsedHeader.size > tarBytes.length) throw new Error(`\`${parsedHeader.headerPath}\` is truncated`);
    const content = tarBytes.subarray(contentStart, contentStart + parsedHeader.size);
    offset = contentStart + Math.ceil(parsedHeader.size / BLOCK_SIZE) * BLOCK_SIZE;
    if (parsedHeader.typeFlag === PAX_HEADER_TYPE) {
      if (pendingPaxPath !== null) throw new Error("PAX header followed by another PAX header");
      pendingPaxPath = parsePaxPath(content);
      continue;
    }
    entries.push(buildEntry(parsedHeader, pendingPaxPath, content));
    pendingPaxPath = null;
  }
  if (pendingPaxPath !== null) throw new Error("PAX header without an entry");
  throw new Error("tar data has no end-of-archive marker");
}

function parseHeader(header) {
  const name = decodeHeaderString(header, 0, 100);
  const prefix = decodeHeaderString(header, 345, 155);
  const headerPath = prefix ? `${prefix}/${name}` : name;
  assertHeaderChecksum(header, headerPath);
  if (readRawField(header, 257, 6) !== USTAR_MAGIC || readRawField(header, 263, 2) !== USTAR_VERSION) {
    throw new Error(`\`${headerPath}\` is not a POSIX ustar header`);
  }
  const typeFlag = readRawField(header, 156, 1).replace(/\0$/, "");
  if (![FILE_TYPE, LEGACY_FILE_TYPE, DIRECTORY_TYPE, PAX_HEADER_TYPE].includes(typeFlag)) {
    throw new Error(`unsupported tar entry type \`${typeFlag}\` for \`${headerPath}\` (only files and directories are allowed)`);
  }
  const size = parseOctalField(header, 124, 12, `size field of \`${headerPath}\``);
  const mode = parseOctalField(header, 100, 8, `mode field of \`${headerPath}\``);
  if (decodeHeaderString(header, 157, 100) !== "") throw new Error(`\`${headerPath}\` has a link name`);
  if (typeFlag === DIRECTORY_TYPE && size !== 0) throw new Error(`directory \`${headerPath}\` has a size`);
  return { headerPath, typeFlag, size, mode };
}

function buildEntry({ headerPath, typeFlag, mode }, paxPath, content) {
  const isDirectory = typeFlag === DIRECTORY_TYPE;
  const rawPath = paxPath ?? headerPath;
  // Only a directory may carry the trailing slash: tar treats a "file" named `x/` as a directory.
  const entryPath = isDirectory ? rawPath.replace(/\/$/, "") : rawPath;
  assertSafeArchivePath(entryPath);
  return { path: entryPath, type: isDirectory ? "directory" : "file", content: Buffer.from(content), mode };
}

function assertHeaderChecksum(header, headerPath) {
  const checksumField = readRawField(header, 148, 8);
  if (!CHECKSUM_FIELD_PATTERN.test(checksumField)) throw new Error(`bad header checksum for \`${headerPath}\``);
  let expected = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) expected += index >= 148 && index < 156 ? 0x20 : header[index];
  if (Number.parseInt(checksumField.trim(), 8) !== expected) throw new Error(`bad header checksum for \`${headerPath}\``);
}

function parseOctalField(header, offset, length, label) {
  const field = readRawField(header, offset, length);
  if (!OCTAL_FIELD_PATTERN.test(field)) throw new Error(`${label} is not octal`);
  return Number.parseInt(field, 8);
}

function parsePaxPath(paxContent) {
  const records = new Map();
  let offset = 0;
  while (offset < paxContent.length) {
    const spaceIndex = paxContent.indexOf(0x20, offset);
    const lengthText = spaceIndex === -1 ? "" : paxContent.subarray(offset, spaceIndex).toString("latin1");
    const recordLength = /^[1-9]\d{0,8}$/.test(lengthText) ? Number(lengthText) : Number.NaN;
    const recordEnd = offset + recordLength;
    if (!Number.isFinite(recordLength) || recordEnd > paxContent.length || recordEnd <= spaceIndex + 1 || paxContent[recordEnd - 1] !== 0x0a) {
      throw new Error("malformed PAX record (bad length)");
    }
    const [key, value] = splitPaxRecord(paxContent.subarray(spaceIndex + 1, recordEnd - 1));
    if (records.has(key)) throw new Error(`malformed PAX record (duplicate key \`${key}\`)`);
    records.set(key, value);
    offset = recordEnd;
  }
  if (!records.has("path")) throw new Error("malformed PAX record (no path)");
  return records.get("path");
}

function splitPaxRecord(recordBody) {
  if (recordBody.includes(0)) throw new Error("PAX record holds a NUL byte");
  const equalsIndex = recordBody.indexOf(0x3d);
  if (equalsIndex <= 0) throw new Error("malformed PAX record (no key)");
  const key = decodeUtf8(recordBody.subarray(0, equalsIndex), "PAX key");
  if (!ALLOWED_PAX_KEYS.has(key)) throw new Error(`PAX key \`${key}\` is not allowed (only ${[...ALLOWED_PAX_KEYS].join(", ")})`);
  return [key, decodeUtf8(recordBody.subarray(equalsIndex + 1), "PAX value")];
}

function assertEndOfArchive(tarBytes, endMarkerOffset) {
  const secondBlock = tarBytes.subarray(endMarkerOffset + BLOCK_SIZE, endMarkerOffset + 2 * BLOCK_SIZE);
  if (secondBlock.length !== BLOCK_SIZE) throw new Error("tar data has no end-of-archive marker");
  if (!isZeroBlock(secondBlock) || !isZeroBlock(tarBytes.subarray(endMarkerOffset + 2 * BLOCK_SIZE))) {
    throw new Error("data after the end-of-archive marker");
  }
}

/** Two paths a case-insensitive, normalising file system (APFS, NTFS) would treat as one are duplicates too. */
function assertUniquePaths(entries) {
  const typeByFoldedPath = new Map();
  for (const entry of entries) {
    const foldedPath = foldPath(entry.path);
    if (typeByFoldedPath.has(foldedPath)) throw new Error(`duplicate archive path \`${entry.path}\``);
    typeByFoldedPath.set(foldedPath, entry.type);
  }
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestorPath = segments.slice(0, depth).join("/");
      if (typeByFoldedPath.get(foldPath(ancestorPath)) === "file") throw new Error(`\`${entry.path}\` is inside the file \`${ancestorPath}\``);
    }
  }
}

function foldPath(archivePath) {
  return archivePath.normalize("NFKC").toLowerCase().normalize("NFKC");
}

/** Decompresses exactly one gzip member and refuses anything after it (a second member, or junk). */
function gunzipSingleMember(archiveBytes, maxUnpackedBytes) {
  const bodyOffset = gzipBodyOffset(archiveBytes);
  const sizeLimit = maxUnpackedBytes === undefined ? {} : { maxOutputLength: maxUnpackedBytes };
  let inflated;
  try {
    inflated = inflateRawSync(archiveBytes.subarray(bodyOffset), { info: true, ...sizeLimit });
  } catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw new Error(`archive unpacks to more than ${maxUnpackedBytes} bytes`);
    throw new Error(`gzip data is corrupt: ${error.message}`);
  }
  const trailerOffset = bodyOffset + inflated.engine.bytesWritten;
  if (trailerOffset + GZIP_TRAILER_BYTES > archiveBytes.length) throw new Error("gzip data is truncated");
  if (trailerOffset + GZIP_TRAILER_BYTES !== archiveBytes.length) throw new Error("data after the gzip member (only one gzip member is allowed)");
  const tarBytes = inflated.buffer;
  if (archiveBytes.readUInt32LE(trailerOffset) !== crc32(tarBytes)) throw new Error("gzip CRC32 mismatch");
  if (archiveBytes.readUInt32LE(trailerOffset + 4) !== tarBytes.length % 2 ** 32) throw new Error("gzip size mismatch");
  return tarBytes;
}

function gzipBodyOffset(archiveBytes) {
  if (archiveBytes.length < 18 || archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b || archiveBytes[2] !== 8) throw new Error("not a gzip file");
  const flags = archiveBytes[3];
  if (flags & GZIP_RESERVED_FLAGS) throw new Error("gzip header has reserved flags set");
  let offset = 10;
  if (flags & GZIP_FLAG_EXTRA) offset += 2 + archiveBytes.readUInt16LE(offset);
  if (flags & GZIP_FLAG_NAME) offset = skipZeroTerminated(archiveBytes, offset);
  if (flags & GZIP_FLAG_COMMENT) offset = skipZeroTerminated(archiveBytes, offset);
  if (flags & GZIP_FLAG_HEADER_CRC) offset += 2;
  if (offset >= archiveBytes.length) throw new Error("gzip data is truncated");
  return offset;
}

function skipZeroTerminated(bytes, offset) {
  const terminatorIndex = bytes.indexOf(0, offset);
  if (terminatorIndex === -1) throw new Error("gzip data is truncated");
  return terminatorIndex + 1;
}

const CRC32_TABLE = Array.from({ length: 256 }, (unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
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

/**
 * Rejects archive paths that could escape the extraction directory or are ambiguous.
 *
 * @param archivePath - `/`-separated entry path without a trailing slash (string)
 * @throws Error - On an absolute path, an empty, `.` or `..` segment, or control characters and backslashes
 */
export function assertSafeArchivePath(archivePath) {
  const segments = archivePath.split("/");
  if (archivePath.startsWith("/") || segments.some((segment) => segment === ".." || segment === "" || segment === ".")) {
    throw new Error(`unsafe archive path \`${archivePath}\``);
  }
  if (UNSAFE_PATH_CHARACTER_PATTERN.test(archivePath)) throw new Error(`unsafe archive path ${JSON.stringify(archivePath)} (control characters or backslashes)`);
}

function isZeroBlock(bytes) {
  return bytes.every((byte) => byte === 0);
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

/** The field's raw bytes as latin1 (one character per byte), for magic, typeflag and numeric fields. */
function readRawField(header, offset, length) {
  return header.subarray(offset, offset + length).toString("latin1");
}

/** A NUL-terminated name field, which must be valid UTF-8. */
function decodeHeaderString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return decodeUtf8(field.subarray(0, terminator === -1 ? length : terminator), "tar header name");
}

function decodeUtf8(bytes, label) {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}
