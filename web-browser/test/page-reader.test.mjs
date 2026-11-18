import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateInIsolatedWorld } from "../lib/page-reader.mjs";
import { sanitizeFieldResults, sanitizePageHeight, sanitizeSnapshot, sanitizeTitle } from "../lib/snapshot-limits.mjs";
import { snapshotDocumentInPage } from "../lib/page-snapshot.mjs";
import { createFakeCdpSession } from "./helpers.mjs";

const LIMITS = { maxNodes: 10, maxTextChars: 50, maxAttributeChars: 40, maxDepth: 3 };

test("sanitizeSnapshot keeps a well-formed snapshot as it is", () => {
  const snapshot = {
    root: { tag: "body", attrs: { id: "x" }, children: ["hello", { tag: "a", attrs: { href: "https://e.com/" }, children: ["link"] }] },
    metadata: { title: "T", description: null, lang: "en", canonical_url: null, content_type: "text/html" },
    truncated: false,
  };
  assert.deepEqual(sanitizeSnapshot(snapshot, LIMITS), snapshot);
});

test("sanitizeSnapshot clips text, nodes, depth and attributes to the caps, whatever the page sent", () => {
  const hugeText = "A".repeat(10000);
  const deep = { tag: "div", attrs: {}, children: [{ tag: "div", attrs: {}, children: [{ tag: "div", attrs: {}, children: [{ tag: "div", attrs: {}, children: [{ tag: "div", attrs: {}, children: ["too deep"] }] }] }] }] };
  const raw = {
    root: {
      tag: `X-${"y".repeat(500)}`,
      attrs: { class: "c".repeat(300), href: "h".repeat(5000), onclick: "evil()", id: 42 },
      children: [hugeText, hugeText, deep, ...Array.from({ length: 1000 }, () => ({ tag: "p", attrs: {}, children: ["x"] }))],
    },
    metadata: { title: "t".repeat(10000), description: { not: "a string" }, lang: "l".repeat(100), canonical_url: 7, content_type: "text/html" },
    truncated: false,
  };
  const snapshot = sanitizeSnapshot(raw, LIMITS);
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.root.tag.length <= 64);
  assert.ok(Object.keys(snapshot.root.attrs).every((attributeName) => ["class", "href"].includes(attributeName)), "only kept attributes, only strings");
  assert.equal(Object.values(snapshot.root.attrs).join("").length, 40, "attribute characters share one budget");
  const json = JSON.stringify(snapshot.root);
  assert.equal((json.match(/A/g) ?? []).length, 50, "text is capped across nodes");
  assert.doesNotMatch(json, /too deep/);
  assert.ok(countNodes(snapshot.root) <= LIMITS.maxNodes);
  assert.equal(snapshot.metadata.title.length, 500);
  assert.equal(snapshot.metadata.description, null);
  assert.equal(snapshot.metadata.lang.length, 35);
  assert.equal(snapshot.metadata.canonical_url, null);
});

test("sanitizeSnapshot survives garbage", () => {
  for (const garbage of [null, 5, "text", [], { root: "str" }, { root: { tag: 5 } }, { root: { tag: "p", children: "nope" } }]) {
    const snapshot = sanitizeSnapshot(garbage, LIMITS);
    assert.equal(typeof snapshot.metadata, "object");
    assert.ok(snapshot.root === null || typeof snapshot.root.tag === "string");
  }
});

test("sanitizeFieldResults keeps only requested fields, capped values and counts", () => {
  const fieldSpecs = [{ name: "one", all: false }, { name: "many", all: true }, { name: "bad", all: false }];
  const raw = {
    one: { values: ["v".repeat(5000), "second"], matchCount: 2 },
    many: { values: [...Array.from({ length: 50 }, (unused, index) => `m${index}`), 7, null], matchCount: Infinity },
    bad: { error: "e".repeat(5000) },
    injected: { values: ["x"], matchCount: 1 },
  };
  const results = sanitizeFieldResults(raw, fieldSpecs, { maxMatches: 3, maxValueChars: 100 });
  assert.deepEqual(Object.keys(results), ["one", "many", "bad"]);
  assert.deepEqual(results.one, { values: ["v".repeat(100)], matchCount: 2 });
  assert.deepEqual(results.many, { values: ["m0", "m1", "m2"], matchCount: 0 });
  assert.equal(results.bad.error.length, 300);
  assert.deepEqual(sanitizeFieldResults(null, fieldSpecs, { maxMatches: 3, maxValueChars: 100 }).one, { values: [], matchCount: 0 });
});

test("sanitizePageHeight and sanitizeTitle accept only sane values", () => {
  assert.equal(sanitizePageHeight(1200), 1200);
  assert.equal(sanitizePageHeight(Infinity), 0);
  assert.equal(sanitizePageHeight("99"), 0);
  assert.equal(sanitizePageHeight(1e12), 1000000);
  assert.equal(sanitizeTitle("t".repeat(900)).length, 500);
  assert.equal(sanitizeTitle({}), "");
});

test("evaluateInIsolatedWorld runs the fixed function in a fresh isolated world of the main frame", async () => {
  const session = createFakeCdpSession({ evaluateResult: () => ({ result: { value: { ok: true } } }) });
  const result = await evaluateInIsolatedWorld(session.page, snapshotDocumentInPage, { maxNodes: 1 }, { timeoutMs: 1000 });
  assert.deepEqual(result, { ok: true });
  const methods = session.sent.map(([method]) => method);
  assert.deepEqual(methods, ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"]);
  const [, worldParams] = session.sent[1];
  assert.equal(worldParams.frameId, "main-frame");
  assert.equal(worldParams.grantUniveralAccess, false);
  const [, evaluateParams] = session.sent[2];
  assert.equal(evaluateParams.contextId, 77);
  assert.equal(evaluateParams.returnByValue, true);
  assert.equal(evaluateParams.timeout, 1000);
  assert.match(evaluateParams.expression, /^\(function snapshotDocumentInPage\(/);
  assert.equal(session.detached, true);
});

test("evaluateInIsolatedWorld fails with timeout when the page never answers, and detaches", async () => {
  const session = createFakeCdpSession({ evaluateResult: () => new Promise(() => {}) });
  const startedAt = Date.now();
  await assert.rejects(evaluateInIsolatedWorld(session.page, snapshotDocumentInPage, {}, { timeoutMs: 50 }), { kind: "timeout", retryable: true });
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(session.detached, true);
});

test("evaluateInIsolatedWorld reports an exception in the page function as browser_error", async () => {
  const session = createFakeCdpSession({ evaluateResult: () => ({ exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } } }) });
  await assert.rejects(evaluateInIsolatedWorld(session.page, snapshotDocumentInPage, {}, { timeoutMs: 1000 }), { kind: "browser_error", message: /boom/ });
});

function countNodes(node) {
  if (typeof node === "string") return 1;
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}
