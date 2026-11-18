import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReadableContent,
  collapseWhitespace,
  collectLinks,
  removeBoilerplate,
  renderContent,
  selectContentRoot,
  selectMainContent,
  truncateText,
} from "../lib/readable.mjs";
import { element } from "./helpers.mjs";

const LONG_TEXT = "This sentence is long enough to be real content on the page. ".repeat(5);

test("selectMainContent prefers <main> / [role=main] with the most text", () => {
  const main = element("div", { role: "main" }, element("p", {}, LONG_TEXT));
  const root = element("body", {}, element("nav", {}, "menu"), element("main", {}, "tiny"), main);
  assert.equal(selectMainContent(root), main);
});

test("selectMainContent uses a dominant <article> when there is no main", () => {
  const article = element("article", {}, element("p", {}, LONG_TEXT));
  const root = element("body", {}, element("div", {}, "sidebar"), article, element("article", {}, "short teaser"));
  assert.equal(selectMainContent(root), article);
});

test("a feed of similar articles falls back to the body", () => {
  const articles = [1, 2, 3].map((index) => element("article", {}, `Story ${index}: ${LONG_TEXT}`));
  const root = element("body", {}, ...articles);
  assert.equal(selectMainContent(root), root);
});

test("a main element with almost no text falls back to the body", () => {
  const root = element("body", {}, element("main", {}, "Loading…"), element("div", {}, LONG_TEXT, LONG_TEXT));
  assert.equal(selectMainContent(root), root);
});

test("removeBoilerplate drops navigation, footers, asides, forms, buttons and banner-like elements", () => {
  const root = element(
    "body",
    {},
    element("header", {}, element("a", { href: "https://e.com/" }, "Logo")),
    element("nav", {}, "Menu"),
    element("div", { role: "navigation" }, "Breadcrumbs by role"),
    element("div", { class: "cookie-banner" }, "We use cookies"),
    element("div", { id: "sidebar_left" }, "Sidebar"),
    element("article", {}, element("header", {}, element("h1", {}, "Title")), element("p", {}, "Body"), element("button", {}, "Share")),
    element("aside", {}, "Related"),
    element("form", {}, "Search"),
    element("footer", {}, "Footer"),
    element("div", { class: "commentary" }, "Kept: a class token that only contains a boilerplate word"),
  );
  assert.equal(renderContent(removeBoilerplate(root)), "Title\n\nBody\n\nKept: a class token that only contains a boilerplate word");
});

test("plain text collapses whitespace and separates blocks", () => {
  const root = element(
    "div",
    {},
    element("h2", {}, "  Heading \n  "),
    element("p", {}, "one\n   two\t three"),
    element("p", {}, "four", element("br"), "five"),
    element("div", {}, "a ", element("span", {}, "b"), element("em", {}, " c")),
  );
  assert.equal(renderContent(root), "Heading\n\none two three\n\nfour\nfive\n\na b c");
});

test("preformatted text keeps its line breaks and indentation", () => {
  const root = element("div", {}, element("p", {}, "Code:"), element("pre", {}, element("code", {}, "if (x) {\n    run();\n}\n")));
  assert.equal(renderContent(root), "Code:\n\nif (x) {\n    run();\n}");
  assert.equal(renderContent(root, { markdown: true }), "Code:\n\n```\nif (x) {\n    run();\n}\n```");
});

test("markdown renders headings, emphasis, inline code and links", () => {
  const root = element(
    "div",
    {},
    element("h1", {}, "Title"),
    element("h3", {}, "Sub"),
    element("p", {}, "A ", element("strong", {}, "bold"), " and ", element("em", {}, "soft"), " ", element("code", {}, "x()"), " ", element("a", { href: "https://example.com/a b(1)" }, "link [x]"), "."),
    element("p", {}, element("a", { href: "javascript:alert(1)" }, "script link"), " ", element("a", { href: "https://example.com/" }, "  ")),
  );
  assert.equal(
    renderContent(root, { markdown: true }),
    "# Title\n\n### Sub\n\nA **bold** and _soft_ `x()` [link \\[x\\]](https://example.com/a%20b%281%29).\n\nscript link",
  );
});

test("markdown renders nested and ordered lists", () => {
  const root = element(
    "div",
    {},
    element("ul", {}, element("li", {}, "One"), element("li", {}, "Two", element("ol", {}, element("li", {}, "Two A"), element("li", {}, "Two B")))),
  );
  assert.equal(renderContent(root, { markdown: true }), "- One\n- Two\n  1. Two A\n  2. Two B");
  assert.equal(renderContent(root), "- One\n- Two\n  1. Two A\n  2. Two B");
});

test("markdown renders blockquotes, rules and tables", () => {
  const root = element(
    "div",
    {},
    element("blockquote", {}, element("p", {}, "Quoted"), element("p", {}, "Twice")),
    element("hr"),
    element("table", {}, element("tr", {}, element("th", {}, "Name"), element("th", {}, "Price")), element("tr", {}, element("td", {}, "Tea | hot"), element("td", {}, "3"))),
  );
  assert.equal(renderContent(root, { markdown: true }), "> Quoted\n>\n> Twice\n\n---\n\n| Name | Price |\n| --- | --- |\n| Tea \\| hot | 3 |");
  assert.equal(renderContent(root), "Quoted\n\nTwice\n\nName | Price\nTea | hot | 3");
});

test("buildReadableContent uses the main content unless asked for the whole body", () => {
  const root = element("body", {}, element("nav", {}, "Menu"), element("main", {}, element("p", {}, LONG_TEXT)));
  assert.equal(buildReadableContent(selectContentRoot(root, { mainContentOnly: true })).text, LONG_TEXT.trim());
  assert.match(buildReadableContent(selectContentRoot(root, { mainContentOnly: false })).text, /^Menu\n/);
  assert.deepEqual(buildReadableContent(null, { markdown: true }), { text: "", markdown: "" });
});

test("collectLinks resolves, de-duplicates, drops fragments and non-http links", () => {
  const root = element(
    "body",
    {},
    element("a", { href: "https://example.com/a#one" }, " First\n link "),
    element("a", { href: "https://example.com/a#two" }, "Duplicate"),
    element("a", { href: "/relative" }, "Relative"),
    element("a", { href: "mailto:x@example.com" }, "Mail"),
    element("a", { href: "javascript:void(0)" }, "JS"),
    element("a", {}, "No href"),
  );
  assert.deepEqual(collectLinks(root, "https://example.com/dir/page"), [
    { url: "https://example.com/a", text: "First link" },
    { url: "https://example.com/relative", text: "Relative" },
  ]);
});

test("truncateText cuts at a word boundary and marks the cut", () => {
  assert.deepEqual(truncateText("short", 10), { text: "short", truncated: false });
  assert.deepEqual(truncateText("one two three four", 15), { text: "one two three…", truncated: true });
  assert.deepEqual(truncateText("abcdefghij", 5), { text: "abcde…", truncated: true });
});

test("deeply nested snapshots do not overflow the stack", () => {
  let node = element("p", {}, "deep");
  for (let depth = 0; depth < 5000; depth += 1) node = element("div", {}, node);
  assert.equal(typeof renderContent(node), "string");
  assert.equal(collapseWhitespace("  a \n b "), "a b");
});
