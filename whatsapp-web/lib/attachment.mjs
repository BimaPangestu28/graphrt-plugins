/**
 * Resolves the file for `send_file`: a local file inside an allowed directory,
 * or an https URL downloaded to a temporary directory.
 *
 * Local files need WHATSAPP_WEB_ALLOWED_FILE_DIRS: `send_file` is also an agent
 * tool, and without an allowlist an LLM could send any readable file (SSH keys,
 * tokens) to anyone.
 */
import { mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { cancelled, invalidInput, notFound } from "./errors.mjs";

/** WhatsApp Web's own limit for media is lower, but documents may be up to 2 GB; keep downloads bounded. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MEDIA_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".3gp", ".mov"]);

/**
 * Tells whether a file can be sent as photo/video (otherwise it is sent as a document).
 *
 * @param fileName - File name or path (string)
 * @returns true for image and video extensions WhatsApp previews (boolean)
 */
export function isMediaFile(fileName) {
  return MEDIA_EXTENSIONS.has(extname(fileName).toLowerCase());
}

/**
 * Resolves `source` to a local file path.
 *
 * @param source - Absolute local path or https URL (string)
 * @param options.allowedDirectories - Directories local files must be inside (string[])
 * @param options.fetchImpl - fetch implementation (function, optional)
 * @param options.signal - Cancellation signal (AbortSignal, optional)
 * @param options.maxBytes - Size limit, defaults to MAX_ATTACHMENT_BYTES (number, optional)
 * @returns `{filePath, cleanup}`; call `cleanup()` when done (Promise<object>)
 * @throws PluginError kinds `invalid_input` (bad URL/path, not allowed, too big), `not_found` (missing file or 404),
 *   `network_error` (download failed or timed out), `cancelled`
 */
export async function resolveAttachment(source, { allowedDirectories, fetchImpl = fetch, signal, maxBytes = MAX_ATTACHMENT_BYTES }) {
  if (/^https:\/\//i.test(source)) return downloadAttachment(source, { fetchImpl, signal, maxBytes });
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw invalidInput("`file` URLs must use https://");
  return { filePath: await resolveLocalFile(source, allowedDirectories, maxBytes), cleanup: async () => {} };
}

async function resolveLocalFile(localPath, allowedDirectories, maxBytes) {
  if (!isAbsolute(localPath)) throw invalidInput("`file` must be an absolute path or an https URL");
  if (allowedDirectories.length === 0) {
    throw invalidInput("Local files are disabled: set WHATSAPP_WEB_ALLOWED_FILE_DIRS to the directories send_file may read from, or pass an https URL");
  }
  const resolvedPath = await realpath(localPath).catch(() => {
    throw notFound(`File not found: ${localPath}`);
  });
  const resolvedAllowedDirectories = await Promise.all(allowedDirectories.map((directory) => realpath(directory).catch(() => null)));
  const isAllowed = resolvedAllowedDirectories.some((directory) => directory && resolvedPath.startsWith(directory + sep));
  if (!isAllowed) throw invalidInput(`${localPath} is outside WHATSAPP_WEB_ALLOWED_FILE_DIRS`);
  const fileStats = await stat(resolvedPath);
  if (!fileStats.isFile()) throw invalidInput(`${localPath} is not a regular file`);
  if (fileStats.size > maxBytes) throw invalidInput(`${localPath} is larger than ${formatMegabytes(maxBytes)}`);
  return resolvedPath;
}

async function downloadAttachment(url, { fetchImpl, signal, maxBytes }) {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchImpl(url, { redirect: "follow", signal: requestSignal }).catch((fetchError) => {
    throw classifyDownloadError(fetchError, url, signal);
  });
  if (response.url && !/^https:\/\//i.test(response.url)) throw invalidInput("`file` URL redirected to a non-https address");
  if (response.status === 404) throw notFound(`File URL returned 404: ${url}`);
  if (!response.ok) throw invalidInput(`File URL returned HTTP ${response.status}: ${url}`);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge(url, maxBytes);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "whatsapp-web-"));
  const cleanup = () => rm(temporaryDirectory, { recursive: true, force: true });
  const filePath = join(temporaryDirectory, fileNameFromUrl(url));
  try {
    await writeBodyToFile(response.body, filePath, { maxBytes, url });
  } catch (downloadError) {
    await cleanup();
    throw downloadError instanceof PluginError ? downloadError : classifyDownloadError(downloadError, url, signal);
  }
  return { filePath, cleanup };
}

// Streams the body to disk and stops reading (cancelling the download) as soon as it passes `maxBytes`.
async function writeBodyToFile(body, filePath, { maxBytes, url }) {
  const fileHandle = await open(filePath, "w");
  try {
    let byteCount = 0;
    for await (const chunk of body ?? []) {
      byteCount += chunk.byteLength;
      if (byteCount > maxBytes) throw tooLarge(url, maxBytes);
      await fileHandle.write(chunk);
    }
  } finally {
    await fileHandle.close();
  }
}

function classifyDownloadError(downloadError, url, signal) {
  if (signal?.aborted) return cancelled();
  const reason = downloadError?.name === "TimeoutError" ? `timed out after ${DOWNLOAD_TIMEOUT_MS / 1000} s` : String(downloadError?.message ?? downloadError);
  return new PluginError(`Downloading ${url} failed: ${reason}`, { kind: "network_error", retryable: true });
}

function fileNameFromUrl(url) {
  const rawSegment = basename(new URL(url).pathname) || "";
  let lastSegment;
  try {
    lastSegment = decodeURIComponent(rawSegment);
  } catch {
    lastSegment = rawSegment;
  }
  const safeName = lastSegment.replace(/[^\w.\- ]/g, "_").slice(0, 120);
  return safeName && safeName !== "." && safeName !== ".." ? safeName : "attachment";
}

function tooLarge(url, maxBytes) {
  return invalidInput(`File at ${url} is larger than ${formatMegabytes(maxBytes)}`);
}

function formatMegabytes(byteCount) {
  return `${Math.round((byteCount / 1048576) * 100) / 100} MB`;
}
