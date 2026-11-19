/**
 * Review fixes: linear-time HTML stripping, own-property entity lookups, DOCTYPE skipping that honours quotes and
 * comments, http(s)-only links, strict dates and JSON Feed type checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToPlainText } from "../lib/html-text.mjs";
import { parseXml, textContent } from "../lib/xml-parser.mjs";
import { normalizeFeed, toIsoDate } from "../lib/feed-normalizer.mjs";

const OPTIONS = { includeContent: true, contentFormat: "text", maxContentChars: 1000 };

function timeIt(work) {
  const started = performance.now();
  const result = work();
  return { result, elapsedMs: performance.now() - started };
}

test("htmlToPlainText is linear on unclosed scripts, styles, comments and tags", () => {
  const hostileInputs = ["<script>".repeat(200000), "<style>".repeat(200000), "<!--".repeat(200000), "<a ".repeat(200000), "<br".repeat(200000), "&amp".repeat(200000)];
  for (const html of hostileInputs) {
    const { elapsedMs } = timeIt(() => htmlToPlainText(html));
    assert.ok(elapsedMs < 500, `${html.slice(0, 10)}… took ${Math.round(elapsedMs)} ms`);
  }
});

test("htmlToPlainText still drops scripts, styles and comments and keeps text", () => {
  assert.equal(htmlToPlainText("<p>A <b>b</b></p><script>x()</script><style>p{}</style><!-- c -->C<br>D"), "A b\nC\nD");
  assert.equal(htmlToPlainText("before<script>never closed"), "before");
  assert.equal(htmlToPlainText("a < b and c > d"), "a < b and c > d");
});

test("entity names that are Object.prototype keys stay literal", () => {
  assert.equal(htmlToPlainText("&constructor; &toString; &amp;"), "&constructor; &toString; &");
  assert.equal(textContent(parseXml("<a>&constructor;&hasOwnProperty;&lt;</a>")), "&constructor;&hasOwnProperty;<");
});

test("the DOCTYPE skip honours quoted strings and comments inside the internal subset", () => {
  const root = parseXml(`<!DOCTYPE r [ <!ENTITY a "]>"> <!-- ]> --> <!ENTITY b ']>'> ]><r>ok</r>`);
  assert.equal(textContent(root), "ok");
  const tricky = parseXml(`<!DOCTYPE r SYSTEM "x>y.dtd"><r>fine</r>`);
  assert.equal(textContent(tricky), "fine");
});

test("non-http(s) item and feed links and enclosure URLs are dropped", () => {
  const feed = `<rss><channel><title>t</title><link>javascript:alert(1)</link><item><title>i</title><link>javascript:alert(1)</link><guid>data:text/html,x</guid>
    <enclosure url="file:///etc/passwd" type="text/plain"/><enclosure url="https://ok.example/a.mp3" type="audio/mpeg"/></item></channel></rss>`;
  const { feed: channel, items } = normalizeFeed(feed, OPTIONS);
  assert.equal(channel.link, null);
  assert.equal(items[0].link, null);
  assert.deepEqual(items[0].enclosures.map((enclosure) => enclosure.url), ["https://ok.example/a.mp3"]);
});

test("dates: only RFC 822 and ISO 8601 are parsed; other text is kept raw", () => {
  assert.equal(toIsoDate("Wed, 18 Nov 2026 09:00:00 +0000"), "2026-11-18T09:00:00.000Z");
  assert.equal(toIsoDate("18 Nov 2026 09:00 GMT"), "2026-11-18T09:00:00.000Z");
  assert.equal(toIsoDate("2026-11-18T09:00:00+01:00"), "2026-11-18T08:00:00.000Z");
  assert.equal(toIsoDate("2026-11-18"), "2026-11-18T00:00:00.000Z");
  assert.equal(toIsoDate("1"), "1");
  assert.equal(toIsoDate("next tuesday 2026"), "next tuesday 2026");
  assert.equal(toIsoDate("Wed, 31 Feb 2026 09:00:00 GMT"), "Wed, 31 Feb 2026 09:00:00 GMT");
});

test("JSON Feed: ids must be strings or numbers, items objects, urls http(s)", () => {
  const document = JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    home_page_url: "javascript:alert(1)",
    items: [{ id: { nested: true }, url: "https://ok.example/1", title: 5 }, { id: 7, url: "ftp://x/y" }, "not an item", null],
  });
  const { feed, items } = normalizeFeed(document, OPTIONS);
  assert.equal(feed.link, null);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "https://ok.example/1");
  assert.equal(items[0].title, null);
  assert.equal(items[1].id, "7");
  assert.equal(items[1].link, null);
  assert.throws(() => normalizeFeed(JSON.stringify({ version: "https://jsonfeed.org/version/1", items: {} }), OPTIONS), { kind: "api_error" });
});
