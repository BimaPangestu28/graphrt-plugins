/**
 * Reads a slice of one allowlisted regular file.
 *
 * The file is resolved by lib/file-access.mjs (realpath containment, regular
 * files only, no hard links), then opened with O_NOFOLLOW and O_NONBLOCK and
 * checked again on the open handle, so a path swapped for a symlink or FIFO
 * after the checks fails instead of escaping or hanging. At most `maxBytes`
 * are read; `truncated` says more remain and `next_offset` where to continue.
 */
import { constants as fileConstants } from "node:fs";
import { invalidInput } from "./errors.mjs";

const SAFE_OPEN_FLAGS = fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0) | (fileConstants.O_NONBLOCK ?? 0);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Opens an already resolved real path safely and checks it is still a plain regular file.
 *
 * @param fileSystem - `node:fs` promises API (object)
 * @param realPath - Real path inside the allowlist (string)
 * @param rawPath - The caller's path, for messages (string)
 * @returns Open FileHandle and its stats `{fileHandle, fileStats}` (Promise<object>)
 * @throws PluginError kind `invalid_input` - When it is no longer a regular file with one link
 */
export async function openRegularFile(fileSystem, realPath, rawPath) {
  const fileHandle = await fileSystem.open(realPath, SAFE_OPEN_FLAGS);
  try {
    const fileStats = await fileHandle.stat();
    if (!fileStats.isFile()) throw invalidInput(`${JSON.stringify(rawPath)} is not a regular file`);
    if (fileStats.nlink > 1) throw invalidInput(`${JSON.stringify(rawPath)} has ${fileStats.nlink} hard links and is refused (a hard link could point outside the allowed directories)`);
    return { fileHandle, fileStats };
  } catch (checkError) {
    await fileHandle.close();
    throw checkError;
  }
}

/**
 * Reads up to `maxBytes` from `offset`.
 *
 * @param client - `{fileAccess, fileSystem}` from the client (object)
 * @param request - `{rawPath, offset, maxBytes, encoding}`; encoding "utf8" or "base64" (object)
 * @returns `{path, size_bytes, offset, bytes_read, next_offset, truncated, encoding, content}` (Promise<object>)
 * @throws PluginError kinds `not_found` (missing or outside), `invalid_input` (not a regular file, hard-linked, not UTF-8)
 */
export async function readFileSlice({ fileAccess, fileSystem }, { rawPath, offset, maxBytes, encoding }) {
  const { path: realPath } = await fileAccess.resolveInputFile(rawPath, { parameterName: "path" });
  const { fileHandle, fileStats } = await openRegularFile(fileSystem, realPath, rawPath);
  try {
    const wantedBytes = Math.max(0, Math.min(maxBytes, fileStats.size - offset));
    const rawBytes = await readExactly(fileHandle, wantedBytes, offset);
    const hasMore = offset + rawBytes.length < fileStats.size;
    const bytes = encoding === "utf8" && hasMore ? trimIncompleteUtf8(rawBytes) : rawBytes;
    const truncated = offset + bytes.length < fileStats.size;
    return {
      path: realPath,
      size_bytes: fileStats.size,
      offset,
      bytes_read: bytes.length,
      next_offset: truncated ? offset + bytes.length : null,
      truncated,
      encoding,
      content: encodeContent(bytes, encoding, rawPath),
    };
  } finally {
    await fileHandle.close();
  }
}

async function readExactly(fileHandle, length, position) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await fileHandle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Drops a UTF-8 sequence cut off at the end of a slice, so the slice decodes cleanly.
 *
 * @param bytes - Slice of a UTF-8 file (Buffer)
 * @returns The slice without an incomplete trailing character (Buffer)
 *
 * @example
 * trimIncompleteUtf8(Buffer.from([0x61, 0xe2, 0x82])); // <Buffer 61>
 */
export function trimIncompleteUtf8(bytes) {
  for (let back = 1; back <= Math.min(4, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const sequenceLength = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return sequenceLength > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

function encodeContent(bytes, encoding, rawPath) {
  if (encoding === "base64") return bytes.toString("base64");
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    throw invalidInput(`${JSON.stringify(rawPath)} is not valid UTF-8 text at this offset; read it with encoding: "base64"`);
  }
}
