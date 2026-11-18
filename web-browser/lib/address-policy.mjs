/**
 * Public-host policy: decides whether a host name or IP address may be
 * contacted, and resolves names to addresses that passed the check.
 *
 * A host is refused when it is `localhost`/`*.localhost`, or when ANY of its
 * addresses is loopback, private, link-local, CGNAT, multicast, reserved,
 * cloud metadata (169.254.169.254, fd00:ec2::254, Azure's 168.63.129.16) or an
 * IPv6 form that embeds an IPv4 address (IPv4-compatible, IPv4-mapped,
 * IPv4-translated, NAT64, 6to4, Teredo).
 *
 * The egress proxy connects to the exact address this module checked
 * (`resolvePublicAddresses`), so a DNS answer that changes between check and
 * connect (DNS rebinding) cannot redirect browser traffic to an internal host.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { cancelled, notFound, networkError, permissionDenied, timeoutError } from "./errors.mjs";

const INTERNAL_IPV4_SUBNETS = [
  ["0.0.0.0", 8], // "this network"; 0.0.0.0 reaches localhost on Linux and macOS
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["168.63.129.16", 32], // Azure wireserver / platform DNS (not in a private range)
  ["169.254.0.0", 16], // link-local, incl. the 169.254.169.254 metadata service
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3], // multicast, reserved and broadcast (224.0.0.0 - 255.255.255.255)
];
const INTERNAL_IPV6_SUBNETS = [
  ["::", 96], // unspecified, loopback and deprecated IPv4-compatible (::a.b.c.d)
  ["::ffff:0:0", 96], // IPv4-mapped
  ["::ffff:0:0:0", 96], // IPv4-translated (SIIT)
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo (embeds an IPv4 address)
  ["2001:20::", 28], // ORCHIDv2 (not routable)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an IPv4 address)
  ["fc00::", 7], // unique local, incl. the fd00:ec2::254 metadata service
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
];
const INTERNAL_ADDRESSES = { ipv4: buildBlockList(INTERNAL_IPV4_SUBNETS, "ipv4"), ipv6: buildBlockList(INTERNAL_IPV6_SUBNETS, "ipv6") };
const DEFAULT_CACHE_TTL_MS = 30000;
const MAX_CACHE_ENTRIES = 256;
const DNS_NOT_FOUND_CODES = new Set(["ENOTFOUND", "ENODATA", "EAI_NONAME", "EAI_NODATA"]);

/**
 * Tells whether an IP address is internal (not reachable on the public internet).
 *
 * @param address - IPv4 or IPv6 address without brackets (string)
 * @returns true for internal or unparsable addresses (boolean)
 *
 * @example
 * isInternalAddress("169.254.169.254"); // true
 * isInternalAddress("::ffff:127.0.0.1"); // true
 * isInternalAddress("93.184.215.14"); // false
 */
export function isInternalAddress(address) {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 6 ? INTERNAL_ADDRESSES.ipv6.check(address, "ipv6") : INTERNAL_ADDRESSES.ipv4.check(address, "ipv4");
}

/**
 * Normalises a URL host name: lower case, no IPv6 brackets, no trailing dot.
 *
 * @param hostname - Host from a URL or a CONNECT line (string)
 * @returns Normalised host name (string)
 */
export function normalizeHostname(hostname) {
  return String(hostname).trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/**
 * Creates the host guard shared by URL checks, the request guard, the egress proxy and robots fetches.
 *
 * @param options - Guard options (object, all optional)
 * @param options.resolveHostAddresses - `async (hostname) => string[]`; DNS by default (function)
 * @param options.allowedTestHosts - Hosts that skip the internal-address check. TESTS ONLY: never read from env (string[])
 * @param options.cacheTtlMs - How long a checked answer is reused (number, default 30000)
 * @param options.now - Clock for the cache (() => number)
 * @returns `{resolvePublicAddresses(hostname, {signal}), assertPublicHost(hostname, {signal})}`; an aborted
 *   `signal` stops waiting for DNS with `cancelled` (or `timeout` for a deadline) (object)
 */
export function createHostGuard({ resolveHostAddresses = resolveWithDns, allowedTestHosts = [], cacheTtlMs = DEFAULT_CACHE_TTL_MS, now = Date.now } = {}) {
  const testHosts = new Set(allowedTestHosts.map(normalizeHostname));
  const answerCache = new Map();
  const resolvePublicAddresses = async (rawHostname, { signal } = {}) => {
    const hostname = normalizeHostname(rawHostname);
    const cachedAnswer = answerCache.get(hostname);
    if (cachedAnswer && cachedAnswer.expiresAt > now()) return cachedAnswer.addresses;
    const resolution = resolveAndCheck(hostname, { resolveHostAddresses, isTestHost: testHosts.has(hostname) });
    const addresses = await raceWithAbort(resolution, signal);
    rememberAnswer(answerCache, hostname, { addresses, expiresAt: now() + cacheTtlMs });
    return addresses;
  };
  return {
    resolvePublicAddresses,
    /** Throws unless every address of `hostname` is public (see module docs). */
    assertPublicHost: async (hostname, options) => {
      await resolvePublicAddresses(hostname, options);
    },
  };
}

// getaddrinfo cannot be cancelled, but the operation can stop waiting for it.
function raceWithAbort(resolution, signal) {
  if (!signal) return resolution;
  resolution.catch(() => {});
  const describeAbort = () => (signal.reason?.name === "TimeoutError" ? timeoutError("Resolving the host did not finish within the operation's time limit") : cancelled());
  if (signal.aborted) return Promise.reject(describeAbort());
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(describeAbort());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([resolution, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

async function resolveAndCheck(hostname, { resolveHostAddresses, isTestHost }) {
  if (!hostname) throw permissionDenied("The URL has no host name");
  if (!isTestHost && (hostname === "localhost" || hostname.endsWith(".localhost"))) throw refuseHost(hostname);
  const addresses = isIP(hostname) ? [hostname] : await lookupHost(hostname, resolveHostAddresses);
  if (addresses.length === 0) throw notFound(`Host ${hostname} has no addresses`);
  if (!isTestHost && addresses.some(isInternalAddress)) throw refuseHost(hostname);
  return addresses;
}

async function lookupHost(hostname, resolveHostAddresses) {
  try {
    return await resolveHostAddresses(hostname);
  } catch (lookupError) {
    if (DNS_NOT_FOUND_CODES.has(lookupError?.code)) throw notFound(`Host ${hostname} does not resolve (DNS: ${lookupError.code})`);
    throw networkError(`Resolving host ${hostname} failed: ${lookupError?.code ?? lookupError?.message ?? lookupError}`);
  }
}

function refuseHost(hostname) {
  return permissionDenied(
    `Host ${hostname} is a loopback, private, link-local or otherwise internal address; web-browser only visits public hosts`,
  );
}

function rememberAnswer(answerCache, hostname, answer) {
  answerCache.delete(hostname);
  answerCache.set(hostname, answer);
  if (answerCache.size > MAX_CACHE_ENTRIES) answerCache.delete(answerCache.keys().next().value);
}

function buildBlockList(subnets, family) {
  const blockList = new BlockList();
  for (const [network, prefix] of subnets) blockList.addSubnet(network, prefix, family);
  return blockList;
}

async function resolveWithDns(hostname) {
  const lookupResults = await lookup(hostname, { all: true, verbatim: true });
  return lookupResults.map((lookupResult) => lookupResult.address);
}
