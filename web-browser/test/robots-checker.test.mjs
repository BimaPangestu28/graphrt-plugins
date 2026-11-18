import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostGuard } from "../lib/address-policy.mjs";
import { createRobotsChecker, fetchRobotsFileWithNode, MAX_ROBOTS_BYTES } from "../lib/robots-checker.mjs";
import { redirectRoute, startLocalServer } from "./local-server.mjs";

function createCheckerWith(outcomes, now = () => 0) {
  const fetches = [];
  const checker = createRobotsChecker({
    hostGuard: null,
    userAgent: "test-agent",
    now,
    fetchRobotsFile: async (robotsUrl) => {
      fetches.push(robotsUrl);
      return typeof outcomes === "function" ? outcomes(robotsUrl) : outcomes;
    },
  });
  return { checker, fetches };
}

test("rules from a 2xx robots.txt apply", async () => {
  const { checker, fetches } = createCheckerWith({ status: "ok", text: "User-agent: *\nDisallow: /private" });
  assert.equal(await checker.isAllowed("https://example.com/public"), true);
  assert.equal(await checker.isAllowed("https://example.com/private?x=1"), false);
  assert.deepEqual(fetches, ["https://example.com/robots.txt"], "the policy is cached per origin");
});

test("assertAllowed explains the refusal and how to turn robots.txt off", async () => {
  const { checker } = createCheckerWith({ status: "ok", text: "User-agent: *\nDisallow: /" });
  await assert.rejects(checker.assertAllowed("https://example.com/x"), { kind: "permission_denied", message: /robots\.txt.*WEB_BROWSER_RESPECT_ROBOTS=0/s });
});

test("a missing robots.txt (4xx) allows everything", async () => {
  const { checker } = createCheckerWith({ status: "unavailable" });
  assert.equal(await checker.isAllowed("https://example.com/anything"), true);
});

test("a 5xx robots.txt disallows the whole site for a minute", async () => {
  let currentTime = 0;
  const outcomes = [{ status: "server_error" }, { status: "ok", text: "" }];
  const { checker, fetches } = createCheckerWith(() => outcomes.shift(), () => currentTime);
  assert.equal(await checker.isAllowed("https://example.com/a"), false);
  currentTime += 30000;
  assert.equal(await checker.isAllowed("https://example.com/a"), false);
  currentTime += 31000;
  assert.equal(await checker.isAllowed("https://example.com/a"), true);
  assert.equal(fetches.length, 2);
});

test("a network failure is a retryable network_error and is not cached", async () => {
  const outcomes = [{ status: "network_error", reason: "ECONNREFUSED" }, { status: "ok", text: "" }];
  const { checker, fetches } = createCheckerWith(() => outcomes.shift());
  await assert.rejects(checker.isAllowed("https://example.com/a"), { kind: "network_error", retryable: true });
  assert.equal(await checker.isAllowed("https://example.com/a"), true);
  assert.equal(fetches.length, 2);
});

test("origins are cached separately (scheme and port included)", async () => {
  const { checker, fetches } = createCheckerWith({ status: "ok", text: "" });
  await checker.isAllowed("https://example.com/a");
  await checker.isAllowed("http://example.com/a");
  await checker.isAllowed("https://example.com:8443/a");
  assert.deepEqual(fetches, ["https://example.com/robots.txt", "http://example.com/robots.txt", "https://example.com:8443/robots.txt"]);
});

test("fetchRobotsFileWithNode reads robots.txt over a pinned connection and follows checked redirects", async () => {
  const server = await startLocalServer({
    "/robots.txt": redirectRoute((serverInfo) => `${serverInfo.origin}/real-robots.txt`),
    "/real-robots.txt": (request, response) => response.end(`UA:${request.headers["user-agent"]}`),
  });
  try {
    const hostGuard = createHostGuard({ allowedTestHosts: ["127.0.0.1"] });
    const outcome = await fetchRobotsFileWithNode(`${server.origin}/robots.txt`, { hostGuard, userAgent: "graphrt-test" });
    assert.deepEqual(outcome, { status: "ok", text: "UA:graphrt-test" });
  } finally {
    await server.close();
  }
});

test("fetchRobotsFileWithNode never follows a redirect to an internal host", async () => {
  const internalServer = await startLocalServer({ "/robots.txt": (request, response) => response.end("User-agent: *\nDisallow: /") });
  const server = await startLocalServer({ "/robots.txt": redirectRoute(`http://localhost:${internalServer.port}/robots.txt`) });
  try {
    const hostGuard = createHostGuard({ allowedTestHosts: ["127.0.0.1"] });
    assert.deepEqual(await fetchRobotsFileWithNode(`${server.origin}/robots.txt`, { hostGuard, userAgent: "t" }), { status: "unavailable" });
    assert.equal(internalServer.hits.length, 0);
  } finally {
    await Promise.all([server.close(), internalServer.close()]);
  }
});

test("fetchRobotsFileWithNode classifies 404, 503, 429 and refused connections", async () => {
  const server = await startLocalServer({
    "/robots.txt": (request, response) => {
      response.writeHead(503);
      response.end();
    },
    "/too-many/robots.txt": (request, response) => {
      response.writeHead(429);
      response.end();
    },
  });
  const hostGuard = createHostGuard({ allowedTestHosts: ["127.0.0.1"] });
  try {
    assert.deepEqual(await fetchRobotsFileWithNode(`${server.origin}/robots.txt`, { hostGuard, userAgent: "t" }), { status: "server_error" });
    assert.deepEqual(await fetchRobotsFileWithNode(`${server.origin}/too-many/robots.txt`, { hostGuard, userAgent: "t" }), { status: "server_error" }, "429 is treated like 5xx");
    assert.deepEqual(await fetchRobotsFileWithNode(`${server.origin}/missing/robots.txt`, { hostGuard, userAgent: "t" }), { status: "unavailable" });
  } finally {
    await server.close();
  }
  const refused = await fetchRobotsFileWithNode(`${server.origin}/robots.txt`, { hostGuard, userAgent: "t" });
  assert.equal(refused.status, "network_error");
});

test("fetchRobotsFileWithNode keeps only the first 512 KiB", async () => {
  const server = await startLocalServer({ "/robots.txt": (request, response) => response.end("x".repeat(MAX_ROBOTS_BYTES + 100000)) });
  try {
    const outcome = await fetchRobotsFileWithNode(`${server.origin}/robots.txt`, { hostGuard: createHostGuard({ allowedTestHosts: ["127.0.0.1"] }), userAgent: "t" });
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.text.length, MAX_ROBOTS_BYTES);
  } finally {
    await server.close();
  }
});
