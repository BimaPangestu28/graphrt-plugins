/**
 * Local files for uploads and downloads, confined to allowlisted directories.
 *
 * Uploads: the file must be inside S3_UPLOAD_DIR after realpath on both sides (symlinks cannot leave it, and the
 * prefix check is separator-suffixed so /data/up-evil never matches /data/up), and must be a regular file (FIFOs and
 * devices are refused before they are opened) within the size cap.
 * Downloads: the file name is a single safe component inside the realpath of S3_DOWNLOAD_DIR, created exclusively
 * (an existing file or symlink is never overwritten), streamed with a byte cap, and removed again on any failure.
 */
import { randomBytes } from "node:crypto";
import { promises as defaultFileSystem } from "node:fs";
import { extname, isAbsolute, join, sep } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { DOWNLOAD_DIR_VARIABLE, UPLOAD_DIR_VARIABLE } from "./settings.mjs";

const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,199}$/;

/**
 * Reads a file to upload from inside the upload directory.
 *
 * @param filePath - Absolute path (string)
 * @param options - `{uploadDirectory, maxBytes}` (object)
 * @param fileSystem - node:fs promises API, for tests (object, default node:fs/promises)
 * @returns `{bytes, realPath}` (Promise<object>)
 * @throws PluginError kind `invalid_input` - Uploads disabled, relative path, outside the directory, missing,
 *   not a regular file, or larger than maxBytes
 */
export async function readUploadFile(filePath, { uploadDirectory, maxBytes }, fileSystem = defaultFileSystem) {
  if (!uploadDirectory) throw invalidFile(`Local uploads are disabled: set ${UPLOAD_DIR_VARIABLE} to the directory files may be uploaded from`);
  if (typeof filePath !== "string" || !isAbsolute(filePath)) throw invalidFile("`file_path` must be an absolute path");
  const outsideError = invalidFile(`\`file_path\` ${JSON.stringify(filePath)} is not a file inside ${UPLOAD_DIR_VARIABLE}`);
  const [realDirectory, realPath] = await Promise.all([fileSystem.realpath(uploadDirectory).catch(() => null), fileSystem.realpath(filePath).catch(() => null)]);
  if (!realDirectory || !realPath || !realPath.startsWith(withTrailingSeparator(realDirectory))) throw outsideError;
  // stat before open: opening a FIFO would block until something writes to it.
  if (!(await fileSystem.stat(realPath)).isFile()) throw invalidFile("`file_path` must be a regular file");
  const fileHandle = await fileSystem.open(realPath, "r");
  try {
    const fileStats = await fileHandle.stat();
    if (!fileStats.isFile()) throw invalidFile("`file_path` must be a regular file");
    if (fileStats.size > maxBytes) throw invalidFile(`\`file_path\` is larger than S3_MAX_UPLOAD_BYTES (${maxBytes} bytes)`);
    return { bytes: await fileHandle.readFile(), realPath };
  } finally {
    await fileHandle.close();
  }
}

/**
 * Picks the download file name: the requested one (checked), else a sanitized last segment of the key.
 *
 * @param key - Object key (string)
 * @param requestedName - `file_name` argument (string, optional)
 * @returns A single safe path component (string)
 * @throws PluginError kind `invalid_input` - When requestedName is not a safe file name
 *
 * @example
 * chooseDownloadFileName("reports/2026/q3 summary.pdf"); // "q3 summary.pdf"
 */
export function chooseDownloadFileName(key, requestedName) {
  if (requestedName !== undefined) {
    if (!SAFE_FILE_NAME_PATTERN.test(requestedName) || requestedName.includes("..")) {
      throw invalidFile("`file_name` must be a plain file name (letters, digits, space, \".\", \"_\", \"-\"; no slashes or \"..\")");
    }
    return requestedName;
  }
  const lastSegment = key.split("/").filter(Boolean).at(-1) ?? "";
  const sanitized = lastSegment.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\.{2,}/g, "_").replace(/^[.\s-]+/, "").slice(0, 200);
  return sanitized === "" ? "object" : sanitized;
}

/**
 * Streams a response body into a new file in the download directory.
 *
 * @param body - Response body (ReadableStream | AsyncIterable<Uint8Array>)
 * @param options - `{downloadDirectory, fileName, maxBytes}` (object)
 * @param fileSystem - node:fs promises API, for tests (object, default node:fs/promises)
 * @returns `{path, bytes}` (Promise<object>)
 * @throws PluginError kind `invalid_input` - Downloads disabled, or the body is larger than maxBytes (the partial file is removed)
 */
export async function saveStreamToDownloadFile(body, { downloadDirectory, fileName, maxBytes }, fileSystem = defaultFileSystem) {
  if (!downloadDirectory) throw invalidFile(`Saving objects is disabled: set ${DOWNLOAD_DIR_VARIABLE} to the directory downloads may be written to`);
  await fileSystem.mkdir(downloadDirectory, { recursive: true });
  const realDirectory = await fileSystem.realpath(downloadDirectory);
  const { fileHandle, path } = await createExclusiveFile(realDirectory, fileName, fileSystem);
  try {
    const bytes = await writeCapped(body, fileHandle, maxBytes);
    await fileHandle.close();
    return { path, bytes };
  } catch (writeError) {
    await fileHandle.close().catch(() => {});
    await fileSystem.rm(path, { force: true });
    throw writeError;
  }
}

async function createExclusiveFile(realDirectory, fileName, fileSystem) {
  const extension = extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidateName = attempt === 0 ? fileName : `${stem}-${randomBytes(3).toString("hex")}${extension}`;
    const path = join(realDirectory, candidateName);
    try {
      return { fileHandle: await fileSystem.open(path, "wx"), path };
    } catch (openError) {
      if (openError?.code !== "EEXIST") throw openError;
    }
  }
  throw invalidFile(`Could not find a free file name for ${JSON.stringify(fileName)} in ${DOWNLOAD_DIR_VARIABLE}`);
}

async function writeCapped(body, fileHandle, maxBytes) {
  let totalBytes = 0;
  for await (const chunk of body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) throw invalidFile(`The object is larger than S3_MAX_DOWNLOAD_BYTES (${maxBytes} bytes); nothing was saved`);
    await fileHandle.write(chunk);
  }
  return totalBytes;
}

/**
 * Reads at most maxBytes of a response body as UTF-8 text.
 *
 * @param body - Response body (ReadableStream | AsyncIterable<Uint8Array>)
 * @param maxBytes - Byte cap (number)
 * @returns `{text, bytesRead, truncated}` (Promise<object>)
 */
export async function readCappedText(body, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  let truncated = false;
  for await (const chunk of body) {
    const remainingBytes = maxBytes - totalBytes;
    if (chunk.byteLength > remainingBytes) {
      chunks.push(Buffer.from(chunk).subarray(0, remainingBytes));
      totalBytes += remainingBytes;
      truncated = true;
      break;
    }
    chunks.push(Buffer.from(chunk));
    totalBytes += chunk.byteLength;
  }
  const bytes = Buffer.concat(chunks);
  const wholeBytes = truncated ? bytes.subarray(0, completeUtf8Length(bytes)) : bytes;
  return { text: wholeBytes.toString("utf8"), bytesRead: wholeBytes.length, truncated };
}

// Length of the prefix that ends on a UTF-8 character boundary (drops a sequence the cap cut in half).
function completeUtf8Length(bytes) {
  let start = bytes.length - 1;
  while (start >= 0 && start > bytes.length - 4 && (bytes[start] & 0xc0) === 0x80) start -= 1;
  if (start < 0) return bytes.length;
  const leadByte = bytes[start];
  const sequenceLength = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : leadByte >= 0xc0 ? 2 : 1;
  return start + sequenceLength > bytes.length ? start : bytes.length;
}

function withTrailingSeparator(directory) {
  return directory.endsWith(sep) ? directory : `${directory}${sep}`;
}

function invalidFile(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
