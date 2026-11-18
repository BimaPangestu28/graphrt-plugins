import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostGuard, isInternalAddress, normalizeHostname } from "../lib/address-policy.mjs";
import { createFakeResolver } from "./helpers.mjs";

const INTERNAL_ADDRESSES = [
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback range"],
  ["0.0.0.0", "unspecified"],
  ["10.0.0.1", "private 10/8"],
  ["172.16.5.4", "private 172.16/12"],
  ["172.31.255.255", "private 172.16/12 end"],
  ["192.168.1.1", "private 192.168/16"],
  ["169.254.169.254", "cloud metadata (link-local)"],
  ["100.64.0.1", "CGNAT"],
  ["100.127.255.255", "CGNAT end"],
  ["224.0.0.1", "multicast"],
  ["239.255.255.250", "SSDP multicast"],
  ["255.255.255.255", "broadcast"],
  ["198.18.0.1", "benchmarking"],
  ["192.0.0.170", "IETF protocol assignments"],
  ["::1", "IPv6 loopback"],
  ["::", "IPv6 unspecified"],
  ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
  ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
  ["::ffff:10.0.0.1", "IPv4-mapped private"],
  ["64:ff9b::7f00:1", "NAT64 of 127.0.0.1"],
  ["64:ff9b::a9fe:a9fe", "NAT64 of 169.254.169.254"],
  ["2002:7f00:1::1", "6to4 of 127.0.0.1"],
  ["2001:0:4136:e378::1", "Teredo"],
  ["fd00:ec2::254", "AWS IPv6 metadata"],
  ["fc00::1", "unique local"],
  ["fe80::1", "link-local"],
  ["ff02::1", "IPv6 multicast"],
  ["not-an-ip", "unparsable"],
  ["::7f00:1", "IPv4-compatible ::127.0.0.1 (deprecated ::/96)"],
  ["::a9fe:a9fe", "IPv4-compatible metadata"],
  ["::ffff:0:7f00:1", "IPv4-translated ::ffff:0:0:0/96"],
  ["::ffff:0:a00:1", "IPv4-translated private"],
  ["2001:20::1", "ORCHIDv2 2001:20::/28"],
  ["2001:2f:ffff::1", "ORCHIDv2 end"],
  ["168.63.129.16", "Azure wireserver / DNS"],
];

for (const [address, label] of INTERNAL_ADDRESSES) {
  test(`isInternalAddress refuses ${label} (${address})`, () => {
    assert.equal(isInternalAddress(address), true);
  });
}

for (const address of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) {
  test(`isInternalAddress allows public ${address}`, () => {
    assert.equal(isInternalAddress(address), false);
  });
}

test("normalizeHostname lower-cases and strips brackets and the trailing dot", () => {
  assert.equal(normalizeHostname("[::1]"), "::1");
  assert.equal(normalizeHostname("LocalHost."), "localhost");
});

test("assertPublicHost allows a name whose addresses are all public", async () => {
  const guard = createHostGuard({ resolveHostAddresses: createFakeResolver() });
  await guard.assertPublicHost("dual.example");
  assert.deepEqual(await guard.resolvePublicAddresses("example.com"), ["93.184.215.14"]);
});

const REFUSED_HOSTS = ["localhost", "LOCALHOST.", "app.localhost", "127.0.0.1", "::1", "internal.example", "mixed.example", "metadata.example", "mapped.example", "169.254.169.254", "fd00:ec2::254"];

for (const hostname of REFUSED_HOSTS) {
  test(`assertPublicHost refuses ${hostname} with permission_denied`, async () => {
    const guard = createHostGuard({ resolveHostAddresses: createFakeResolver() });
    await assert.rejects(guard.assertPublicHost(hostname), { kind: "permission_denied" });
  });
}

test("a name that does not resolve is not_found; other DNS failures are retryable network errors", async () => {
  const guard = createHostGuard({ resolveHostAddresses: createFakeResolver() });
  await assert.rejects(guard.assertPublicHost("nope.example"), { kind: "not_found" });
  const failingGuard = createHostGuard({ resolveHostAddresses: async () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })) });
  await assert.rejects(failingGuard.assertPublicHost("slow.example"), { kind: "network_error", retryable: true });
});

test("a name with no addresses is refused", async () => {
  const guard = createHostGuard({ resolveHostAddresses: async () => [] });
  await assert.rejects(guard.assertPublicHost("empty.example"), { kind: "not_found" });
});

test("allowedTestHosts (tests only) exempts exactly the listed hosts", async () => {
  const guard = createHostGuard({ resolveHostAddresses: createFakeResolver(), allowedTestHosts: ["127.0.0.1"] });
  assert.deepEqual(await guard.resolvePublicAddresses("127.0.0.1"), ["127.0.0.1"]);
  await assert.rejects(guard.assertPublicHost("localhost"), { kind: "permission_denied" });
  await assert.rejects(guard.assertPublicHost("127.0.0.2"), { kind: "permission_denied" });
});

test("answers are cached for the TTL, then resolved again", async () => {
  const resolver = createFakeResolver();
  let currentTime = 1000;
  const guard = createHostGuard({ resolveHostAddresses: resolver, cacheTtlMs: 100, now: () => currentTime });
  await guard.assertPublicHost("example.com");
  await guard.assertPublicHost("EXAMPLE.com");
  assert.equal(resolver.calls.length, 1);
  currentTime += 101;
  await guard.assertPublicHost("example.com");
  assert.equal(resolver.calls.length, 2);
});

test("refusals are not cached as allowed", async () => {
  const answers = [["10.0.0.1"], ["93.184.215.14"]];
  const guard = createHostGuard({ resolveHostAddresses: async () => answers.shift() });
  await assert.rejects(guard.assertPublicHost("flip.example"), { kind: "permission_denied" });
  await guard.assertPublicHost("flip.example");
});

for (const address of ["168.63.129.17", "2001:30::1", "::1:0:0:1"]) {
  test(`isInternalAddress keeps neighbours of the added ranges public (${address})`, () => {
    assert.equal(isInternalAddress(address), false);
  });
}

test("resolvePublicAddresses stops waiting for DNS when the operation is cancelled or times out", async () => {
  const guard = createHostGuard({ resolveHostAddresses: () => new Promise(() => {}) });
  const keepAlive = setTimeout(() => {}, 5000);
  const controller = new AbortController();
  const pending = guard.assertPublicHost("hang.example", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { kind: "cancelled" });
  await assert.rejects(guard.assertPublicHost("hang.example", { signal: AbortSignal.timeout(10) }), { kind: "timeout" });
  await assert.rejects(guard.resolvePublicAddresses("hang.example", { signal: AbortSignal.abort() }), { kind: "cancelled" });
  clearTimeout(keepAlive);
});
