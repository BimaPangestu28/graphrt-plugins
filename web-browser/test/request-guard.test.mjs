import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostGuard } from "../lib/address-policy.mjs";
import { createRequestGuard, MAX_NAVIGATION_REDIRECTS } from "../lib/request-guard.mjs";
import { createFakeResolver } from "./helpers.mjs";

function createFakeRequest(url, { resourceType = "script", navigation = false, mainFrame = true, method = "GET", redirectedFrom = null } = {}) {
  return {
    url: () => url,
    resourceType: () => resourceType,
    isNavigationRequest: () => navigation,
    frame: () => ({ parentFrame: () => (mainFrame ? null : {}) }),
    method: () => method,
    redirectedFrom: () => redirectedFrom,
  };
}

// `responses` maps hop URL -> {status, location?}; every route.fetch is recorded.
function createFakeRoute(request, responses = {}) {
  const route = {
    actions: [],
    fetchedUrls: [],
    request: () => request,
    abort: async (reason) => route.actions.push(["abort", reason]),
    continue: async () => route.actions.push(["continue"]),
    fulfill: async (fulfillOptions) => route.actions.push(["fulfill", fulfillOptions]),
    fetch: async ({ url }) => {
      route.fetchedUrls.push(url);
      const answer = responses[url] ?? { status: 200 };
      if (answer.error) throw new Error(answer.error);
      return { status: () => answer.status, headers: () => (answer.location ? { location: answer.location } : {}), answer };
    },
  };
  return route;
}

function createGuard({ robotsRules = {}, skippedResourceTypes = ["image"], maxRequests = 100 } = {}) {
  const robotsChecks = [];
  const robotsChecker = {
    isAllowed: async (url) => {
      robotsChecks.push(url);
      return robotsRules[new URL(url).pathname] ?? true;
    },
  };
  const guard = createRequestGuard({ hostGuard: createHostGuard({ resolveHostAddresses: createFakeResolver() }), robotsChecker, skippedResourceTypes, maxRequests });
  return { guard, robotsChecks };
}

test("sub-requests to public hosts continue", async () => {
  const { guard, robotsChecks } = createGuard();
  const route = createFakeRoute(createFakeRequest("https://example.com/app.js"));
  await guard.handleRoute(route);
  assert.deepEqual(route.actions, [["continue"]]);
  assert.deepEqual(robotsChecks, [], "robots.txt is only checked for navigations");
});

for (const blockedUrl of ["http://127.0.0.1/x", "http://localhost:3000/", "http://[::1]/", "http://169.254.169.254/latest", "http://internal.example/", "http://mixed.example/", "http://[fd00:ec2::254]/", "http://[::ffff:7f00:1]/"]) {
  test(`sub-request to ${blockedUrl} is aborted and recorded`, async () => {
    const { guard } = createGuard();
    const route = createFakeRoute(createFakeRequest(blockedUrl, { resourceType: "fetch" }));
    await guard.handleRoute(route);
    assert.deepEqual(route.actions, [["abort", "blockedbyclient"]]);
    assert.equal(guard.report().blocked.length, 1);
  });
}

test("non-http(s) requests are aborted", async () => {
  const { guard } = createGuard();
  const route = createFakeRoute(createFakeRequest("ftp://example.com/file"));
  await guard.handleRoute(route);
  assert.deepEqual(route.actions, [["abort", "blockedbyclient"]]);
});

test("skipped resource types are aborted quietly", async () => {
  const { guard } = createGuard();
  const route = createFakeRoute(createFakeRequest("https://example.com/a.png", { resourceType: "image" }));
  await guard.handleRoute(route);
  assert.deepEqual(route.actions, [["abort", "blockedbyclient"]]);
  assert.equal(guard.report().blocked.length, 0);
});

test("requests beyond the cap are aborted", async () => {
  const { guard } = createGuard({ maxRequests: 2 });
  const routes = [1, 2, 3].map((index) => createFakeRoute(createFakeRequest(`https://example.com/${index}.js`)));
  for (const route of routes) await guard.handleRoute(route);
  assert.deepEqual(routes.map((route) => route.actions[0][0]), ["continue", "continue", "abort"]);
});

test("a main-frame navigation without redirects is fetched once and fulfilled with that response", async () => {
  const { guard, robotsChecks } = createGuard();
  const route = createFakeRoute(createFakeRequest("https://example.com/page", { navigation: true, resourceType: "document" }));
  await guard.handleRoute(route);
  assert.deepEqual(route.fetchedUrls, ["https://example.com/page"]);
  assert.equal(route.actions[0][0], "fulfill");
  assert.equal(route.actions[0][1].response.answer.status, 200);
  assert.deepEqual(robotsChecks, ["https://example.com/page"]);
});

test("redirect hops are checked before they are requested, then the browser is sent to the final URL", async () => {
  const { guard, robotsChecks } = createGuard();
  const responses = {
    "https://example.com/start": { status: 301, location: "/middle" },
    "https://example.com/middle": { status: 302, location: "https://www.example.com/final" },
  };
  const route = createFakeRoute(createFakeRequest("https://example.com/start", { navigation: true }), responses);
  await guard.handleRoute(route);
  assert.deepEqual(route.fetchedUrls, ["https://example.com/start", "https://example.com/middle", "https://www.example.com/final"]);
  assert.deepEqual(robotsChecks, ["https://example.com/start", "https://example.com/middle", "https://www.example.com/final"]);
  assert.deepEqual(route.actions, [["fulfill", { status: 302, headers: { location: "https://www.example.com/final" } }]]);
});

test("a redirect to an internal host is blocked before it is requested", async () => {
  const { guard } = createGuard();
  const responses = { "https://example.com/start": { status: 302, location: "http://169.254.169.254/latest/meta-data/" } };
  const route = createFakeRoute(createFakeRequest("https://example.com/start", { navigation: true }), responses);
  await guard.handleRoute(route);
  assert.deepEqual(route.fetchedUrls, ["https://example.com/start"]);
  assert.deepEqual(route.actions, [["abort", "blockedbyclient"]]);
  assert.equal(guard.report().navigationViolation.kind, "host");
});

test("a redirect to a robots.txt-disallowed path is blocked before it is requested", async () => {
  const { guard } = createGuard({ robotsRules: { "/private": false } });
  const responses = { "https://example.com/start": { status: 302, location: "/private" } };
  const route = createFakeRoute(createFakeRequest("https://example.com/start", { navigation: true }), responses);
  await guard.handleRoute(route);
  assert.deepEqual(route.fetchedUrls, ["https://example.com/start"]);
  assert.deepEqual(guard.report().navigationViolation, { url: "https://example.com/private", reason: "disallowed by robots.txt", kind: "robots" });
});

test("a redirect to a non-http scheme is blocked", async () => {
  const { guard } = createGuard();
  const responses = { "https://example.com/start": { status: 302, location: "file:///etc/passwd" } };
  const route = createFakeRoute(createFakeRequest("https://example.com/start", { navigation: true }), responses);
  await guard.handleRoute(route);
  assert.deepEqual(route.actions, [["abort", "blockedbyclient"]]);
  assert.equal(guard.report().navigationViolation.kind, "host");
});

test("redirect loops stop after the redirect limit", async () => {
  const { guard } = createGuard();
  const route = createFakeRoute(createFakeRequest("https://example.com/loop", { navigation: true }), { "https://example.com/loop": { status: 302, location: "/loop" } });
  await guard.handleRoute(route);
  assert.equal(route.fetchedUrls.length, MAX_NAVIGATION_REDIRECTS + 1);
  assert.deepEqual(route.actions, [["abort", "blockedbyclient"]]);
});

test("a failed hop fetch aborts the navigation", async () => {
  const { guard } = createGuard();
  const route = createFakeRoute(createFakeRequest("https://example.com/down", { navigation: true }), { "https://example.com/down": { error: "ECONNRESET" } });
  await guard.handleRoute(route);
  assert.deepEqual(route.actions, [["abort", "failed"]]);
});

test("a disallowed main-frame navigation is aborted without fetching", async () => {
  const { guard } = createGuard({ robotsRules: { "/private": false } });
  const route = createFakeRoute(createFakeRequest("https://example.com/private", { navigation: true }));
  await guard.handleRoute(route);
  assert.deepEqual(route.fetchedUrls, []);
  assert.equal(guard.report().navigationViolation.kind, "robots");
});

test("non-GET and sub-frame navigations are not refetched", async () => {
  const { guard, robotsChecks } = createGuard();
  const postRoute = createFakeRoute(createFakeRequest("https://example.com/form", { navigation: true, method: "POST" }));
  const frameRoute = createFakeRoute(createFakeRequest("https://example.com/frame", { navigation: true, mainFrame: false }));
  await guard.handleRoute(postRoute);
  await guard.handleRoute(frameRoute);
  assert.deepEqual([postRoute.actions, frameRoute.actions], [[["continue"]], [["continue"]]]);
  assert.deepEqual(robotsChecks, ["https://example.com/form"]);
});

test("watchPage records main-frame navigations and closes the page on a disallowed browser-followed redirect", async () => {
  const { guard } = createGuard({ robotsRules: { "/private": false } });
  const listeners = [];
  const page = { closed: false, on: (eventName, listener) => listeners.push(listener), close: async () => (page.closed = true) };
  guard.watchPage(page);
  listeners.forEach((listener) => listener(createFakeRequest("https://example.com/start", { navigation: true })));
  listeners.forEach((listener) => listener(createFakeRequest("https://example.com/private", { navigation: true, redirectedFrom: {} })));
  listeners.forEach((listener) => listener(createFakeRequest("https://example.com/x.js")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(guard.report().navigationUrls, ["https://example.com/start", "https://example.com/private"]);
  assert.equal(page.closed, true);
  assert.equal(guard.report().navigationViolation.kind, "robots");
});

test("a route that was already handled (page closed) does not throw", async () => {
  const { guard } = createGuard();
  const route = createFakeRoute(createFakeRequest("https://example.com/app.js"));
  route.continue = async () => {
    throw new Error("Route is already handled!");
  };
  await guard.handleRoute(route);
});
