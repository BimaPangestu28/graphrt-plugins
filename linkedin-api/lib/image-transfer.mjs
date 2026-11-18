/**
 * Binary transfers for `upload_image`: download an image from a public https
 * URL (no credentials) and PUT its bytes to the LinkedIn upload URL.
 *
 * The download follows redirects by hand and refuses http and internal hosts
 * on every hop (see shared/public-https-fetch.mjs). The upload URL is on a different
 * LinkedIn host than the REST API, so the shared client (which only allows its
 * own origin) cannot be used. The Bearer token is sent only when that host is
 * https and ends with `.linkedin.com`.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { fetchPublicHttps } from "./shared/public-https-fetch.mjs";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Each transfer (the whole download including redirects, or the PUT) gets this long. */
export const TRANSFER_TIMEOUT_MS = 60000;
// The Images API accepts JPG, PNG and GIF only.
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);
const UPLOAD_STATUS_KINDS = { 400: "invalid_input", 401: "auth_error", 403: "permission_denied", 404: "not_found", 429: "rate_limited" };

/**
 * Downloads an image, enforcing https on public hosts (every redirect hop), JPEG/PNG/GIF and a 10 MB limit.
 *
 * @param options - `{fetchImpl, imageUrl, signal, resolveHostAddresses?}` (object)
 * @returns `{imageBytes, contentType}` (Promise<object>)
 * @throws PluginError kind `invalid_input` - Bad URL, internal host, failed download, unsupported type or too large; `network_error`, `cancelled`
 */
export async function downloadImage({ fetchImpl, imageUrl, signal, resolveHostAddresses }) {
  const imageResponse = await withTransferTimeout(signal, (transferSignal) =>
    fetchPublicHttps(imageUrl, { fetchImpl, resolveHostAddresses, signal: transferSignal, label: "image_url" }),
  );
  if (!imageResponse.ok) throw invalidImage(`could not download image_url: HTTP ${imageResponse.status}`);
  const contentType = imageResponse.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) throw invalidImage(`image_url must be a JPEG, PNG or GIF image (content-type "${contentType}")`);
  if (Number(imageResponse.headers.get("content-length")) > MAX_IMAGE_BYTES) throw invalidImage("image is larger than 10 MB");
  const imageBytes = await readBodyWithLimit(imageResponse, MAX_IMAGE_BYTES, signal);
  return { imageBytes, contentType: mediaType };
}

/**
 * PUTs image bytes to a LinkedIn upload URL with the Bearer token.
 *
 * @param options - `{fetchImpl, uploadUrl, accessToken, imageBytes, signal}` (object)
 * @returns Resolves when LinkedIn accepted the bytes (Promise<void>)
 * @throws PluginError kind `api_error` - When the upload URL is not on linkedin.com; status-based kinds on failure
 */
export async function uploadImageBytes({ fetchImpl, uploadUrl, accessToken, imageBytes, signal }) {
  assertLinkedInUploadHost(uploadUrl);
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/octet-stream" };
  const uploadResponse = await withTransferTimeout(signal, (transferSignal) =>
    fetchImpl(uploadUrl, { method: "PUT", headers, body: imageBytes, signal: transferSignal }),
  );
  if (uploadResponse.ok) return;
  const responseText = (await uploadResponse.text()).slice(0, 300).split(accessToken).join("[redacted]");
  const kind = UPLOAD_STATUS_KINDS[uploadResponse.status] ?? "api_error";
  throw new PluginError(`Image upload failed: HTTP ${uploadResponse.status} ${responseText}`.trim(), { kind, retryable: kind === "rate_limited" });
}

function assertLinkedInUploadHost(uploadUrl) {
  let parsedUploadUrl;
  try {
    parsedUploadUrl = new URL(uploadUrl);
  } catch {
    throw new PluginError("LinkedIn returned an invalid uploadUrl", { kind: "api_error" });
  }
  const isLinkedInHost = parsedUploadUrl.protocol === "https:" && parsedUploadUrl.hostname.endsWith(".linkedin.com");
  if (!isLinkedInHost) {
    throw new PluginError(`Refusing to send the token to ${parsedUploadUrl.origin}: upload URLs must be https on *.linkedin.com`, { kind: "api_error" });
  }
}

// Runs one transfer with its own timeout; policy errors pass through, transport errors are classified.
async function withTransferTimeout(callerSignal, runTransfer) {
  const timeoutSignal = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  try {
    return await runTransfer(signal);
  } catch (transferError) {
    throw classifyTransferError(transferError, callerSignal);
  }
}

function classifyTransferError(transferError, callerSignal) {
  if (transferError instanceof PluginError) return transferError;
  if (callerSignal?.aborted) return new PluginError("Request cancelled", { kind: "cancelled" });
  const reason = transferError?.name === "TimeoutError" ? "request timed out" : String(transferError?.cause?.message ?? transferError?.message ?? transferError);
  return new PluginError(`Network error: ${reason}`, { kind: "network_error", retryable: true });
}

// Stops reading (cancelling the download) as soon as the body passes `maxBytes`.
async function readBodyWithLimit(response, maxBytes, callerSignal) {
  const chunks = [];
  let totalBytes = 0;
  try {
    for await (const chunk of response.body ?? []) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) throw invalidImage("image is larger than 10 MB");
      chunks.push(chunk);
    }
  } catch (readError) {
    throw classifyTransferError(readError, callerSignal);
  }
  return Buffer.concat(chunks);
}

function invalidImage(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
