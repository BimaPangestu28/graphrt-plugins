/**
 * The placeholder language and layout templates: what a template can say,
 * and what it is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Scope, evaluateExpression, interpolate, isTruthy, listPlaceholders, parseExpression } from "../lib/expressions.mjs";
import { readFormatSettings } from "../lib/formatting.mjs";
import { PAGE_COUNT_MARKER, PAGE_NUMBER_MARKER, expandLayout, listMissingFields, listTemplatePlaceholders, parseLayoutTemplate } from "../lib/layout-template.mjs";
import { loadBuiltInTemplate } from "../lib/template-library.mjs";
import { calculateInvoice } from "../lib/invoice-totals.mjs";
import { INVOICE_VALUES } from "./helpers.mjs";

const settings = readFormatSettings({ language: "id" });
const scope = new Scope({ client: { name: "PT Maju", tags: ["a", "b"] }, total: "1500000", date: "2026-07-31", empty: "", zero: 0, lines: ["x", "y"] });
const fill = (text, variables = scope) => interpolate(text, variables, settings);

function layout(content, extra = {}) {
  return { format: "graphrt-document-template", version: 1, name: "test", content, ...extra };
}

function expand(template, values = {}) {
  return expandLayout(template, values, settings, { today: "2026-11-27" });
}

test("placeholders: paths, filters, comparisons and negation", () => {
  const cases = [
    ["{{client.name}}", "PT Maju"],
    ["Kepada {{ client.name | upper }}!", "Kepada PT MAJU!"],
    ["{{total | money}}", "Rp 1.500.000"],
    ["{{total | money:code}}", "IDR 1.500.000"],
    ["{{total | amount}}", "1.500.000"],
    ["{{total | number:2}}", "1.500.000,00"],
    ["{{date | date}} / {{date | date:short}}", "31 Juli 2026 / 31/07/2026"],
    ["{{missing.deep.path}}", ""],
    ["{{empty | default:\"-\"}}", "-"],
    ["{{missing | default:'n/a: x|y'}}", "n/a: x|y"],
    ["{{lines}}", "x\ny"],
    ["{{client.tags | join:\" + \"}}", "a + b"],
    ["{{client.tags.1}}", "b"],
    ["{{zero | percent}}", "0%"],
    ["{{client.name == \"PT Maju\"}} {{client.name != 'PT Maju'}} {{not empty}}", "true false true"],
    ["no placeholders", "no placeholders"],
  ];
  for (const [template, expected] of cases) assert.equal(fill(template), expected, template);
});

test("placeholders: a loop scope shadows the document's values and falls back to them", () => {
  const inner = scope.child({ item: { name: "Baris" }, total: "5" });
  assert.equal(fill("{{item.name}} {{total}} {{client.name}}", inner), "Baris 5 PT Maju");
});

test("placeholders: nothing but own data is reachable, and nothing is executed", () => {
  for (const hostile of ["{{__proto__}}", "{{constructor.name}}", "{{client.constructor}}", "{{client.__proto__.x}}", "{{a.prototype}}", "{{process.env}}"]) {
    const result = (() => {
      try {
        return fill(hostile);
      } catch (error) {
        return error.kind;
      }
    })();
    assert.ok(result === "" || result === "invalid_input", `${hostile} -> ${result}`);
  }
  assert.equal(fill("{{client.name.length}}"), "");
  assert.equal(fill("{{lines.length}}"), "2");
  for (const code of ["{{1 + 1}}", "{{client.name()}}", "{{client['name']}}", "{{a; b}}", "{{require('fs')}}", "{{}}", "{{total | eval}}", "{{total | money | nope}}"]) {
    assert.throws(() => fill(code), { kind: "invalid_input" }, code);
  }
});

test("placeholders: a group of fields is not a text, an unclosed placeholder is an error, values may contain braces", () => {
  assert.throws(() => fill("{{client}}"), (error) => error.kind === "invalid_input" && /client\.name/.test(error.message));
  assert.throws(() => fill("Total {{total"), { kind: "invalid_input" });
  assert.equal(fill("{{note}}", new Scope({ note: "use {{braces}} freely" })), "use {{braces}} freely");
  assert.deepEqual(listPlaceholders("{{ a.b }} and {{c | money}}"), ["a.b", "c | money"]);
});

test("truth: empty text, zero, false, null and empty lists or objects are absent", () => {
  for (const absent of ["", 0, false, null, undefined, [], {}]) assert.equal(isTruthy(absent), false, JSON.stringify(absent));
  for (const present of ["0", "x", 1, true, [0], { a: 1 }]) assert.equal(isTruthy(present), true, JSON.stringify(present));
  assert.equal(evaluateExpression(parseExpression("not client.tags"), scope, settings), false);
});

test("layout: loops unroll, conditions pick a branch, chunks pair entries, one text loops once", () => {
  const plan = expand(layout([
    { $each: "items", as: "row", do: { text: "{{loop.number}}/{{row.name}}{{loop.last}}" } },
    { $if: "show", then: "yes", else: "no" },
    { $if: "hidden", then: "never" },
    { table: { widths: ["*", { $if: "wide", then: 50 }], body: [{ $each: "pairs", as: "pair", chunk: 2, do: ["{{pair.0}}", { $if: "wide", then: "{{pair.1}}" }] }] } },
    { stack: [{ $each: "note", as: "line", do: "{{line}}" }] },
  ]), { items: [{ name: "a" }, { name: "b" }], show: true, wide: true, pairs: ["p", "q", "r"], note: "single" });
  assert.deepEqual(plan.content.slice(0, 3), [{ text: "1/afalse" }, { text: "2/btrue" }, { text: "yes" }]);
  assert.deepEqual(plan.content[3].table, { body: [[{ text: "p" }, { text: "q" }], [{ text: "r" }, { text: "" }]], widths: ["*", 50] });
  assert.deepEqual(plan.content[4], { stack: [{ text: "single" }] });
  assert.equal(expand(layout([{ $each: "nothing", do: "x" }])).content.length, 0);
});

test("layout: images become indexes into a list of paths for the caller to resolve; page markers survive for the footer", () => {
  const plan = expand(layout([{ image: "{{logo}}", fit: [100, 40] }, { image: "logo.png" }, { image: "other.png", width: 50 }], { footer: { text: "{{page.number}}/{{page.count}}" } }), { logo: "logo.png" });
  assert.deepEqual(plan.imagePaths, ["logo.png", "other.png"]);
  assert.deepEqual(plan.content.map((node) => node.image), [0, 0, 1]);
  assert.equal(plan.footer.text, `${PAGE_NUMBER_MARKER}/${PAGE_COUNT_MARKER}`);
  assert.throws(() => expand(layout([{ image: "{{logo}}" }])), (error) => /\$if/.test(error.message));
  assert.throws(() => expand(layout(Array.from({ length: 21 }, (_unused, index) => ({ image: `image-${index}.png` })))), /at most 20/);
});

test("layout: labels follow the language and the values may override them", () => {
  const template = layout(["{{labels.title}} {{labels.total}}"], { labels: { en: { title: "Invoice", total: "Total" }, id: { title: "Faktur", total: "Jumlah" } } });
  assert.equal(expand(template).content[0].text, "Faktur Jumlah");
  assert.equal(expand(template, { labels: { title: "Kuitansi" } }).content[0].text, "Kuitansi Jumlah");
  assert.equal(expandLayout(template, {}, readFormatSettings({}), { today: "2026-11-27" }).content[0].text, "Invoice Total");
});

test("layout: only known properties with valid values are accepted", () => {
  const refused = [
    [{ svg: "<svg/>" }, /svg/],
    [{ text: "x", link: "https://example.com" }, /link/],
    [{ text: "x", font: "../../etc/passwd" }, /font/],
    [{ text: "x", color: "red" }, /color/],
    [{ text: "x", fontSize: "12" }, /fontSize/],
    [{ text: "x", fontFeatures: ["tabular"] }, /fontFeatures/],
    [{ text: "x", style: "undefined-style" }, /style/],
    [{ text: [{ text: "x", image: "a.png" }] }, /image/],
    [{ table: { body: [["a", "b"], ["c"]] } }, /1 cells but the table has 2 columns/],
    [{ table: { body: [["a"]], file: "/etc/passwd" } }, /file/],
    [{ table: { body: [["a"]] }, layout: { hLineWidth: "function(){}" } }, /hLineWidth/],
    [{ canvas: [{ type: "polyline", points: [] }] }, /type|points/],
    [{ $each: "items" }, /loop/],
    [{ stack: [{ $each: "items", as: "bad name", do: "x" }] }, /as/],
    [{ stack: [{ $each: "client", do: "x" }] }, /not a list/],
    [{ stack: [{ $each: "items", chunk: 1, do: "x" }] }, /chunk/],
    [{ $if: "x" }, /condition/],
    [["nested list"], /text or an object/],
    [{ image: 5 }, /must be a text/],
  ];
  for (const [node, pattern] of refused) {
    assert.throws(() => expand(layout([node]), { items: [1], client: { name: "x" } }), (error) => error.kind === "invalid_input" && pattern.test(error.message), JSON.stringify(node));
  }
  assert.throws(() => expand(layout([], { page: { size: "A4", attachments: [] } })), /attachments/);
  assert.throws(() => expand(layout([], { defaults: { font: "sans", images: {} } })), /images/);
  assert.throws(() => expand(layout([], { watermark: { text: "x", angle: 999 } })), /angle/);
});

test("layout: size limits stop runaway templates", () => {
  const big = Array.from({ length: 400 }, (_unused, index) => index);
  const nestedLoops = layout([{ stack: [{ $each: "big", as: "a", do: { stack: [{ $each: "big", as: "b", do: "{{a}}{{b}}" }] } }] }]);
  assert.throws(() => expand(nestedLoops, { big }), /more than 100000 parts/);
  let deep = "leaf";
  for (let level = 0; level < 60; level += 1) deep = { stack: [deep] };
  assert.throws(() => expand(layout([deep])), /nested deeper/);
  assert.throws(() => expand(layout(["{{long}}"]), { long: "x".repeat(100001) }), /longer than/);
});

test("layout files: format, version and top-level keys are checked", () => {
  const valid = JSON.stringify(layout([]));
  assert.equal(parseLayoutTemplate(valid, "t").name, "test");
  const broken = ["{", "[]", JSON.stringify({ content: [] }), JSON.stringify(layout([], { version: 2 })), JSON.stringify(layout([], { script: "x" })), JSON.stringify({ ...layout([]), content: "x" }), JSON.stringify(layout([], { calculate: "everything" }))];
  for (const text of broken) assert.throws(() => parseLayoutTemplate(text, "t"), { kind: "invalid_input" }, text.slice(0, 50));
});

test("the built-in invoice: required fields, placeholders, and a plan with the calculated figures", async () => {
  const template = await loadBuiltInTemplate("invoice");
  assert.deepEqual(listMissingFields(template, { number: "X", seller: {} }), ["seller.name", "client.name", "items"]);
  assert.deepEqual(listMissingFields(template, template.sample_values), []);
  assert.ok(listTemplatePlaceholders(template).includes("totals.balance_due | money"));
  const plan = expand(template, calculateInvoice({ ...INVOICE_VALUES, labels: { tax: "Pajak" } }, 0));
  const text = JSON.stringify(plan);
  for (const expected of ["CV Kenanga Digital", "PT Maju Bersama", "27 November 2026", "Jatuh tempo", "3,5 hari", "2.000.000", "7.000.000", "Rp 10.000.000", "PPN (11%)", "Rp 1.100.000", "Rp 11.100.000", "TOTAL TAGIHAN", "INV-2026-0007"]) {
    assert.ok(text.includes(expected), expected);
  }
  const itemTable = plan.content.find((node) => node.table?.headerRows === 1).table;
  assert.equal(itemTable.widths.length, 4);
  assert.equal(itemTable.body.length, 3);
  assert.equal(plan.bottom, null);
  assert.equal(plan.watermark, null);
  assert.deepEqual(plan.info, { title: "Invoice INV-2026-0007", author: "CV Kenanga Digital" });
});
