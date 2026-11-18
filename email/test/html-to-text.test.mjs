import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_HTML_INPUT_CHARS, convertHtmlToText } from "../lib/html-to-text.mjs";

test("drops scripts, styles, head and comments with their content", () => {
  const html = '<html><head><title>T</title><style>p{color:red}</style></head><body><!-- secret --><p>Halo</p><script type="x">alert("x")</script><SCRIPT>bad()</SCRIPT></body></html>';
  assert.equal(convertHtmlToText(html), "Halo");
});

test("characters whose lowercase form is longer (İ) do not shift the script scan", () => {
  // "İ".toLowerCase() is two UTF-16 units; full-Unicode lowercasing would misalign every index after it.
  const html = "<p>İİİİ</p><script>steal()</script><p>after</p>";
  assert.equal(convertHtmlToText(html), "İİİİ\n\nafter");
});

test("keeps structure: paragraphs, line breaks, list items and table cells", () => {
  const html = "<p>Order <b>#12</b></p><br><ul><li>Kopi</li><li>Teh</li></ul><table><tr><td>A</td><td>B</td></tr></table>";
  assert.equal(convertHtmlToText(html), "Order #12\n\n- Kopi\n- Teh\n\nA B");
});

test("keeps http(s) and mailto link targets, drops javascript: links", () => {
  assert.equal(convertHtmlToText('<a href="https://toko.id/o?a=1&amp;b=2">Lihat</a>'), "Lihat (https://toko.id/o?a=1&b=2)");
  assert.equal(convertHtmlToText('<a href="https://toko.id">https://toko.id</a>'), "https://toko.id");
  assert.equal(convertHtmlToText('<a href="javascript:alert(1)">Klik</a>'), "Klik");
  assert.equal(convertHtmlToText('<img src="https://t.example/p.gif" alt="Logo">'), "[Logo]");
});

test("decodes named and numeric entities, leaves unknown ones", () => {
  assert.equal(convertHtmlToText("Rp&nbsp;10.000 &lt;b&gt; &#233;&#x1F600; &bogus; &#xD800;"), "Rp 10.000 <b> é😀 &bogus; &#xD800;");
});

test("an unclosed tag or script ends the text", () => {
  assert.equal(convertHtmlToText("Halo <b"), "Halo");
  assert.equal(convertHtmlToText("Halo <script>never closed"), "Halo");
  assert.equal(convertHtmlToText("<header>Kop</header><head>x</head>"), "Kop");
});

test("adversarial input stays linear and input is capped", () => {
  const started = Date.now();
  convertHtmlToText("<a ".repeat(400000));
  convertHtmlToText("<script".repeat(200000));
  convertHtmlToText("<!--".repeat(300000));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.ok(convertHtmlToText("x".repeat(MAX_HTML_INPUT_CHARS + 50)).length <= MAX_HTML_INPUT_CHARS);
});
