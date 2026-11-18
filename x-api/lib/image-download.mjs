/**
 * Downloads an image from a public URL for upload_media.
 *
 * The download never carries credentials (it does not use the API client),
 * only follows https, stops reading past the size limit and only accepts
 * image/* content.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { rejectInput } from "./client.mjs";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;

/**
 * Fetches an image and returns it as a Blob.
 *
 * @param fetchImpl - fetch implementation (function)
 * @param imageUrl - https URL of the image (string)
 * @param signal - Cancellation signal (AbortSignal, optional)
 * @returns Image Blob with its content type (Promise<Blob>)
 * @throws PluginError kinds `invalid_input` (bad URL, HTTP error, not an image, over 5 MB), `network_error`, `cancelled`
 */
export async function downloadImage(fetchImpl, imageUrl, signal) {
  checkImageUrl(imageUrl);
  const response = await fetchImage(fetchImpl, imageUrl, signal);
  if (response.url && !response.url.startsWith("https:")) rejectInput("`image_url` redirected to a non-https URL");
  if (!response.ok) rejectInput(`Could not download \`image_url\`: HTTP ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) rejectInput(`\`image_url\` is not an image (content-type "${contentType || "none"}")`);
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) rejectSize();
  const imageBytes = await readLimitedBytes(response);
  return new Blob([imageBytes], { type: contentType });
}

function checkImageUrl(imageUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    rejectInput("`image_url` must be a valid URL");
  }
  if (parsedUrl.protocol !== "https:") rejectInput("`image_url` must use https");
}

async function fetchImage(fetchImpl, imageUrl, signal) {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    return await fetchImpl(imageUrl, { method: "GET", redirect: "follow", signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
  } catch (fetchError) {
    if (signal?.aborted) throw new PluginError("Download cancelled", { kind: "cancelled" });
    const reason = fetchError?.name === "TimeoutError" ? "timed out" : String(fetchError?.cause?.message ?? fetchError?.message ?? fetchError);
    throw new PluginError(`Could not download \`image_url\`: ${reason}`, { kind: "network_error" });
  }
}

async function readLimitedBytes(response) {
  if (!response.body) return new Uint8Array();
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    // Throwing inside for-await cancels the stream, so the rest is never downloaded.
    if (totalBytes > MAX_IMAGE_BYTES) rejectSize();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rejectSize() {
  rejectInput(`The image is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
}
