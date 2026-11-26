// The shared conformance fixtures (copied from graphrt's crates/graphrt-ui/fixtures) and unit cases for the
// JavaScript port of graphrt_ui::validate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { UiBlockError, checkImageUrl, checkLinkUrl, validateUiBlock } from "../lib/ui-blocks.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures");

async function readFixtures(kind) {
  const names = (await readdir(join(FIXTURES, kind))).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => [name, JSON.parse(await readFile(join(FIXTURES, kind, name), "utf8"))]));
}

test("every valid fixture passes", async () => {
  const fixtures = await readFixtures("valid");
  assert.ok(fixtures.length >= 4);
  for (const [name, block] of fixtures) assert.doesNotThrow(() => validateUiBlock(block), name);
});

test("every invalid fixture fails with the message graphrt-ui gives", async () => {
  for (const [name, { error, block }] of await readFixtures("invalid")) {
    assert.throws(() => validateUiBlock(block), (thrown) => thrown instanceof UiBlockError && thrown.message.includes(error), name);
  }
});

const chart = (extra = {}) => ({ $ui: "chart", version: 1, type: "bar", x: { values: ["Jan", "Feb"] }, series: [{ name: "Sales", values: [1, 2] }], ...extra });
const messageOf = (block) => {
  try {
    validateUiBlock(block);
    return null;
  } catch (error) {
    return error.message;
  }
};

test("chart options must fit the chart type", () => {
  assert.match(messageOf(chart({ type: "line", stacked: true })), /stacked/);
  assert.match(messageOf(chart({ type: "line", horizontal: true })), /horizontal/);
  assert.match(messageOf(chart({ y: { format: "currency", currency: "rupiah" } })), /ISO 4217/);
  assert.match(messageOf(chart({ y: { min: 5, max: 1 } })), /below/);
  assert.match(messageOf(chart({ type: "donut", series: [{ name: "a", values: [1, 2] }, { name: "b", values: [1, 2] }] })), /exactly one series/);
  assert.equal(messageOf(chart({ type: "area", stacked: true, y: { format: "compact" } })), null);
});

test("errors carry a JSON Pointer to the bad value", () => {
  assert.throws(() => validateUiBlock(chart({ series: [{ name: "a", values: [1, "2"] }] })), { path: "/series/0/values/1" });
  const table = { $ui: "table", version: 1, columns: [{ key: "a/b", label: "A" }], rows: [{ "a/b": [1] }] };
  assert.throws(() => validateUiBlock(table), { path: "/rows/0/a~1b" });
});

test("cards reject scripts, unknown properties and unsafe inline actions", () => {
  const card = (body, actions = []) => ({ $ui: "adaptive_card", version: 1, card: { type: "AdaptiveCard", version: "1.5", body, actions } });
  assert.match(messageOf(card([{ type: "TextBlock", text: "x", onclick: "alert(1)" }])), /unknown field `onclick`/);
  assert.match(messageOf(card([{ type: "Input.Text", id: "q", inlineAction: { type: "Action.OpenUrl", url: "file:///etc" } }])), /https or mailto/);
  assert.match(messageOf(card([], [{ type: "Action.Http", url: "https://a.example" }])), /not supported/);
  assert.equal(messageOf(card([], [{ type: "Action.Http", fallback: "drop" }])), null);
  let nested = { type: "TextBlock", text: "deep" };
  for (let level = 0; level < 14; level += 1) nested = { type: "Container", items: [nested] };
  assert.match(messageOf(card([nested])), /levels deep/);
});

test("the block size is capped", () => {
  const rows = Array.from({ length: 3000 }, (_, i) => ({ name: `row ${i} ${"x".repeat(80)}` }));
  assert.match(messageOf({ $ui: "table", version: 1, columns: [{ key: "name", label: "Name" }], rows }), /bytes/);
});

test("URL policy matches graphrt-ui", () => {
  for (const url of ["data:image/png;base64,iVBORw0KGgo=", "https://example.com/a.png"]) assert.doesNotThrow(() => checkImageUrl(url, ""));
  for (const url of ["data:image/svg+xml;base64,PHN2Zz4=", "http://example.com/a.png", "javascript:alert(1)", "https://user@evil.example/a.png"]) {
    assert.throws(() => checkImageUrl(url, ""), UiBlockError, url);
  }
  for (const url of ["mailto:sales@example.com", "HTTPS://example.com"]) assert.doesNotThrow(() => checkLinkUrl(url, ""));
  for (const url of ["https://", "file:///etc/passwd", "https://example.com/a b"]) assert.throws(() => checkLinkUrl(url, ""), UiBlockError, url);
});
