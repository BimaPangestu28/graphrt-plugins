import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { buildBrowserUserAgent, writeScreenshotFile } from "../lib/client.mjs";
import { hardenScopeInPage } from "../lib/page-hardening.mjs";
import { planCapture } from "../operations/screenshot.mjs";
import { buildArticleSnapshot, createTestRunner, element } from "./helpers.mjs";

async function withRunner(options, runChecks) {
  const runner = await createTestRunner(options);
  try {
    await runChecks(runner);
  } finally {
    await runner.cleanup();
  }
}

function createFakeRoute(url) {
  const request = { url: () => url, method: () => "GET", resourceType: () => "document", isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }) };
  return { request: () => request, abort: async () => {}, continue: async () => {} };
}

function timeoutError(message = "page.goto: Timeout 30000ms exceeded.") {
  return Object.assign(new Error(message), { name: "TimeoutError" });
}

test("the manifest offers four read-only tools, network access and the plugin's env vars", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["fetch_page", "get_links", "extract", "screenshot"]);
  assert.equal(manifest.permissions.network, true);
  assert.deepEqual(manifest.permissions.env, [
    "WEB_BROWSER_SCREENSHOT_DIR",
    "WEB_BROWSER_RESPECT_ROBOTS",
    "WEB_BROWSER_IDLE_MINUTES",
    "WEB_BROWSER_MAX_PAGES",
    "WEB_BROWSER_MAX_DOWNLOAD_MB",
    "WEB_BROWSER_USER_AGENT",
  ]);
  assert.equal(manifest.limits.timeout_ms, 100000);
  const allParameterNames = manifest.tools.flatMap((tool) => Object.keys(tool.parameters.properties));
  for (const forbidden of ["script", "javascript", "click", "type", "evaluate", "headers", "cookies"]) {
    assert.ok(!allParameterNames.includes(forbidden), `no tool takes \`${forbidden}\``);
  }
});

test("fetch_page returns the readable main content, metadata and main-content links", async () => {
  await withRunner({}, async ({ runOperation }) => {
    const { data } = await runOperation("fetch_page", { url: "https://example.com/post#intro" });
    assert.equal(data.url, "https://example.com/post#intro");
    assert.equal(data.final_url, "https://example.com/post");
    assert.equal(data.status, 200);
    assert.equal(data.content_type, "text/html; charset=utf-8");
    assert.equal(data.title, "Hello");
    assert.equal(data.description, "Desc");
    assert.match(data.text, /^Hello world\n\nSome linked text/);
    assert.doesNotMatch(data.text, /Home|Footer/);
    assert.deepEqual(data.links, [{ url: "https://example.com/more", text: "linked" }]);
    assert.equal(data.markdown, undefined);
    assert.deepEqual(data.warnings, []);
    assert.deepEqual(data.blocked_requests, []);
  });
});

test("fetch_page can return markdown, the whole body, and caps text and links", async () => {
  await withRunner({}, async ({ runOperation }) => {
    const { data } = await runOperation("fetch_page", { url: "https://example.com/", include_markdown: true, main_content_only: false, max_chars: 500, max_links: 1 });
    assert.match(data.markdown, /^\[Home\]\(https:\/\/example\.com\/\)\n\n# Hello world\n\nSome \[linked\]\(https:\/\/example\.com\/more\)/);
    assert.match(data.text, /Footer text$/);
    assert.equal(data.links.length, 1);
    assert.equal(data.links_truncated, true);
  });
});

test("fetch_page truncates long text", async () => {
  const snapshot = { ...buildArticleSnapshot(), root: element("body", {}, element("p", {}, "word ".repeat(400))) };
  await withRunner({ pageOptions: { snapshot } }, async ({ runOperation }) => {
    const { data } = await runOperation("fetch_page", { url: "https://example.com/", max_chars: 500 });
    assert.equal(data.text_truncated, true);
    assert.ok(data.text.length <= 501);
    assert.equal(data.text_length, 1999);
  });
});

test("each call uses a fresh, locked-down context behind its own proxy", async () => {
  await withRunner({}, async ({ runOperation, launcher, proxyFactory }) => {
    await runOperation("fetch_page", { url: "https://example.com/" });
    await runOperation("fetch_page", { url: "https://example.com/" });
    assert.equal(launcher.launchCount, 1);
    assert.equal(launcher.contexts.length, 2);
    const [context] = launcher.contexts;
    assert.equal(context.options.acceptDownloads, false);
    assert.equal(context.options.serviceWorkers, "block");
    assert.equal(context.options.ignoreHTTPSErrors, false);
    // Explicit "<-loopback>": loopback traffic goes through the proxy whatever Playwright's defaults or env say.
    assert.deepEqual(context.options.proxy, { server: "http://127.0.0.1:1", bypass: "<-loopback>", username: "op-user", password: "op-secret" });
    assert.match(context.options.userAgent, /Chrome\/131\.0\.6778\.33 Safari\/537\.36 graphrt-web-browser\/0\.2\.1/);
    assert.deepEqual(context.routes.map((route) => route.pattern), ["**/*"]);
    assert.deepEqual(context.initScripts.map((initScript) => initScript.script), [hardenScopeInPage]);
    assert.ok(context.initScripts[0].argument.blockedGlobals.includes("RTCPeerConnection"));
    assert.ok(context.initScripts[0].argument.blockedGlobals.includes("WebSocket"));
    assert.equal(context.closed, true);
    assert.equal(proxyFactory.proxies.length, 2);
    assert.ok(proxyFactory.proxies.every((proxy) => proxy.closed));
    assert.equal(proxyFactory.starts[0].maxResponseBytes, 15 * 1024 * 1024);
  });
});

const REFUSED_URLS = [
  ["file:///etc/passwd", "invalid_input"],
  ["data:text/html,<script>alert(1)</script>", "invalid_input"],
  ["javascript:alert(1)", "invalid_input"],
  ["https://user:secret@example.com/", "invalid_input"],
  ["http://127.0.0.1/", "permission_denied"],
  ["http://2130706433/", "permission_denied"],
  ["http://localhost:8080/admin", "permission_denied"],
  ["http://169.254.169.254/latest/meta-data/", "permission_denied"],
  ["http://[fd00:ec2::254]/latest/meta-data/", "permission_denied"],
  ["http://[::ffff:127.0.0.1]/", "permission_denied"],
  ["http://[64:ff9b::a9fe:a9fe]/", "permission_denied"],
  ["http://100.100.100.200/", "permission_denied"],
  ["http://internal.example/", "permission_denied"],
  ["http://mixed.example/", "permission_denied"],
  ["https://does-not-exist.example/", "not_found"],
];

for (const [refusedUrl, expectedKind] of REFUSED_URLS) {
  test(`${refusedUrl} is refused with ${expectedKind} before any browser starts`, async () => {
    await withRunner({}, async ({ runOperation, launcher, proxyFactory }) => {
      for (const operationName of ["fetch_page", "screenshot"]) {
        await assert.rejects(runOperation(operationName, { url: refusedUrl }), { kind: expectedKind });
      }
      assert.equal(launcher.launchCount, 0);
      assert.equal(proxyFactory.starts.length, 0);
    });
  });
}

test("robots.txt is checked before the browser starts", async () => {
  await withRunner({ robotsText: "User-agent: *\nDisallow: /private" }, async ({ runOperation, launcher, robotsFetches }) => {
    await assert.rejects(runOperation("fetch_page", { url: "https://example.com/private/page" }), { kind: "permission_denied", message: /robots\.txt/ });
    assert.equal(launcher.launchCount, 0);
    await runOperation("fetch_page", { url: "https://example.com/public" });
    assert.deepEqual(robotsFetches, ["https://example.com/robots.txt"]);
  });
});

test("WEB_BROWSER_RESPECT_ROBOTS=0 skips robots.txt", async () => {
  const options = { robotsText: "User-agent: *\nDisallow: /", environment: { WEB_BROWSER_RESPECT_ROBOTS: "0" } };
  await withRunner(options, async ({ runOperation, robotsFetches }) => {
    await runOperation("fetch_page", { url: "https://example.com/" });
    assert.deepEqual(robotsFetches, []);
  });
});

const NAVIGATION_FAILURES = [
  ["an unresolvable host", new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/"), "not_found"],
  ["a download", new Error("page.goto: Download is starting"), "invalid_input"],
  ["a refused connection", new Error("page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/"), "network_error"],
  ["a timeout before anything loaded", timeoutError(), "timeout"],
  ["an unknown failure", new Error("page.goto: something odd"), "browser_error"],
];

for (const [label, gotoError, expectedKind] of NAVIGATION_FAILURES) {
  test(`navigation failure: ${label} is ${expectedKind}`, async () => {
    await withRunner({ pageOptions: { gotoError } }, async ({ runOperation, launcher }) => {
      await assert.rejects(runOperation("fetch_page", { url: "https://example.com/" }), { kind: expectedKind });
      assert.equal(launcher.contexts[0].closed, true);
    });
  });
}

test("a load timeout after the page arrived returns the content with a warning", async () => {
  await withRunner({ pageOptions: { gotoError: timeoutError(), failAfterCommit: true } }, async ({ runOperation }) => {
    const { data } = await runOperation("fetch_page", { url: "https://example.com/", wait_until: "networkidle", timeout_seconds: 5 });
    assert.match(data.text, /Hello world/);
    assert.match(data.warnings[0], /did not reach `networkidle` within 5 s/);
  });
});

test("a navigation to an internal host that interrupts reading the page is permission_denied", async () => {
  const beforeRead = async (page) => {
    const [{ handler }] = page.fakeContext.routes;
    await handler(createFakeRoute("http://internal.example/admin"));
    throw new Error("Execution context was destroyed, most likely because of a navigation");
  };
  await withRunner({ pageOptions: { beforeRead } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("fetch_page", { url: "https://example.com/" }), { kind: "permission_denied", message: /internal\.example/ });
  });
});

test("a page blocked by the proxy is refused", async () => {
  await withRunner({ pageOptions: { headers: { "x-graphrt-blocked": "1" }, status: 403 } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("fetch_page", { url: "https://example.com/" }), { kind: "permission_denied" });
  });
});

test("a page that ends on a non-http URL is refused", async () => {
  await withRunner({ pageOptions: { finalUrl: "chrome-error://chromewebdata/" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("fetch_page", { url: "https://example.com/" }), { kind: "permission_denied" });
  });
});

test("a spent download budget is reported as a warning when the page still loaded", async () => {
  await withRunner({ proxyStats: { budgetExceeded: true } }, async ({ runOperation }) => {
    const { data } = await runOperation("fetch_page", { url: "https://example.com/" });
    assert.match(data.warnings.join(" "), /download cap/);
  });
});

test("wait_for_selector is forced to the CSS engine", async () => {
  await withRunner({}, async ({ runOperation, launcher }) => {
    await runOperation("fetch_page", { url: "https://example.com/", wait_for_selector: "article h1" });
    const waitCall = launcher.contexts[0].pages[0].calls.find((call) => call[0] === "waitForSelector");
    assert.equal(waitCall[1], "css=article h1");
    assert.equal(waitCall[2].state, "attached");
  });
});

test("wait_for_selector failures: invalid selector and timeout", async () => {
  await withRunner({ pageOptions: { waitError: new Error("Unexpected token \"[\" while parsing css selector") } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("fetch_page", { url: "https://example.com/", wait_for_selector: "a[" }), { kind: "invalid_input" });
  });
  await withRunner({ pageOptions: { waitError: timeoutError("Timeout 1000ms exceeded") } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("fetch_page", { url: "https://example.com/", wait_for_selector: ".late" }), { kind: "timeout" });
  });
});

test("argument limits are enforced", async () => {
  await withRunner({}, async ({ runOperation, launcher }) => {
    await assert.rejects(runOperation("fetch_page", { url: "https://example.com/", timeout_seconds: 61 }), { kind: "invalid_input" });
    await assert.rejects(runOperation("fetch_page", { url: "https://example.com/", max_chars: 100001 }), { kind: "invalid_input" });
    await assert.rejects(runOperation("fetch_page", { url: "https://example.com/", wait_for_selector: "a".repeat(501) }), { kind: "invalid_input" });
    await assert.rejects(runOperation("fetch_page", {}), { kind: "invalid_input" });
    assert.equal(launcher.launchCount, 0);
  });
});

test("extract returns shaped values and passes validated specs to the fixed in-page function", async () => {
  const extractCalls = [];
  const extractResults = (argument) => {
    extractCalls.push(argument);
    return { title: { values: ["Hello world"], matchCount: 1 }, prices: { values: ["1", "2"], matchCount: 2 }, bad: { error: "invalid CSS selector" } };
  };
  await withRunner({ pageOptions: { extractResults } }, async ({ runOperation }) => {
    const { data } = await runOperation("extract", { url: "https://example.com/", fields: { title: "h1", prices: { selector: ".price", all: true }, bad: "::x" }, max_matches: 5 });
    assert.deepEqual(data.fields, { title: "Hello world", prices: ["1", "2"], bad: null });
    assert.deepEqual(data.errors, { bad: "invalid CSS selector" });
    assert.deepEqual(extractCalls[0].limits, { maxValueChars: 2000, maxMatches: 5 });
    assert.equal(extractCalls[0].fieldSpecs.length, 3);
  });
});

test("extract fails with invalid_input when no selector works, and validates fields before launching", async () => {
  const extractResults = () => ({ only: { error: "invalid CSS selector" } });
  await withRunner({ pageOptions: { extractResults } }, async ({ runOperation, launcher }) => {
    await assert.rejects(runOperation("extract", { url: "https://example.com/", fields: { "bad name": "h1" } }), { kind: "invalid_input" });
    assert.equal(launcher.launchCount, 0);
    await assert.rejects(runOperation("extract", { url: "https://example.com/", fields: { only: "::x" } }), { kind: "invalid_input", message: /No selector/ });
  });
});

test("get_links filters by scope and pattern and reports totals", async () => {
  const snapshot = {
    ...buildArticleSnapshot(),
    root: element(
      "body",
      {},
      element("a", { href: "https://example.com/blog/1" }, "One"),
      element("a", { href: "https://example.com/blog/2" }, "Two"),
      element("a", { href: "https://other.org/blog/3" }, "Three"),
      element("a", { href: "https://example.com/about" }, "About"),
    ),
  };
  await withRunner({ pageOptions: { snapshot } }, async ({ runOperation, launcher }) => {
    const { data } = await runOperation("get_links", { url: "https://www.example.com/", scope: "same_host", pattern: "/blog/", limit: 1 });
    assert.deepEqual(data.links, [{ url: "https://example.com/blog/1", text: "One" }]);
    assert.equal(data.total_found, 2);
    assert.equal(data.truncated, true);
    await assert.rejects(runOperation("get_links", { url: "https://example.com/", pattern: "x".repeat(301) }), { kind: "invalid_input" });
    assert.equal(launcher.contexts.length, 1);
  });
});

test("screenshot writes a private PNG with a generated name inside the screenshot directory", async () => {
  await withRunner({ pageOptions: { pageHeight: 20000 } }, async ({ runOperation, launcher, screenshotDirectory }) => {
    const { data } = await runOperation("screenshot", { url: "https://example.com/", full_page: true, max_height: 3000, viewport_width: 1024 });
    assert.equal(dirname(data.path), screenshotDirectory);
    assert.match(data.path, /-example\.com-[0-9a-f]{8}\.png$/);
    assert.equal(await readFile(data.path, "utf8"), "PNGDATA");
    assert.equal((await stat(data.path)).mode & 0o777, 0o600);
    assert.equal(data.height, 3000);
    assert.equal(data.height_truncated, true);
    const context = launcher.contexts[0];
    assert.deepEqual(context.options.viewport, { width: 1024, height: 800 });
    const screenshotCall = context.pages[0].calls.find((call) => call[0] === "screenshot");
    assert.deepEqual(screenshotCall[1].clip, { x: 0, y: 0, width: 1024, height: 3000 });
  });
});

test("planCapture picks viewport or capped full-page captures", () => {
  const viewport = { width: 1280, height: 800 };
  assert.deepEqual(planCapture({ fullPage: false, viewport, pageHeight: 5000, maxHeight: 8000 }), { options: {}, height: 800, truncated: false });
  assert.deepEqual(planCapture({ fullPage: true, viewport, pageHeight: 2500.4, maxHeight: 8000 }), {
    options: { fullPage: true, clip: { x: 0, y: 0, width: 1280, height: 2501 } },
    height: 2501,
    truncated: false,
  });
  assert.equal(planCapture({ fullPage: true, viewport, pageHeight: 0, maxHeight: 8000 }).height, 800);
});

test("buildBrowserUserAgent names the plugin and its robots token", () => {
  assert.equal(
    buildBrowserUserAgent("131.0.1", "linux"),
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.1 Safari/537.36 graphrt-web-browser/0.2.1 (+https://github.com/BimaPangestu28/graphrt-plugins)",
  );
});

test("WEB_BROWSER_USER_AGENT replaces the browser user agent", async () => {
  await withRunner({ environment: { WEB_BROWSER_USER_AGENT: "MyCrawler/2.0 (+https://me.example)" } }, async ({ runOperation, launcher }) => {
    await runOperation("fetch_page", { url: "https://example.com/" });
    assert.equal(launcher.contexts[0].options.userAgent, "MyCrawler/2.0 (+https://me.example)");
  });
});

test("node and tool calls run the same operation", async () => {
  await withRunner({}, async ({ runOperation }) => {
    const nodeResult = await runOperation("fetch_page", { url: "https://example.com/" }, "node");
    assert.equal(nodeResult.data.title, "Hello");
    assert.equal(nodeResult.next_cursor, null);
  });
});

test("writing a screenshot deletes this plugin's screenshots older than 24 hours", async () => {
  const screenshotDirectory = await mkdtemp(join(tmpdir(), "web-browser-cleanup-"));
  try {
    const dayAndAHourAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const oldShot = "2026-01-01T00-00-00-000Z-example.com-0123abcd.png";
    const recentShot = "2026-01-02T00-00-00-000Z-example.com-89abcdef.png";
    for (const fileName of [oldShot, recentShot, "notes.txt"]) await writeFile(join(screenshotDirectory, fileName), "x");
    await utimes(join(screenshotDirectory, oldShot), dayAndAHourAgo, dayAndAHourAgo);
    await utimes(join(screenshotDirectory, "notes.txt"), dayAndAHourAgo, dayAndAHourAgo);
    const newPath = await writeScreenshotFile(screenshotDirectory, Buffer.from("PNG"), "https://example.com/");
    const remaining = (await readdir(screenshotDirectory)).sort();
    assert.deepEqual(remaining, [recentShot, newPath.split("/").pop(), "notes.txt"].sort());
  } finally {
    await rm(screenshotDirectory, { recursive: true, force: true });
  }
});
