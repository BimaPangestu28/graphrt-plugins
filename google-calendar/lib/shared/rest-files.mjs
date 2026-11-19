/**
 * Files for declarative REST operations: multipart file inputs (a local path inside an allowlisted directory, or a
 * public https URL) and base64 response fields written to disk.
 *
 * Local paths: the directory comes from an env var; both sides are resolved with realpath (so symlinks cannot
 * leave it), the target must be a regular file (no FIFOs or devices) and within the size cap.
 */
import { open, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import { PluginError } from "./graphrt-plugin.mjs";
import { EXTENSIONS_BY_MEDIA_TYPE, fetchPublicHttpsBytes } from "./public-https-fetch.mjs";

export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const MEDIA_TYPES_BY_EXTENSION = Object.fromEntries(Object.entries(EXTENSIONS_BY_MEDIA_TYPE).map(([mediaType, extension]) => [extension, mediaType]).reverse());
const MAGIC_NUMBERS = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["application/pdf", [0x25, 0x50, 0x44, 0x46]],
  ["audio/mpeg", [0x49, 0x44, 0x33]],
  ["audio/mpeg", [0xff, 0xfb]],
  ["audio/ogg", [0x4f, 0x67, 0x67, 0x53]],
  ["audio/flac", [0x66, 0x4c, 0x61, 0x43]],
];
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]*={0,2}$/;

/**
 * Reads a multipart file input.
 *
 * @param fileReference - Absolute local path, or an https URL (string)
 * @param options - `{paramName, fileDirEnv, environment, maxBytes, fetchImpl, resolveHostAddresses, signal, timeoutMs?}`;
 *   `timeoutMs` bounds the download of a URL input (object)
 * @returns `{bytes, fileName, contentType}` (Promise<object>)
 * @throws PluginError kind `invalid_input` - Not https, outside the allowlist, not a regular file, too large, or no allowlist env
 */
export async function readFileInput(fileReference, options) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (/^https:\/\//i.test(fileReference)) {
    const { fetchImpl, resolveHostAddresses, signal, paramName, timeoutMs } = options;
    return fetchPublicHttpsBytes(fileReference, { fetchImpl, resolveHostAddresses, signal, maxBytes, timeoutMs, label: paramName });
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(fileReference)) throw invalidFile(options.paramName, "must be an https URL or an absolute local path");
  return readAllowlistedFile(fileReference, options, maxBytes);
}

async function readAllowlistedFile(filePath, { paramName, fileDirEnv, environment }, maxBytes) {
  const allowedDirectory = fileDirEnv ? environment?.[fileDirEnv]?.trim() : undefined;
  if (!allowedDirectory) throw invalidFile(paramName, `is a local path, but local files are disabled; set ${fileDirEnv ?? "the plugin's upload directory env"} to an allowed directory, or pass an https URL`);
  if (!isAbsolute(filePath)) throw invalidFile(paramName, "must be an absolute path");
  const [realDirectory, realFile] = await Promise.all([realpath(allowedDirectory), realpath(filePath).catch(() => null)]);
  if (!realFile) throw invalidFile(paramName, `file ${filePath} does not exist`);
  if (!realFile.startsWith(realDirectory.endsWith(sep) ? realDirectory : `${realDirectory}${sep}`)) throw invalidFile(paramName, `file ${filePath} is outside ${fileDirEnv}`);
  return readRegularFile(realFile, paramName, maxBytes);
}

// stat before open: opening a FIFO would block until something writes to it.
async function readRegularFile(realFile, paramName, maxBytes) {
  if (!(await stat(realFile)).isFile()) throw invalidFile(paramName, "must be a regular file");
  const fileHandle = await open(realFile, "r");
  try {
    const fileStats = await fileHandle.stat();
    if (!fileStats.isFile()) throw invalidFile(paramName, "must be a regular file");
    if (fileStats.size > maxBytes) throw invalidFile(paramName, `file is larger than the ${maxBytes} bytes limit`);
    const bytes = await fileHandle.readFile();
    return { bytes, fileName: basename(realFile), contentType: MEDIA_TYPES_BY_EXTENSION[extname(realFile).toLowerCase()] ?? "application/octet-stream" };
  } finally {
    await fileHandle.close();
  }
}

/**
 * Decodes a base64 (or base64url) string and writes it to `<directory>/<fileBaseName><ext>`; the type is sniffed.
 *
 * @param encodedValue - Base64 text, optionally a `data:<type>;base64,` URL (string)
 * @param options - `{directory, fileBaseName, maxBytes}` (object)
 * @returns `{path, bytes, content_type}` (Promise<object>)
 * @throws PluginError kind `invalid_input` - Not base64, or larger than maxBytes
 */
export async function saveBase64ToFile(encodedValue, { directory, fileBaseName, maxBytes }) {
  const dataUrlMatch = /^data:([\w.+-]+\/[\w.+-]+);base64,/.exec(encodedValue);
  const base64Text = dataUrlMatch ? encodedValue.slice(dataUrlMatch[0].length) : encodedValue;
  if (!BASE64_PATTERN.test(base64Text)) throw new PluginError("A base64 field holds data that is not base64", { kind: "invalid_input" });
  if ((base64Text.length * 3) / 4 > maxBytes) throw new PluginError(`A base64 field is larger than the ${maxBytes} bytes limit`, { kind: "invalid_input" });
  const bytes = Buffer.from(base64Text, "base64");
  const contentType = dataUrlMatch?.[1] ?? sniffMediaType(bytes);
  const filePath = join(directory, `${fileBaseName}${EXTENSIONS_BY_MEDIA_TYPE[contentType] ?? ".bin"}`);
  await writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, bytes: bytes.length, content_type: contentType };
}

/**
 * Guesses a media type from the first bytes.
 *
 * @param bytes - File content (Buffer)
 * @returns Media type, "application/octet-stream" when unknown (string)
 */
export function sniffMediaType(bytes) {
  const startsWith = (signature) => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (start, end) => bytes.subarray(start, end).toString("latin1");
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(4, 8) === "ftyp") return "video/mp4";
  return MAGIC_NUMBERS.find(([, signature]) => startsWith(signature))?.[0] ?? "application/octet-stream";
}

function invalidFile(paramName, problem) {
  return new PluginError(`\`${paramName}\` ${problem}`, { kind: "invalid_input" });
}
