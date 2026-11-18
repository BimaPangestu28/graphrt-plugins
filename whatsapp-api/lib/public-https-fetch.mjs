/**
 * Fetches a caller-supplied URL without letting it reach internal services.
 *
 * Redirects are followed by hand (at most MAX_REDIRECTS), and every hop must be
 * https on a public host. Host names are resolved first and refused when any
 * address is loopback, private, link-local or otherwise internal. fetch
 * resolves the name again, so a DNS server that changes its answer in between
 * (rebinding) is not covered by this check.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const INTERNAL_ADDRESSES = buildInternalAddressList();

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
