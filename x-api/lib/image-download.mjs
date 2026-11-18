/**
 * Downloads an image from a public URL for upload_media.
 *
 * The download never carries credentials (it does not use the API client),
 * stops reading past the size limit and only accepts image/* content.
 *
 * Redirects are followed by hand (at most MAX_REDIRECTS), and every hop must
 * be https on a public host: host names are resolved first and refused when
 * any address is loopback, private, link-local or otherwise internal. fetch
 * resolves the name again, so a DNS server that changes its answer in
 * between (rebinding) is not covered by this check.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { rejectInput } from "./client.mjs";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const INTERNAL_ADDRESSES = buildInternalAddressList();

/**
 * Fetches an image and returns it as a Blob.
 *
 * @param imageUrl - https URL of the image (string)
 * @param options - Download options (object)
 * @param options.fetchImpl - fetch implementation (function)
 * @param options.resolveHostAddresses - `async (hostname) => string[]` IP addresses; DNS by default (function, optional)
 * @param options.signal - Cancellation signal (AbortSignal, optional)
 * @returns Image Blob with its content type (Promise<Blob>)
 * @throws PluginError kinds `invalid_input` (bad URL, internal host, HTTP error, not an image, over 5 MB), `network_error`, `cancelled`
 *
 * @example
 * const imageBlob = await downloadImage("https://example.com/a.png", { fetchImpl: fetch, signal });
 */
export async function downloadImage(imageUrl, { fetchImpl, resolveHostAddresses = resolveWithDns, signal }) {
  checkImageUrl(imageUrl);
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const downloadSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchFollowingRedirects(imageUrl, { fetchImpl, resolveHostAddresses, signal: downloadSignal, callerSignal: signal });
  if (!response.ok) rejectInput(`Could not download \`image_url\`: HTTP ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) rejectInput(`\`image_url\` is not an image (content-type "${contentType || "none"}")`);
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) rejectSize();
  try {
    return new Blob([await readLimitedBytes(response)], { type: contentType });
  } catch (readError) {
    throw readError instanceof PluginError ? readError : classifyDownloadError(readError, signal);
  }
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

// Every hop is checked before it is requested, so a redirect cannot lead to http or an internal host.
async function fetchFollowingRedirects(imageUrl, { fetchImpl, resolveHostAddresses, signal, callerSignal }) {
  let currentUrl = imageUrl;
  for (let hopCount = 0; hopCount <= MAX_REDIRECTS; hopCount += 1) {
    await assertPublicHttpsUrl(currentUrl, { originalUrl: imageUrl, resolveHostAddresses, callerSignal });
    const response = await fetchImpl(currentUrl, { method: "GET", redirect: "manual", signal }).catch((fetchError) => {
      throw classifyDownloadError(fetchError, callerSignal);
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel?.().catch(() => {});
    const location = response.headers.get("location");
    if (!location) rejectInput(`\`image_url\` answered HTTP ${response.status} without a Location`);
    currentUrl = new URL(location, currentUrl).href;
  }
  rejectInput(`\`image_url\` redirected more than ${MAX_REDIRECTS} times`);
}

async function assertPublicHttpsUrl(candidateUrl, { originalUrl, resolveHostAddresses, callerSignal }) {
  const parsedUrl = new URL(candidateUrl);
  const hop = candidateUrl === originalUrl ? "" : ` (redirected to ${candidateUrl})`;
  if (parsedUrl.protocol !== "https:") rejectInput(`\`image_url\` must stay on https${hop}`);
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const refuse = () => rejectInput(`\`image_url\` points to a loopback, private or link-local host${hop}; only public hosts are allowed`);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) refuse();
  const addresses = isIP(hostname)
    ? [hostname]
    : await resolveHostAddresses(hostname).catch((lookupError) => {
        throw classifyDownloadError(lookupError, callerSignal);
      });
  if (addresses.length === 0 || addresses.some(isInternalAddress)) refuse();
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

async function resolveWithDns(hostname) {
  const lookupResults = await lookup(hostname, { all: true, verbatim: true });
  return lookupResults.map((lookupResult) => lookupResult.address);
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

function classifyDownloadError(downloadError, callerSignal) {
  if (callerSignal?.aborted) return new PluginError("Download cancelled", { kind: "cancelled" });
  const reason = downloadError?.name === "TimeoutError" ? "timed out" : String(downloadError?.cause?.message ?? downloadError?.message ?? downloadError);
  return new PluginError(`Could not download \`image_url\`: ${reason}`, { kind: "network_error" });
}

function rejectSize() {
  rejectInput(`The image is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
}
