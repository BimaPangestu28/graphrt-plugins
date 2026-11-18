/**
 * Binary transfers for `upload_image`: download an image from a public https
 * URL (no credentials) and PUT its bytes to the LinkedIn upload URL.
 *
 * The upload URL is on a different LinkedIn host than the REST API, so the
 * shared client (which only allows its own origin) cannot be used. The Bearer
 * token is sent only when that host is https and ends with `.linkedin.com`.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 60000;
const UPLOAD_STATUS_KINDS = { 400: "invalid_input", 401: "auth_error", 403: "permission_denied", 404: "not_found", 429: "rate_limited" };

/**
 * Downloads an image, enforcing https, an image/* content type and a 10 MB limit.
 *
 * @param options - `{fetchImpl, imageUrl, signal}` (object)
 * @returns `{imageBytes, contentType}` (Promise<object>)
 * @throws PluginError kind `invalid_input` - Bad URL, failed download, non-image or too large; `network_error`, `cancelled`
 */
export async function downloadImage({ fetchImpl, imageUrl, signal }) {
  requireHttpsUrl(imageUrl, "image_url");
  const imageResponse = await fetchWithTimeout(fetchImpl, imageUrl, { method: "GET", redirect: "follow" }, signal);
  if (!imageResponse.ok) throw invalidImage(`could not download image_url: HTTP ${imageResponse.status}`);
  if (imageResponse.url && !imageResponse.url.startsWith("https://")) throw invalidImage("image_url redirected to a non-https URL");
  const contentType = imageResponse.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) throw invalidImage(`image_url is not an image (content-type "${contentType}")`);
  if (Number(imageResponse.headers.get("content-length")) > MAX_IMAGE_BYTES) throw invalidImage("image is larger than 10 MB");
  const imageBytes = await readBodyWithLimit(imageResponse, MAX_IMAGE_BYTES);
  return { imageBytes, contentType };
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
  const uploadResponse = await fetchWithTimeout(fetchImpl, uploadUrl, { method: "PUT", headers, body: imageBytes }, signal);
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

function requireHttpsUrl(candidateUrl, argumentName) {
  let parsedUrl;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    throw invalidImage(`\`${argumentName}\` is not a valid URL`);
  }
  if (parsedUrl.protocol !== "https:") throw invalidImage(`\`${argumentName}\` must be an https URL`);
}

async function fetchWithTimeout(fetchImpl, url, init, callerSignal) {
  const timeoutSignal = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (fetchError) {
    if (callerSignal?.aborted) throw new PluginError("Request cancelled", { kind: "cancelled" });
    const reason = fetchError?.name === "TimeoutError" ? "request timed out" : String(fetchError?.cause?.message ?? fetchError?.message ?? fetchError);
    throw new PluginError(`Network error: ${reason}`, { kind: "network_error", retryable: true });
  }
}

async function readBodyWithLimit(response, maxBytes) {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) throw invalidImage("image is larger than 10 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function invalidImage(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
