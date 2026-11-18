/**
 * Downloads a file from a public https URL for upload_media.
 *
 * The download never carries credentials (it does not use the API client),
 * refuses non-https URLs (redirects are followed, but the final URL must be https), checks the MIME type against what
 * WhatsApp accepts for the media type, and stops reading past the size limit.
 *
 * Supported types and limits: developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { rejectInput } from "./client.mjs";

const KILOBYTE = 1024;
const MEGABYTE = 1024 * KILOBYTE;
const DOWNLOAD_TIMEOUT_MS = 120000;

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
 * @param fetchImpl - fetch implementation (function)
 * @param options - `{url, mediaType, mimeTypeOverride, signal}` (object)
 * @returns File Blob (Promise<Blob>)
 * @throws PluginError kinds `invalid_input` (bad URL, HTTP error, wrong type, too large), `network_error`, `cancelled`
 */
export async function downloadMedia(fetchImpl, { url, mediaType, mimeTypeOverride, signal }) {
  const mediaRule = MEDIA_RULES[mediaType];
  checkDownloadUrl(url);
  const response = await fetchMediaFile(fetchImpl, url, signal);
  if (response.url && !response.url.startsWith("https:")) rejectInput("`url` redirected to a non-https URL");
  if (!response.ok) rejectInput(`Could not download \`url\`: HTTP ${response.status}`);
  const mimeType = (mimeTypeOverride || readContentType(response)).toLowerCase();
  if (!mediaRule.mimeTypes.includes(mimeType)) {
    rejectInput(`WhatsApp ${mediaType} must be one of ${mediaRule.mimeTypes.join(", ")}, got "${mimeType || "none"}" (pass \`mime_type\` if the server reports the wrong type)`);
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
  return (response.headers.get("content-type") ?? "").split(";")[0].trim();
}

function checkDownloadUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    rejectInput("`url` must be a valid URL");
  }
  if (parsedUrl.protocol !== "https:") rejectInput("`url` must use https");
}

async function fetchMediaFile(fetchImpl, url, signal) {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { method: "GET", redirect: "follow", signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
  } catch (fetchError) {
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
