import { test } from "node:test";
import assert from "node:assert/strict";
import { hostnameOf, isHttpUrl, MAX_URL_LENGTH, parseNavigableUrl, shortenUrl } from "../lib/url-policy.mjs";

test("parseNavigableUrl accepts http and https and drops the fragment", () => {
  assert.deepEqual(parseNavigableUrl(" https://Example.com/a?b=1#top "), { href: "https://example.com/a?b=1", hostname: "example.com", origin: "https://example.com" });
  assert.equal(parseNavigableUrl("http://example.com").href, "http://example.com/");
});

for (const refusedUrl of ["file:///etc/passwd", "data:text/html,<h1>x</h1>", "javascript:alert(1)", "ftp://example.com/", "about:blank", "blob:https://example.com/uuid", "chrome://settings", "view-source:https://example.com", "ws://example.com/"]) {
  test(`parseNavigableUrl refuses ${refusedUrl.split(":")[0]}: URLs`, () => {
    assert.throws(() => parseNavigableUrl(refusedUrl), { kind: "invalid_input" });
  });
}

test("parseNavigableUrl refuses credentials, relative and over-long URLs", () => {
  assert.throws(() => parseNavigableUrl("https://user:pass@example.com/"), { kind: "invalid_input", message: /user name or password/ });
  assert.throws(() => parseNavigableUrl("/relative/path"), { kind: "invalid_input" });
  assert.throws(() => parseNavigableUrl(""), { kind: "invalid_input" });
  assert.throws(() => parseNavigableUrl(`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`), { kind: "invalid_input" });
});

test("numeric and hex IPv4 forms are normalised, so the host check sees the real address", () => {
  assert.equal(parseNavigableUrl("http://2130706433/").hostname, "127.0.0.1");
  assert.equal(parseNavigableUrl("http://0x7f.1/").hostname, "127.0.0.1");
  assert.equal(parseNavigableUrl("http://[::ffff:7f00:1]/").hostname, "::ffff:7f00:1");
});

test("isHttpUrl and hostnameOf only accept http(s)", () => {
  assert.equal(isHttpUrl("https://example.com"), true);
  assert.equal(isHttpUrl("data:,x"), false);
  assert.equal(isHttpUrl("not a url"), false);
  assert.equal(hostnameOf("http://[::1]:8080/x"), "::1");
  assert.equal(hostnameOf("file:///x"), null);
});

test("shortenUrl cuts long URLs with an ellipsis", () => {
  assert.equal(shortenUrl("abcdef", 4), "abc…");
  assert.equal(shortenUrl("abc", 4), "abc");
});
