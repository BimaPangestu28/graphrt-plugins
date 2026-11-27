/**
 * Fetches and downloads caller-supplied URLs without letting them reach internal services.
 *
 * Redirects are followed by hand (at most MAX_REDIRECTS), and every hop must be
 * https on a public host. Host names are resolved first and refused when any
 * address is loopback, private, link-local or otherwise internal. fetch
 * resolves the name again, so a DNS server that changes its answer in between
 * (rebinding) is not covered by this check.
 *
 * Used by plugins that download media (linkedin-api, whatsapp-api) and by the
 * declarative REST layer's `download.saveTo` (rest-plugin.mjs). No credentials
 * are ever sent with these requests.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PluginError } from "./graphrt-plugin.mjs";

export const MAX_REDIRECTS = 5;
/** Default size cap for downloadPublicHttpsToFile. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** Default time limit for one whole download, redirects included. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const INTERNAL_ADDRESSES = buildInternalAddressList();
const SAFE_FILE_BASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
export const EXTENSIONS_BY_MEDIA_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "audio/aac": ".aac",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "text/plain": ".txt",
};

/**
 * GETs a public https URL, checking every redirect hop before requesting it.
 *
 * @param url - URL to fetch (string)
 * @param options.fetchImpl - fetch implementation (function)
 * @param options.resolveHostAddresses - `async (hostname) => string[]`; DNS by default (function, optional)
 * @param options.signal - Signal for the requests, e.g. a timeout combined with the caller's (AbortSignal)
 * @param options.label - What the URL is, for messages, e.g. "image_url" (string)
 * @returns The final non-redirect Response (Promise<Response>)
 * @throws PluginError kind `invalid_input` (not https, internal host, bad redirect); transport errors are rethrown as-is
 */
export async function fetchPublicHttps(url, { fetchImpl, resolveHostAddresses = resolveWithDns, signal, label }) {
  let currentUrl = url;
  for (let hopCount = 0; hopCount <= MAX_REDIRECTS; hopCount += 1) {
    await assertPublicHttpsUrl(currentUrl, { originalUrl: url, resolveHostAddresses, label });
    const response = await fetchImpl(currentUrl, { method: "GET", redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel?.().catch(() => {});
    const location = response.headers?.get?.("location");
    if (!location) throw invalidInput(`\`${label}\` ${url} answered HTTP ${response.status} without a Location`);
    currentUrl = new URL(location, currentUrl).href;
  }
  throw invalidInput(`\`${label}\` ${url} redirected more than ${MAX_REDIRECTS} times`);
}

/**
 * POSTs to a public https URL (a webhook): the host is checked like {@link fetchPublicHttps}, and redirects are
 * refused (a POST body must not follow a redirect to another host).
 *
 * @param url - URL to post to (string)
 * @param options.body - Request body (string)
 * @param options.headers - Request headers (object)
 * @param options.fetchImpl - fetch implementation (function)
 * @param options.resolveHostAddresses - `async (hostname) => string[]`; DNS by default (function, optional)
 * @param options.signal - Signal for the request (AbortSignal, optional)
 * @param options.label - What the URL is, for messages, e.g. "webhook_url" (string)
 * @returns The Response (Promise<Response>)
 * @throws PluginError kind `invalid_input` (not https, internal host, a redirect); transport errors are rethrown as-is
 */
export async function postPublicHttps(url, { body, headers, fetchImpl, resolveHostAddresses = resolveWithDns, signal, label }) {
  await assertPublicHttpsUrl(url, { originalUrl: url, resolveHostAddresses, label });
  const response = await fetchImpl(url, { method: "POST", body, headers, redirect: "manual", signal });
  if (REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel?.().catch(() => {});
    throw invalidInput(`\`${label}\` answered HTTP ${response.status} (a redirect); give the final address`);
  }
  return response;
}

/**
 * Downloads a public https URL into `directory`, streaming the body with a size cap. The file is written as
 * `<name>.part` and renamed when complete, so a failed download leaves nothing behind.
 *
 * @param url - URL to download (string)
 * @param options - Download options (object)
 * @param options.directory - Target directory, created when missing (string)
 * @param options.fileBaseName - File name without extension; letters, digits, ".", "_" and "-" only (string)
 * @param options.fetchImpl - fetch implementation (function, default globalThis.fetch)
 * @param options.resolveHostAddresses - DNS resolver, for tests (function, optional)
 * @param options.signal - Caller's cancellation signal (AbortSignal, optional)
 * @param options.maxBytes - Size cap (number, default DEFAULT_MAX_DOWNLOAD_BYTES)
 * @param options.timeoutMs - Time limit for the whole download (number, default DEFAULT_DOWNLOAD_TIMEOUT_MS)
 * @param options.label - What the URL is, for messages (string, default "url")
 * @returns `{url, path, bytes, content_type}` (Promise<object>)
 * @throws PluginError kinds `invalid_input` (unsafe URL or name, too large), `api_error` (HTTP failure),
 *   `network_error` (retryable), `cancelled`
 *
 * @example
 * const savedFile = await downloadPublicHttpsToFile(imageUrl, { directory: "/tmp/out", fileBaseName: "image-1" });
 * // { url, path: "/tmp/out/image-1.png", bytes: 52311, content_type: "image/png" }
 */
export async function downloadPublicHttpsToFile(url, options) {
  const { directory, fileBaseName, signal, label = "url", maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES } = options;
  assertSafeFileBaseName(fileBaseName);
  const fetchImpl = options.fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments));
  const transferSignal = combineWithTimeout(signal, options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchPublicHttps(url, { fetchImpl, resolveHostAddresses: options.resolveHostAddresses, signal: transferSignal, label });
    assertDownloadable(response, { url, label, maxBytes });
    return { url, ...(await saveResponseToFile(response, { directory, fileBaseName, maxBytes, label, url })) };
  } catch (downloadError) {
    throw classifyTransferError(downloadError, signal);
  }
}

/**
 * Downloads a public https URL into memory with a size cap (for uploads that need the bytes, e.g. multipart).
 *
 * @param url - URL to fetch (string)
 * @param options - `{fetchImpl, resolveHostAddresses?, signal?, maxBytes, timeoutMs?, label?}` (object)
 * @returns `{bytes, contentType, fileName}` (Promise<object>)
 * @throws PluginError kinds `invalid_input` (unsafe URL, too large), `api_error` (HTTP failure), `network_error`, `cancelled`
 */
export async function fetchPublicHttpsBytes(url, options) {
  const { signal, label = "url", maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES } = options;
  const fetchImpl = options.fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments));
  const transferSignal = combineWithTimeout(signal, options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchPublicHttps(url, { fetchImpl, resolveHostAddresses: options.resolveHostAddresses, signal: transferSignal, label });
    assertDownloadable(response, { url, label, maxBytes });
    const bytes = await readBodyWithLimit(response, maxBytes, label);
    const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
    return { bytes, contentType: readMediaType(response), fileName };
  } catch (downloadError) {
    throw classifyTransferError(downloadError, signal);
  }
}

/**
 * Streams a Response body into `<directory>/<fileBaseName><ext>` with a size cap; the extension comes from the
 * content type, then the URL. Written as `.part` and renamed, so a failure leaves nothing behind.
 *
 * @param response - Successful Response (Response)
 * @param options - `{directory, fileBaseName, maxBytes, label, url?}` (object)
 * @returns `{path, bytes, content_type}` (Promise<object>)
 * @throws PluginError kind `invalid_input` - Unsafe name or too large; stream errors are rethrown as-is
 */
export async function saveResponseToFile(response, { directory, fileBaseName, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES, label = "response", url }) {
  assertSafeFileBaseName(fileBaseName);
  if (Number(response.headers.get("content-length")) > maxBytes) throw tooLarge(label, maxBytes);
  const contentType = readMediaType(response);
  const filePath = join(directory, `${fileBaseName}${chooseExtension(contentType, url)}`);
  const bytes = await writeBodyToFile(response, { directory, filePath, maxBytes, label });
  return { path: filePath, bytes, content_type: contentType };
}

async function readBodyWithLimit(response, maxBytes, label) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body ?? []) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      await response.body.cancel?.().catch(() => {});
      throw tooLarge(label, maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function assertSafeFileBaseName(fileBaseName) {
  if (typeof fileBaseName !== "string" || !SAFE_FILE_BASE_NAME.test(fileBaseName) || fileBaseName.includes("..")) {
    throw invalidInput(`Unsafe download file name ${JSON.stringify(fileBaseName)}`);
  }
}

function combineWithTimeout(callerSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

function assertDownloadable(response, { url, label, maxBytes }) {
  if (!response.ok) {
    throw new PluginError(`Could not download \`${label}\` ${url}: HTTP ${response.status}`, { kind: "api_error" });
  }
  if (Number(response.headers.get("content-length")) > maxBytes) throw tooLarge(label, maxBytes);
}

function readMediaType(response) {
  return (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

function chooseExtension(contentType, url) {
  if (EXTENSIONS_BY_MEDIA_TYPE[contentType]) return EXTENSIONS_BY_MEDIA_TYPE[contentType];
  const urlExtension = url ? /\.([A-Za-z0-9]{1,5})$/.exec(new URL(url).pathname)?.[1] : undefined;
  return urlExtension ? `.${urlExtension.toLowerCase()}` : ".bin";
}

async function writeBodyToFile(response, { directory, filePath, maxBytes, label }) {
  await mkdir(directory, { recursive: true });
  const partialPath = `${filePath}.part`;
  let totalBytes = 0;
  const sizeLimit = new Transform({
    transform(chunk, encoding, callback) {
      totalBytes += chunk.byteLength;
      callback(totalBytes > maxBytes ? tooLarge(label, maxBytes) : null, chunk);
    },
  });
  try {
    const bodyStream = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
    await pipeline(bodyStream, sizeLimit, createWriteStream(partialPath, { flags: "wx" }));
    await rename(partialPath, filePath);
    return totalBytes;
  } catch (writeError) {
    await rm(partialPath, { force: true });
    throw writeError;
  }
}

function tooLarge(label, maxBytes) {
  return invalidInput(`\`${label}\` is larger than the ${maxBytes} bytes limit`);
}

/**
 * Turns a transfer failure into a PluginError: policy errors pass through, a caller abort is `cancelled`, anything
 * else is a retryable `network_error`.
 *
 * @param transferError - Thrown value (any)
 * @param callerSignal - The caller's signal (AbortSignal, optional)
 * @returns PluginError (PluginError)
 */
export function classifyTransferError(transferError, callerSignal) {
  if (transferError instanceof PluginError) return transferError;
  if (callerSignal?.aborted) return new PluginError("Download cancelled", { kind: "cancelled" });
  const isTimeout = transferError?.name === "TimeoutError";
  const reason = isTimeout ? "download timed out" : String(transferError?.cause?.message ?? transferError?.message ?? transferError);
  return new PluginError(`Network error: ${reason}`, { kind: "network_error", retryable: true });
}

async function assertPublicHttpsUrl(candidateUrl, { originalUrl, resolveHostAddresses, label }) {
  let parsedUrl;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    throw invalidInput(`\`${label}\` is not a valid URL`);
  }
  const hop = candidateUrl === originalUrl ? "" : ` (redirected to ${candidateUrl})`;
  if (parsedUrl.protocol !== "https:") throw invalidInput(`\`${label}\` must be an https URL and stay on https${hop}`);
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const refuse = () => invalidInput(`\`${label}\` ${originalUrl} points to a loopback, private or link-local host${hop}; only public hosts are allowed`);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw refuse();
  const addresses = isIP(hostname) ? [hostname] : await resolveHostAddresses(hostname);
  if (addresses.length === 0 || addresses.some(isInternalAddress)) throw refuse();
}

function isInternalAddress(address) {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 6 ? INTERNAL_ADDRESSES.ipv6.check(address, "ipv6") : INTERNAL_ADDRESSES.ipv4.check(address, "ipv4");
}

// One list per family: a BlockList also matches IPv4 input against IPv4-mapped IPv6 rules.
function buildInternalAddressList() {
  const ipv4Subnets = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]];
  // Includes all IPv4-mapped and NAT64 addresses, which could otherwise smuggle an internal IPv4 address.
  const ipv6Subnets = [["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]];
  const buildList = (subnets, family) => {
    const blockList = new BlockList();
    for (const [network, prefix] of subnets) blockList.addSubnet(network, prefix, family);
    return blockList;
  };
  return { ipv4: buildList(ipv4Subnets, "ipv4"), ipv6: buildList(ipv6Subnets, "ipv6") };
}

/**
 * Resolves a host name to all of its addresses with the system resolver.
 *
 * @param hostname - Host name (string)
 * @returns IP addresses (Promise<string[]>)
 */
export async function resolveWithDns(hostname) {
  const lookupResults = await lookup(hostname, { all: true, verbatim: true });
  return lookupResults.map((lookupResult) => lookupResult.address);
}

function invalidInput(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
