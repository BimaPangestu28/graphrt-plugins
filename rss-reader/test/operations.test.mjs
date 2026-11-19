/**
 * read_feed and parse_feed: normalised items for RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed, fetched only from
 * public https hosts with a size cap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { decodeFeedBytes } from "../lib/text-decoding.mjs";
import { ATOM_FEED, JSON_FEED, RDF_FEED, RSS_FEED } from "./fixtures.mjs";

const AS_TOOL = { source: "tool" };
const publicResolver = async () => ["93.184.216.34"];

function createRunner(responses, { environment = {}, resolveHostAddresses = publicResolver } = {}) {
  const fetchImpl = createRecordingFetch(responses);
  return { runOperation: createOperationRunner(pluginDefinition, environment, { fetchImpl, resolveHostAddresses }), fetchImpl };
}

test("read_feed: RSS 2.0 channel and items are normalised", async () => {
  const { runOperation, fetchImpl } = createRunner([{ body: RSS_FEED, headers: { "content-type": "application/rss+xml" } }]);
  const { data } = await runOperation("read_feed", { url: "https://news.example.com/feed.xml" }, AS_TOOL);
  assert.equal(fetchImpl.calls[0].url, "https://news.example.com/feed.xml");
  assert.deepEqual(data.feed, { format: "rss", title: "Example News", link: "https://news.example.com/", description: "All the news", language: "en", updated: "2026-11-18T10:00:00.000Z" });
  assert.equal(data.items.length, 2);
  const [second, first] = data.items;
  assert.equal(second.id, "story-2");
  assert.equal(second.title, "Second story");
  assert.equal(second.link, "https://news.example.com/2");
  assert.equal(second.published, "2026-11-18T09:00:00.000Z");
  assert.equal(second.author, "Ann Writer");
  assert.deepEqual(second.categories, ["World", "Politics"]);
  assert.equal(second.summary, "Short & sweet");
  assert.equal(second.content, undefined);
  assert.deepEqual(second.enclosures, [{ url: "https://cdn.example.com/2.mp3", type: "audio/mpeg", length: 1234 }]);
  assert.equal(first.id, "https://news.example.com/1");
  assert.equal(data.truncated, false);
});

test("read_feed: include_content adds plain-text content (scripts dropped) or the HTML", async () => {
  const { runOperation } = createRunner([{ body: RSS_FEED }, { body: RSS_FEED }]);
  const asText = await runOperation("read_feed", { url: "https://news.example.com/feed.xml", include_content: true }, AS_TOOL);
  assert.equal(asText.data.items[0].content, "Full text here.");
  const asHtml = await runOperation("read_feed", { url: "https://news.example.com/feed.xml", include_content: true, content_format: "html" }, AS_TOOL);
  assert.match(asHtml.data.items[0].content, /<em>text<\/em>/);
});

test("parse_feed: Atom feeds, with alternate links, html titles and authors", async () => {
  const { runOperation } = createRunner([]);
  const { data } = await runOperation("parse_feed", { content: ATOM_FEED, include_content: true }, AS_TOOL);
  assert.equal(data.feed.format, "atom");
  assert.equal(data.feed.title, "Example Blog");
  assert.equal(data.feed.link, "https://blog.example.com/");
  assert.equal(data.feed.description, "Notes");
  const [entry] = data.items;
  assert.equal(entry.title, "Hello <World>");
  assert.equal(entry.link, "https://blog.example.com/hello");
  assert.equal(entry.id, "tag:blog.example.com,2026:1");
  assert.equal(entry.updated, "2026-11-18T07:00:00.000Z");
  assert.equal(entry.author, "Bo Author");
  assert.deepEqual(entry.categories, ["notes"]);
  assert.equal(entry.summary, "A summary");
  assert.equal(entry.content, "The content");
  assert.deepEqual(entry.enclosures, [{ url: "https://blog.example.com/hello.png", type: "image/png", length: 10 }]);
});

test("parse_feed: RSS 1.0 (RDF) items are siblings of the channel", async () => {
  const { runOperation } = createRunner([]);
  const { data } = await runOperation("parse_feed", { content: RDF_FEED }, AS_TOOL);
  assert.equal(data.feed.format, "rdf");
  assert.equal(data.feed.title, "Old Site");
  assert.deepEqual(data.items.map((item) => [item.title, item.published]), [["Item A", "2026-11-01T00:00:00.000Z"]]);
});

test("parse_feed: JSON Feed 1.1", async () => {
  const { runOperation } = createRunner([]);
  const { data } = await runOperation("parse_feed", { content: JSON_FEED, include_content: true }, AS_TOOL);
  assert.equal(data.feed.format, "json");
  assert.equal(data.feed.link, "https://json.example.com/");
  const [item] = data.items;
  assert.equal(item.author, "Cy");
  assert.deepEqual(item.categories, ["a", "b"]);
  assert.equal(item.content, "Hi there");
  assert.deepEqual(item.enclosures, [{ url: "https://json.example.com/1.mp3", type: "audio/mpeg", length: 99 }]);
});

test("parse_feed: JSON that is not a JSON Feed, and XML that is not a feed, are api_error", async () => {
  const { runOperation } = createRunner([]);
  await assert.rejects(runOperation("parse_feed", { content: "{\"hello\": 1}" }, AS_TOOL), { kind: "api_error", message: /JSON Feed/ });
  await assert.rejects(runOperation("parse_feed", { content: "<html><body/></html>" }, AS_TOOL), { kind: "api_error", message: /RSS, Atom/ });
});

test("max_items truncates; since keeps newer items (and undated ones)", async () => {
  const { runOperation } = createRunner([]);
  const limited = await runOperation("parse_feed", { content: RSS_FEED, max_items: 1 }, AS_TOOL);
  assert.equal(limited.data.items.length, 1);
  assert.equal(limited.data.truncated, true);
  const recent = await runOperation("parse_feed", { content: RSS_FEED, since: "2026-11-17T00:00:00Z" }, AS_TOOL);
  assert.deepEqual(recent.data.items.map((item) => item.title), ["Second story"]);
  await assert.rejects(runOperation("parse_feed", { content: RSS_FEED, since: "yesterday" }, AS_TOOL), { kind: "invalid_input" });
});

test("summaries and content are capped", async () => {
  const longFeed = RSS_FEED.replace("Plain summary", "word ".repeat(1000));
  const { runOperation } = createRunner([]);
  const { data } = await runOperation("parse_feed", { content: longFeed, max_content_chars: 1000 }, AS_TOOL);
  assert.ok(data.items[1].summary.length <= 1001);
  assert.ok(data.items[1].summary.endsWith("…"));
});

test("read_feed: http, internal hosts and redirects to them are refused before any request", async () => {
  const { runOperation, fetchImpl } = createRunner([], { resolveHostAddresses: async () => ["10.0.0.5"] });
  await assert.rejects(runOperation("read_feed", { url: "http://news.example.com/feed" }, AS_TOOL), { kind: "invalid_input" });
  await assert.rejects(runOperation("read_feed", { url: "https://intranet.example.com/feed" }, AS_TOOL), { kind: "invalid_input", message: /private/ });
  await assert.rejects(runOperation("read_feed", { url: "https://127.0.0.1/feed" }, AS_TOOL), { kind: "invalid_input" });
  assert.equal(fetchImpl.calls.length, 0);
  const redirected = createRunner([{ status: 302, headers: { location: "https://169.254.169.254/latest" } }], { resolveHostAddresses: async (host) => (host === "169.254.169.254" ? ["169.254.169.254"] : ["93.184.216.34"]) });
  await assert.rejects(redirected.runOperation("read_feed", { url: "https://news.example.com/feed" }, AS_TOOL), { kind: "invalid_input" });
  assert.equal(redirected.fetchImpl.calls.length, 1);
});

test("read_feed: a feed over RSS_READER_MAX_FEED_BYTES is refused; HTTP errors are api_error", async () => {
  const big = createRunner([{ body: `<rss>${"x".repeat(70000)}</rss>` }], { environment: { RSS_READER_MAX_FEED_BYTES: "65536" } });
  await assert.rejects(big.runOperation("read_feed", { url: "https://news.example.com/feed" }, AS_TOOL), { kind: "invalid_input", message: /65536/ });
  const missing = createRunner([{ status: 404, body: "nope" }]);
  await assert.rejects(missing.runOperation("read_feed", { url: "https://news.example.com/feed" }, AS_TOOL), { kind: "api_error", message: /404/ });
});

test("read_feed: network failures are retryable network_error", async () => {
  const failingFetch = async () => {
    throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
  };
  const runOperation = createOperationRunner(pluginDefinition, {}, { fetchImpl: failingFetch, resolveHostAddresses: publicResolver });
  await assert.rejects(runOperation("read_feed", { url: "https://news.example.com/feed" }, AS_TOOL), { kind: "network_error", retryable: true });
});

test("decodeFeedBytes: BOMs and the XML declaration's encoding", () => {
  assert.equal(decodeFeedBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e])), "<a/>");
  assert.equal(decodeFeedBytes(Buffer.from("﻿<a/>", "utf16le")), "<a/>");
  const latin1 = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><a>'), Buffer.from([0xe9]), Buffer.from("</a>")]);
  assert.match(decodeFeedBytes(latin1), /<a>é<\/a>/);
  assert.match(decodeFeedBytes(Buffer.from('<?xml version="1.0" encoding="no-such-charset"?><a/>')), /<a\/>/);
});

test("manifest: network but no secrets, both operations are tools", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.permissions.network, true);
  assert.equal(manifest.permissions.secrets, false);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["read_feed", "parse_feed"]);
});
