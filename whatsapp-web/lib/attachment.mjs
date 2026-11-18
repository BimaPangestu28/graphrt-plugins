/**
 * Resolves the file for `send_file`: a local file inside an allowed directory,
 * or an https URL downloaded to a temporary directory.
 *
 * Local files need WHATSAPP_WEB_ALLOWED_FILE_DIRS: `send_file` is also an agent
 * tool, and without an allowlist an LLM could send any readable file (SSH keys,
 * tokens) to anyone.
 */
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import { invalidInput, notFound } from "./errors.mjs";

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
 * @returns `{filePath, cleanup}`; call `cleanup()` when done (Promise<object>)
 * @throws PluginError kinds `invalid_input` (bad URL/path, not allowed, too big), `not_found` (missing file or 404)
 */
export async function resolveAttachment(source, { allowedDirectories, fetchImpl = fetch, signal }) {
  if (/^https:\/\//i.test(source)) return downloadAttachment(source, fetchImpl, signal);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw invalidInput("`file` URLs must use https://");
  return { filePath: await resolveLocalFile(source, allowedDirectories), cleanup: async () => {} };
}

async function resolveLocalFile(localPath, allowedDirectories) {
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
  if (fileStats.size > MAX_ATTACHMENT_BYTES) throw invalidInput(`${localPath} is larger than ${MAX_ATTACHMENT_BYTES / 1048576} MB`);
  return resolvedPath;
}

async function downloadAttachment(url, fetchImpl, signal) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetchImpl(url, { redirect: "follow", signal: requestSignal });
  if (response.url && !/^https:\/\//i.test(response.url)) throw invalidInput("`file` URL redirected to a non-https address");
  if (response.status === 404) throw notFound(`File URL returned 404: ${url}`);
  if (!response.ok) throw invalidInput(`File URL returned HTTP ${response.status}: ${url}`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_ATTACHMENT_BYTES) throw tooLarge(url);
  const fileBytes = Buffer.from(await response.arrayBuffer());
  if (fileBytes.length > MAX_ATTACHMENT_BYTES) throw tooLarge(url);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "whatsapp-web-"));
  const filePath = join(temporaryDirectory, fileNameFromUrl(url));
  await writeFile(filePath, fileBytes);
  return { filePath, cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }) };
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

function tooLarge(url) {
  return invalidInput(`File at ${url} is larger than ${MAX_ATTACHMENT_BYTES / 1048576} MB`);
}
