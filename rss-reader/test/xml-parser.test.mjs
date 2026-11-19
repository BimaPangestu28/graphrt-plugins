/**
 * The strict, non-validating XML parser: no DTD processing and no entity expansion beyond the five predefined
 * entities and character references.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, textContent } from "../lib/xml-parser.mjs";

test("elements, attributes, text, CDATA, comments and processing instructions", () => {
  const root = parseXml(`<?xml version="1.0"?><!-- c --><rss version="2.0"><channel><title>A &amp; B</title><description><![CDATA[<b>bold</b> & raw]]></description><item a='1' b="x &lt; y"/></channel></rss>`);
  assert.equal(root.name, "rss");
  assert.equal(root.attributes.version, "2.0");
  const channel = root.children[0];
  assert.equal(textContent(channel.children[0]), "A & B");
  assert.equal(textContent(channel.children[1]), "<b>bold</b> & raw");
  assert.deepEqual(channel.children[2].attributes, { a: "1", b: "x < y" });
});

test("character references decode; invalid code points become U+FFFD", () => {
  const root = parseXml("<a>&#65;&#x42;&#0;&#xD800;&quot;&apos;&gt;</a>");
  assert.equal(textContent(root), "AB��\"'>");
});

test("a DOCTYPE and its internal subset are skipped; declared entities are never expanded", () => {
  const billionLaughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<lolz>&lol3;</lolz>`;
  const root = parseXml(billionLaughs);
  assert.equal(textContent(root), "&lol3;");
});

test("external entities are never fetched or read", () => {
  const root = parseXml(`<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><foo>&xxe;</foo>`);
  assert.equal(textContent(root), "&xxe;");
});

test("a public DOCTYPE without a subset (old RSS 0.91) is fine", () => {
  const root = parseXml(`<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd"><rss version="0.91"><channel/></rss>`);
  assert.equal(root.name, "rss");
});

test("malformed documents are refused", () => {
  for (const broken of ["<a><b></a>", "<a>", "text", "<a></a><b></b>", "<a b=c></a>", "<a><!ENTITY x 'y'></a>", "<a><!-- open</a>", ""]) {
    assert.throws(() => parseXml(broken), { kind: "api_error" }, broken);
  }
});

test("nesting depth and element count are bounded", () => {
  assert.throws(() => parseXml(`${"<a>".repeat(200)}${"</a>".repeat(200)}`), { message: /deep/ });
  assert.throws(() => parseXml(`<r>${"<i/>".repeat(50)}</r>`, { maxElements: 10 }), { message: /elements/ });
});

test("namespaced names are kept as written", () => {
  const root = parseXml(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><content:encoded>x</content:encoded></rss>`);
  assert.equal(root.children[0].name, "content:encoded");
});
