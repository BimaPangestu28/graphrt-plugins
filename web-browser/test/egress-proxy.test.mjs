import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHostGuard } from "../lib/address-policy.mjs";
import { BLOCKED_HEADER, createPinnedLookup, parseConnectTarget, startEgressProxy } from "../lib/egress-proxy.mjs";
import { htmlRoute, startLocalServer } from "./local-server.mjs";

// "public.test" only exists in this fake DNS: reaching the server through it proves the proxy
// connects to the address the guard checked instead of resolving the name again.
function createTestGuard() {
  return createHostGuard({
    allowedTestHosts: ["public.test"],
    resolveHostAddresses: async (hostname) => {
      if (hostname === "public.test") return ["127.0.0.1"];
      if (hostname === "internal.test") return ["10.0.0.7"];
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    },
  });
}

function buildProxyAuthorization({ username, password }) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

// `proxy` is the started proxy (its credentials are sent) or `{url}` alone (none are sent).
function requestThroughProxy(proxy, targetUrl, extraHeaders = {}) {
  const proxyAddress = new URL(proxy.url);
  const authorization = proxy.credentials ? { "proxy-authorization": buildProxyAuthorization(proxy.credentials) } : {};
  return new Promise((resolve, reject) => {
    const headers = { host: new URL(targetUrl).host, ...authorization, ...extraHeaders };
    const request = http.request({ host: proxyAddress.hostname, port: proxyAddress.port, path: targetUrl, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

function connectThroughProxy(proxy, target) {
  const proxyAddress = new URL(proxy.url);
  const headers = proxy.credentials ? { "proxy-authorization": buildProxyAuthorization(proxy.credentials) } : {};
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxyAddress.hostname, port: proxyAddress.port, method: "CONNECT", path: target, headers });
    request.on("connect", (response, socket) => resolve({ status: response.statusCode, headers: response.headers, socket }));
    request.on("error", reject);
    request.end();
  });
}

async function withProxyAndServer(routes, proxyOptions, runChecks) {
  const server = await startLocalServer(routes);
  const proxy = await startEgressProxy({ hostGuard: createTestGuard(), maxResponseBytes: 1024 * 1024, ...proxyOptions });
  try {
    await runChecks({ server, proxy });
  } finally {
    await proxy.close();
    await server.close();
  }
}

test("plain http requests are forwarded to the pinned, checked address", async () => {
  await withProxyAndServer({ "/page": htmlRoute("<p>hello</p>") }, {}, async ({ server, proxy }) => {
    const response = await requestThroughProxy(proxy, `http://public.test:${server.port}/page`);
    assert.equal(response.status, 200);
    assert.equal(response.body, "<p>hello</p>");
    assert.equal(proxy.stats().bytesReceived > 0, true);
  });
});

test("requests to internal hosts get 403 with the blocked header and are recorded", async () => {
  await withProxyAndServer({}, {}, async ({ server, proxy }) => {
    for (const target of [`http://127.0.0.1:${server.port}/`, `http://localhost:${server.port}/`, "http://internal.test/", "http://169.254.169.254/latest/meta-data/"]) {
      const response = await requestThroughProxy(proxy, target);
      assert.equal(response.status, 403, target);
      assert.equal(response.headers[BLOCKED_HEADER], "1");
    }
    assert.equal(server.hits.length, 0);
    assert.deepEqual([...proxy.stats().blockedHosts].sort(), ["127.0.0.1", "169.254.169.254", "internal.test", "localhost"]);
    assert.equal(proxy.stats().blocked.length, 4);
  });
});

test("CONNECT tunnels reach public hosts and refuse internal ones", async () => {
  await withProxyAndServer({ "/tunnel": htmlRoute("tunnelled") }, {}, async ({ server, proxy }) => {
    const refused = await connectThroughProxy(proxy, `127.0.0.1:${server.port}`);
    assert.equal(refused.status, 403);
    refused.socket.destroy();
    const tunnel = await connectThroughProxy(proxy, `public.test:${server.port}`);
    assert.equal(tunnel.status, 200);
    // A TLS handshake record (0x16 0x03) is forwarded; the plain-http test server answers 400.
    tunnel.socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x00, 0x0d, 0x0a, 0x0d, 0x0a]));
    const reply = await readUntilEnd(tunnel.socket);
    assert.match(reply, /^HTTP\/1.1 400/);
    assert.equal(server.connectionCount(), 1);
  });
});

test("a CONNECT tunnel may carry plain http without an upgrade (Playwright's own fetcher does this)", async () => {
  await withProxyAndServer({ "/tunnel": htmlRoute("tunnelled") }, {}, async ({ server, proxy }) => {
    const tunnel = await connectThroughProxy(proxy, `public.test:${server.port}`);
    tunnel.socket.write("GET /tunnel HTTP/1.1\r\nHost: public.test\r\n");
    tunnel.socket.write("Connection: close\r\n\r\n");
    const reply = await readUntilEnd(tunnel.socket);
    assert.match(reply, /^HTTP\/1.1 200[^]*tunnelled/);
    assert.deepEqual(server.hits, ["/tunnel"]);
  });
});

test("the download budget cuts connections and refuses new ones", async () => {
  const routes = { "/big": (request, response) => response.end("x".repeat(200000)), "/small": htmlRoute("ok") };
  await withProxyAndServer(routes, { maxResponseBytes: 50000 }, async ({ server, proxy }) => {
    const bigOutcome = await requestThroughProxy(proxy, `http://public.test:${server.port}/big`).catch((error) => error);
    assert.ok(bigOutcome instanceof Error || bigOutcome.body.length < 200000, "the big body is cut short");
    assert.equal(proxy.stats().budgetExceeded, true);
    const next = await requestThroughProxy(proxy, `http://public.test:${server.port}/small`);
    assert.equal(next.status, 403);
  });
});

test("a CONNECT tunnel carrying plaintext (a ws:// WebSocket handshake) is cut before it reaches the server", async () => {
  await withProxyAndServer({}, {}, async ({ server, proxy }) => {
    const tunnel = await connectThroughProxy(proxy, `public.test:${server.port}`);
    tunnel.socket.write(`GET /ws HTTP/1.1\r\nHost: public.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    await readUntilEnd(tunnel.socket);
    assert.equal(server.connectionCount(), 0);
    assert.deepEqual(server.upgrades, []);
    assert.match(JSON.stringify(proxy.stats().blocked), /WebSocket/);
    const garbage = await connectThroughProxy(proxy, `public.test:${server.port}`);
    garbage.socket.write("x".repeat(20000));
    await readUntilEnd(garbage.socket);
    assert.equal(server.connectionCount(), 0, "plaintext that is not an http request head is refused too");
  });
});

test("the proxy only serves clients that present its per-operation credentials", async () => {
  await withProxyAndServer({ "/page": htmlRoute("<p>hello</p>") }, {}, async ({ server, proxy }) => {
    const anonymous = await requestThroughProxy({ url: proxy.url }, `http://public.test:${server.port}/page`);
    assert.equal(anonymous.status, 407);
    assert.match(anonymous.headers["proxy-authenticate"], /^Basic realm=/);
    const wrongPassword = await requestThroughProxy({ url: proxy.url, credentials: { ...proxy.credentials, password: "guess" } }, `http://public.test:${server.port}/page`);
    assert.equal(wrongPassword.status, 407);
    const anonymousTunnel = await connectThroughProxy({ url: proxy.url }, `public.test:${server.port}`);
    assert.equal(anonymousTunnel.status, 407);
    anonymousTunnel.socket.destroy();
    assert.equal(server.connectionCount(), 0);
    assert.equal((await requestThroughProxy(proxy, `http://public.test:${server.port}/page`)).status, 200);
  });
  const first = await startEgressProxy({ hostGuard: createTestGuard(), maxResponseBytes: 1 });
  const second = await startEgressProxy({ hostGuard: createTestGuard(), maxResponseBytes: 1 });
  assert.notEqual(first.credentials.password, second.credentials.password);
  assert.ok(first.credentials.password.length >= 32);
  await Promise.all([first.close(), second.close()]);
});

test("WebSocket upgrades through the proxy are refused", async () => {
  await withProxyAndServer({}, {}, async ({ server, proxy }) => {
    const proxyAddress = new URL(proxy.url);
    const status = await new Promise((resolve) => {
      const headers = { connection: "Upgrade", upgrade: "websocket", "proxy-authorization": buildProxyAuthorization(proxy.credentials) };
      const request = http.request({ host: proxyAddress.hostname, port: proxyAddress.port, path: `http://public.test:${server.port}/ws`, headers });
      request.on("response", (response) => resolve(response.statusCode));
      request.on("upgrade", (response) => resolve(response.statusCode));
      request.on("error", () => resolve("error"));
      request.end();
    });
    assert.notEqual(status, 101);
    assert.equal(server.hits.length, 0);
  });
});

test("parseConnectTarget accepts host:port and [v6]:port only", () => {
  assert.deepEqual(parseConnectTarget("example.com:443"), { hostname: "example.com", port: 443 });
  assert.deepEqual(parseConnectTarget("[::1]:8443"), { hostname: "::1", port: 8443 });
  assert.equal(parseConnectTarget("example.com"), null);
  assert.equal(parseConnectTarget("example.com:0"), null);
  assert.equal(parseConnectTarget("example.com:70000"), null);
  assert.equal(parseConnectTarget("user@example.com:443"), null);
});

test("createPinnedLookup always answers with the checked address", async () => {
  const lookup = createPinnedLookup("93.184.215.14");
  const single = await new Promise((resolve) => lookup("anything", {}, (error, address, family) => resolve([address, family])));
  assert.deepEqual(single, ["93.184.215.14", 4]);
  const all = await new Promise((resolve) => lookup("anything", { all: true }, (error, addresses) => resolve(addresses)));
  assert.deepEqual(all, [{ address: "93.184.215.14", family: 4 }]);
});

function readUntilEnd(socket) {
  return new Promise((resolve) => {
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => resolve(text));
    socket.on("close", () => resolve(text));
    socket.on("error", () => resolve(text));
  });
}
