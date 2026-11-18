/**
 * Downloads a file from a public https URL for upload_media.
 *
 * The download never carries credentials (it does not use the API client).
 * Redirects are followed by hand and every hop must be https on a public host
 * (see public-https-fetch.mjs). The MIME type is checked against what WhatsApp
 * accepts for the media type, and reading stops past the size limit.
 *
 * Supported types and limits: developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 * (checked 2026-11: images are JPEG, PNG and static WebP, which WhatsApp transcodes to JPEG; stickers are WebP only).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { rejectInput } from "./client.mjs";
import { fetchPublicHttps } from "./public-https-fetch.mjs";

const KILOBYTE = 1024;
const MEGABYTE = 1024 * KILOBYTE;
const DOWNLOAD_TIMEOUT_MS = 120000;
// Servers that do not know the type send one of these; only then does `mime_type` replace it.
const GENERIC_CONTENT_TYPES = new Set(["", "application/octet-stream"]);

const DOCUMENT_MIME_TYPES = [
  "text/plain",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

/** File extension per accepted MIME type, for the default upload file name. */
export const FILE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "text/plain": "txt",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/**
 * Default upload file name for a MIME type, e.g. "upload.jpg".
 *
 * @param mimeType - Accepted MIME type (string)
 * @returns File name (string)
 */
export function defaultFileName(mimeType) {
  const extension = FILE_EXTENSIONS[mimeType];
  return extension ? `upload.${extension}` : "upload";
}

export const MEDIA_RULES = {
  image: { mimeTypes: ["image/jpeg", "image/png", "image/webp"], maxBytes: 5 * MEGABYTE, limitText: "5 MB" },
  video: { mimeTypes: ["video/mp4", "video/3gpp"], maxBytes: 16 * MEGABYTE, limitText: "16 MB" },
  audio: { mimeTypes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 16 * MEGABYTE, limitText: "16 MB" },
  document: { mimeTypes: DOCUMENT_MIME_TYPES, maxBytes: 100 * MEGABYTE, limitText: "100 MB" },
  // Animated stickers may be 500 KB, static ones 100 KB; the local check uses the larger limit.
  sticker: { mimeTypes: ["image/webp"], maxBytes: 500 * KILOBYTE, limitText: "500 KB" },
};

/**
 * Fetches a media file and returns it as a Blob with a WhatsApp-accepted MIME type.
 *
 * `mimeTypeOverride` is used only when the server reports no type or application/octet-stream; a specific type from
 * the server always wins, so a wrong override cannot relabel e.g. an HTML page as an image.
 *
 * @param fetchImpl - fetch implementation (function)
 * @param options - `{url, mediaType, mimeTypeOverride, signal, resolveHostAddresses?}` (object)
 * @returns File Blob (Promise<Blob>)
 * @throws PluginError kinds `invalid_input` (bad URL, internal host, HTTP error, wrong type, too large), `network_error`, `cancelled`
 */
export async function downloadMedia(fetchImpl, { url, mediaType, mimeTypeOverride, signal, resolveHostAddresses }) {
  const mediaRule = MEDIA_RULES[mediaType];
  const response = await fetchMediaFile(fetchImpl, { url, signal, resolveHostAddresses });
  if (!response.ok) rejectInput(`Could not download \`url\`: HTTP ${response.status}`);
  const mimeType = chooseMimeType(readContentType(response), mimeTypeOverride);
  if (!mediaRule.mimeTypes.includes(mimeType)) {
    rejectInput(`WhatsApp ${mediaType} must be one of ${mediaRule.mimeTypes.join(", ")}, got "${mimeType || "none"}" (pass \`mime_type\` if the server reports no type or application/octet-stream)`);
  }
  if (Number(response.headers.get("content-length")) > mediaRule.maxBytes) rejectSize(mediaType, mediaRule);
  const fileBytes = await readLimitedBytes(response, mediaType, mediaRule).catch((readError) => {
    // Our own size-limit error passes through; stalls and cancels while reading the body are classified.
    if (readError instanceof PluginError) throw readError;
    throw classifyDownloadFailure(readError, signal);
  });
  return new Blob([fileBytes], { type: mimeType });
}

function readContentType(response) {
  return (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

function chooseMimeType(serverMimeType, mimeTypeOverride) {
  if (mimeTypeOverride && GENERIC_CONTENT_TYPES.has(serverMimeType)) return mimeTypeOverride.trim().toLowerCase();
  return serverMimeType;
}

async function fetchMediaFile(fetchImpl, { url, signal, resolveHostAddresses }) {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const downloadSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetchPublicHttps(url, { fetchImpl, resolveHostAddresses, signal: downloadSignal, label: "url" });
  } catch (fetchError) {
    if (fetchError instanceof PluginError) throw fetchError;
    throw classifyDownloadFailure(fetchError, signal);
  }
}

function classifyDownloadFailure(downloadError, signal) {
  if (signal?.aborted) return new PluginError("Download cancelled", { kind: "cancelled" });
  const reason = downloadError?.name === "TimeoutError" ? "timed out" : String(downloadError?.cause?.message ?? downloadError?.message ?? downloadError);
  return new PluginError(`Could not download \`url\`: ${reason}`, { kind: "network_error" });
}

async function readLimitedBytes(response, mediaType, mediaRule) {
  if (!response.body) return new Uint8Array();
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    // Throwing inside for-await cancels the stream, so the rest is never downloaded.
    if (totalBytes > mediaRule.maxBytes) rejectSize(mediaType, mediaRule);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rejectSize(mediaType, mediaRule) {
  rejectInput(`The ${mediaType} is larger than WhatsApp's ${mediaRule.limitText} limit`);
}
