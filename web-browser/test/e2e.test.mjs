/**
 * End-to-end tests with a REAL headless Chromium against local servers.
 * Skipped unless WEB_BROWSER_E2E=1 (the default suite never opens a browser):
 *   WEB_BROWSER_E2E=1 node --test test/e2e.test.mjs
 *
 * 127.0.0.1 is made "public" for these tests through `allowedTestHosts`;
 * `localhost`, `[::1]` and every other internal address stay blocked, so a
 * server on `::1` serves as the internal target a page must never reach.
 */
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";
import { BUSY_PAGE, buildProbeWorkerScript, buildWebRtcPage, buildWebSocketPage, TAMPERING_PAGE } from "./hostile-pages.mjs";
import { htmlRoute, redirectRoute, startLocalServer } from "./local-server.mjs";

const isEnabled = process.env.WEB_BROWSER_E2E === "1";

const ARTICLE_HTML = `<!doctype html><html lang="en"><head><title>Test Article</title>
<meta name="description" content="A page for tests"></head><body>
<header><nav><a href="/home">Home</a> <a href="/about">About</a></nav></header>
<main><article><h1>Main Heading</h1><p>First paragraph with a <a href="/more">useful link</a> and <strong>bold</strong> words.</p>
<ul><li>Item one</li><li>Item two</li></ul><p class="price">10</p><p class="price">20</p></article></main>
<footer>Copyright footer text</footer></body></html>`;

describe("web-browser end-to-end (real Chromium)", { skip: isEnabled ? false : "set WEB_BROWSER_E2E=1 to run" }, () => {
  let site;
  let internalSite;
  let screenshotDirectory;
  let definition;
  let runOperation;

  before(async () => {
    internalSite = await startLocalServer({ "/secret": htmlRoute("<title>secret</title>") }, { host: "::1" });
    const internalUrl = (path) => `${internalSite.origin}${path}`;
    site = await startLocalServer({
      "/robots.txt": (request, response) => response.end("User-agent: *\nDisallow: /private\n"),
      "/article": htmlRoute(ARTICLE_HTML),
      "/private": htmlRoute("<title>private</title>"),
      "/to-private": redirectRoute((server) => `${server.origin}/private`),
      "/hop1": redirectRoute("/hop2", 301),
      "/hop2": redirectRoute((server) => `${server.origin}/article`),
      "/to-internal": redirectRoute(internalUrl("/secret")),
      "/to-localhost": redirectRoute(`http://localhost:${internalSite.port}/secret`),
      "/leaky": htmlRoute(`<title>Leaky</title><p>Visible text for the leaky page.</p>
        <img src="${internalUrl("/secret?img")}"><script>fetch(${JSON.stringify(internalUrl("/secret?fetch"))}).catch(() => {});
        try { new WebSocket(${JSON.stringify(`ws://[::1]:${internalSite.port}/ws`)}); } catch (error) {}</script>`),
      "/download": (request, response) => {
        response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=x.bin" });
        response.end(Buffer.alloc(1024));
      },
      "/huge": htmlRoute("<title>Huge</title><script src=\"/huge.js\"></script><p>Huge page</p>"),
      "/huge.js": (request, response) => {
        response.writeHead(200, { "content-type": "application/javascript" });
        response.end(`/*${"x".repeat(3 * 1024 * 1024)}*/`);
      },
    });
    screenshotDirectory = await mkdtemp(join(tmpdir(), "web-browser-e2e-"));
    definition = createPluginDefinition({ allowedTestHosts: ["127.0.0.1"] });
    const environment = { WEB_BROWSER_SCREENSHOT_DIR: screenshotDirectory, WEB_BROWSER_MAX_DOWNLOAD_MB: "2" };
    const runner = createOperationRunner(definition, environment);
    runOperation = (operationName, args) => runner(operationName, args, { source: "tool" });
  });

  after(async () => {
    await definition?.closeAllClients();
    await site?.close();
    await internalSite?.close();
    if (screenshotDirectory) await rm(screenshotDirectory, { recursive: true, force: true });
  });

  test("fetch_page returns the main content as text and markdown", async () => {
    const { data } = await runOperation("fetch_page", { url: `${site.origin}/article`, include_markdown: true });
    assert.equal(data.status, 200);
    assert.equal(data.title, "Test Article");
    assert.equal(data.description, "A page for tests");
    assert.match(data.text, /Main Heading\n\nFirst paragraph with a useful link and bold words\./);
    assert.doesNotMatch(data.text, /Copyright|About/);
    assert.match(data.markdown, /^# Main Heading/);
    assert.match(data.markdown, /\[useful link\]\(http:\/\/127\.0\.0\.1:\d+\/more\)/);
    assert.match(data.markdown, /- Item one\n- Item two/);
    assert.deepEqual(data.links.map((link) => link.text), ["useful link"]);
  });

  test("extract, get_links and screenshot work on the same page", async () => {
    const extracted = await runOperation("extract", { url: `${site.origin}/article`, fields: { heading: "h1", prices: { selector: ".price", all: true } } });
    assert.deepEqual(extracted.data.fields, { heading: "Main Heading", prices: ["10", "20"] });
    const links = await runOperation("get_links", { url: `${site.origin}/article`, pattern: "*/about" });
    assert.deepEqual(links.data.links.map((link) => link.text), ["About"]);
    const shot = await runOperation("screenshot", { url: `${site.origin}/article`, full_page: true, max_height: 300 });
    assert.equal(shot.data.height, 300);
    assert.ok((await stat(shot.data.path)).size > 100);
  });

  test("an allowed redirect chain lands on the final page", async () => {
    const { data } = await runOperation("fetch_page", { url: `${site.origin}/hop1` });
    assert.equal(data.final_url, `${site.origin}/article`);
    assert.equal(data.title, "Test Article");
  });

  test("a redirect to an internal host is refused", async () => {
    await assert.rejects(runOperation("fetch_page", { url: `${site.origin}/to-internal` }), { kind: "permission_denied" });
    assert.equal(internalSite.hits.length, 0);
  });

  test("sub-requests and WebSockets to internal hosts are blocked and reported", async () => {
    const { data } = await runOperation("fetch_page", { url: `${site.origin}/leaky`, wait_until: "networkidle" });
    assert.match(data.text, /Visible text/);
    assert.ok(data.blocked_requests.some((block) => block.target.includes("/secret?fetch")), JSON.stringify(data.blocked_requests));
    assert.equal(internalSite.hits.length, 0);
    assert.deepEqual(internalSite.upgrades, []);
  });

  test("a redirect to localhost (by name) is refused", async () => {
    await assert.rejects(runOperation("fetch_page", { url: `${site.origin}/to-localhost` }), { kind: "permission_denied" });
  });

  test("robots.txt disallow is enforced, also behind a redirect", async () => {
    await assert.rejects(runOperation("fetch_page", { url: `${site.origin}/private` }), { kind: "permission_denied" });
    await assert.rejects(runOperation("fetch_page", { url: `${site.origin}/to-private` }), { kind: "permission_denied" });
    assert.ok(!site.hits.includes("/private"), `hits: ${site.hits.join(", ")}`);
  });

  test("downloads are refused", async () => {
    await assert.rejects(runOperation("fetch_page", { url: `${site.origin}/download` }), { kind: "invalid_input" });
  });

  test("the download cap cuts a page that loads too much", async () => {
    const outcome = await runOperation("fetch_page", { url: `${site.origin}/huge` }).catch((error) => error);
    const warned = outcome?.data?.warnings?.some((warning) => /download cap/.test(warning));
    assert.ok(warned || outcome?.kind === "invalid_input", JSON.stringify(outcome?.data ?? outcome?.message));
  });

  test("loopback and metadata URLs are refused without the test allowlist", async () => {
    const strictRunner = createOperationRunner(createPluginDefinition(), { WEB_BROWSER_SCREENSHOT_DIR: screenshotDirectory });
    for (const url of [`http://127.0.0.1:${site.port}/article`, "http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/", "http://localhost/"]) {
      await assert.rejects(strictRunner("fetch_page", { url }, { source: "tool" }), { kind: "permission_denied" }, url);
    }
  });
});

describe("web-browser end-to-end: hostile pages (real Chromium)", { skip: isEnabled ? false : "set WEB_BROWSER_E2E=1 to run" }, () => {
  const udpListeners = [];
  const udpPackets = [];
  const previousLoopbackSetting = process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK;
  let site;
  let internalSite;
  let definition;
  let runOperation;

  const startUdpListener = async (family, address) => {
    const socket = dgram.createSocket(family);
    socket.on("message", (message, remote) => udpPackets.push(`${address} <- ${remote.address} (${message.length} bytes)`));
    await new Promise((resolve) => socket.bind(0, address, resolve));
    udpListeners.push(socket);
    return socket.address().port;
  };

  before(async () => {
    // Without an explicit bypass rule, Chromium would send loopback traffic around the proxy.
    process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = "1";
    const udpPorts = { ipv4Port: await startUdpListener("udp4", "127.0.0.1"), ipv6Port: await startUdpListener("udp6", "::1") };
    internalSite = await startLocalServer({ "/secret": htmlRoute("<title>secret</title>") }, { host: "::1" });
    const internalHttp = `http://[::1]:${internalSite.port}/secret`;
    site = await startLocalServer({
      "/robots.txt": (request, response) => response.end(""),
      "/article": htmlRoute(ARTICLE_HTML),
      "/webrtc": htmlRoute(buildWebRtcPage(udpPorts)),
      "/websockets": htmlRoute((server) => buildWebSocketPage(buildSocketTargets(server, internalSite, internalHttp))),
      "/probe-worker.js": (request, response, server) => {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(buildProbeWorkerScript(buildSocketTargets(server, internalSite, internalHttp)));
      },
      "/meta-refresh": htmlRoute(`<title>Refresh</title><meta http-equiv="refresh" content="0;url=${internalHttp}?meta"><p>about to leave</p>`),
      "/tamper": htmlRoute(TAMPERING_PAGE),
      "/busy": htmlRoute(BUSY_PAGE),
    });
    definition = createPluginDefinition({ allowedTestHosts: ["127.0.0.1"] });
    const runner = createOperationRunner(definition, { WEB_BROWSER_SCREENSHOT_DIR: join(tmpdir(), "web-browser-e2e-unused") });
    runOperation = (operationName, args) => runner(operationName, args, { source: "tool" });
  });

  after(async () => {
    if (previousLoopbackSetting === undefined) delete process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK;
    else process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = previousLoopbackSetting;
    await definition?.closeAllClients();
    await site?.close();
    await internalSite?.close();
    for (const socket of udpListeners) socket.close();
  });

  test("WebRTC is gone from the page, same-tick iframes and popups, and sends no UDP", async () => {
    const { data } = await runOperation("fetch_page", { url: `${site.origin}/webrtc`, wait_for_selector: "#done", timeout_seconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(udpPackets, []);
    assert.match(data.text, /main=absent/);
    assert.match(data.text, /iframe=absent/);
    assert.doesNotMatch(data.text, /=present/);
  });

  test("WebSockets are gone from the page, iframes and every kind of worker; nothing reaches the servers", async () => {
    const { data } = await runOperation("fetch_page", { url: `${site.origin}/websockets`, wait_for_selector: "#done", timeout_seconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.doesNotMatch(data.text, /escaped=/, "a tampered page never starts a worker without the hardening");
    for (const label of ["main", "iframe", "classic", "module", "url", "outer", "nested", "shared", "tampered"]) {
      assert.match(data.text, new RegExp(`\\b${label}=absent\\b`), `${label} in: ${data.text}`);
    }
    assert.deepEqual(site.upgrades, [], "no WebSocket handshake reached the public server");
    assert.deepEqual(internalSite.hits, [], "no request reached the internal server");
    assert.deepEqual(internalSite.upgrades, []);
    assert.equal(internalSite.connectionCount(), 0, "not even a TCP connection reached the internal server");
  });

  test("an internal navigation started while the page is read (meta refresh) is permission_denied", async () => {
    await assert.rejects(runOperation("fetch_page", { url: `${site.origin}/meta-refresh`, wait_until: "domcontentloaded" }), { kind: "permission_denied" });
    assert.deepEqual(internalSite.hits, []);
  });

  test("a page that tampers with built-ins cannot inflate or disable the snapshot caps", async () => {
    const { data } = await runOperation("fetch_page", { url: `${site.origin}/tamper`, main_content_only: false });
    assert.ok(data.text_length < 1000, `text_length ${data.text_length}`);
    assert.match(data.text, /alpha\s+beta\s+gamma/);
    const extracted = await runOperation("extract", { url: `${site.origin}/tamper`, fields: { price: ".price", every: { selector: "p", all: true } } });
    assert.deepEqual(extracted.data.fields, { price: "gamma", every: ["alpha", "beta", "gamma"] });
    assert.equal(extracted.data.title, "Tamper");
  });

  test("a page that spins its main thread fails fast and frees its slot", async () => {
    const startedAt = Date.now();
    await assert.rejects(runOperation("fetch_page", { url: `${site.origin}/busy`, timeout_seconds: 5 }), { kind: "timeout" });
    assert.ok(Date.now() - startedAt < 20000, `took ${Date.now() - startedAt} ms`);
    const { data } = await runOperation("fetch_page", { url: `${site.origin}/article` });
    assert.equal(data.title, "Test Article");
  });
});

function buildSocketTargets(server, internalSite, internalHttp) {
  return {
    socketUrls: [`ws://127.0.0.1:${server.port}/ws`, `ws://[::1]:${internalSite.port}/ws`, `ws://localhost:${internalSite.port}/ws`],
    fetchUrls: [internalHttp, `http://localhost:${internalSite.port}/secret`],
  };
}
