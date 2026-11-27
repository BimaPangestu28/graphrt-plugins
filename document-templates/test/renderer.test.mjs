/**
 * Renderer parts that need no PDF: font fallback per character and the
 * declarative table layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllCharactersDrawable, buildFontTable, loadFonts, splitByFont } from "../lib/fonts.mjs";
import { buildTableLayout } from "../lib/pdf-renderer.mjs";
import { SKIP_WITHOUT_LIBRARIES } from "./helpers.mjs";

const isLatin = (codePoint) => codePoint < 0x250;
const isKana = (codePoint) => codePoint >= 0x3040 && codePoint <= 0x30ff;
const families = {
  sans: { normal: "sans.ttf", bold: "sans-bold.ttf", covers: isLatin, isExtra: false },
  serif: { normal: "serif.ttf", bold: "serif-bold.ttf", covers: (codePoint) => isLatin(codePoint) || isKana(codePoint), isExtra: false },
  "Kana-Regular": { normal: ["kana.ttc", "KanaPS"], bold: ["kana.ttc", "KanaPS"], covers: isKana, isExtra: true },
};

test("font fallback: text stays whole when its font has every character", () => {
  const missing = new Set();
  assert.equal(splitByFont("Invoice no. 7\n\tline two", "sans", families, missing), "Invoice no. 7\n\tline two");
  assert.equal(splitByFont("", "sans", families, missing), "");
  assert.equal(missing.size, 0);
});

test("font fallback: characters the font lacks go to an extra font, as runs; built-in families are never borrowed", () => {
  const missing = new Set();
  assert.deepEqual(splitByFont("PT カタカナ Tbk", "sans", families, missing), [{ text: "PT " }, { text: "カタカナ", font: "Kana-Regular" }, { text: " Tbk" }]);
  assert.equal(splitByFont("カナ", "Kana-Regular", families, missing), "カナ");
  assert.equal(missing.size, 0);
});

test("font fallback: characters no font has are reported by name, never drawn as boxes", () => {
  const missing = new Set();
  splitByFont("株式会社 カナ 😀", "sans", families, missing);
  assert.deepEqual([...missing], ["株", "式", "会", "社", "😀"]);
  assert.throws(() => assertAllCharactersDrawable(missing), (error) => error.kind === "invalid_input" && /株 \(U\+682A\), 式 \(U\+5F0F\).*😀 \(U\+1F600\).*DOCUMENT_TEMPLATES_FONTS/.test(error.message));
  assert.doesNotThrow(() => assertAllCharactersDrawable(new Set()));
  const many = new Set(Array.from({ length: 30 }, (_unused, index) => String.fromCodePoint(0x4e00 + index)));
  assert.throws(() => assertAllCharactersDrawable(many), /and 18 more/);
});

test("font table: every style has a file; a collection keeps its face name", () => {
  assert.deepEqual(buildFontTable(families)["Kana-Regular"], { normal: ["kana.ttc", "KanaPS"], bold: ["kana.ttc", "KanaPS"], italics: ["kana.ttc", "KanaPS"], bolditalics: ["kana.ttc", "KanaPS"] });
  assert.deepEqual(buildFontTable(families).sans, { normal: "sans.ttf", bold: "sans-bold.ttf", italics: "sans.ttf", bolditalics: "sans-bold.ttf" });
});

test("bundled fonts: Latin, Vietnamese, Cyrillic, Greek and currency signs are covered; an unreadable extra font is a setup error", { skip: SKIP_WITHOUT_LIBRARIES }, async () => {
  const { families: bundled, files } = await loadFonts([]);
  assert.deepEqual(Object.keys(bundled), ["sans", "serif"]);
  assert.equal(Object.keys(files).length, 4);
  for (const familyName of ["sans", "serif"]) {
    const missing = new Set();
    splitByFont("Rp € £ ¥ $ — – Việt Nam ỹ Ω Привет ğ ž ñ ç ß №", familyName, bundled, missing);
    assert.deepEqual([...missing], [], familyName);
  }
  const missing = new Set();
  splitByFont("日本", "sans", bundled, missing);
  assert.equal(missing.size, 2);
  await assert.rejects(loadFonts(["/nonexistent/NotoSansJP-Regular.ttf"]), (error) => error.kind === "setup_required" && /NotoSansJP-Regular\.ttf/.test(error.message) && !error.message.includes("/nonexistent"));
});

test("table layout: lines per mode, header line, padding and column gap", () => {
  const node = { table: { headerRows: 1, widths: ["*", 50, 50], body: [[], [], []] } };
  const widths = (layout) => [0, 1, 2, 3].map((lineIndex) => buildTableLayout(layout).hLineWidth(lineIndex, node));
  assert.deepEqual(widths(undefined), [0, 0, 0, 0]);
  assert.deepEqual(widths({ lines: "rows", line_width: 0.5, header_line_width: 1 }), [0, 1, 0.5, 0.5]);
  assert.deepEqual(widths({ lines: "header", line_width: 0.5 }), [0, 0.5, 0, 0]);
  assert.deepEqual(widths({ lines: "grid", line_width: 2 }), [2, 2, 2, 2]);
  const layout = buildTableLayout({ lines: "grid", line_color: "#111111", header_line_color: "#222222", padding: [1, 2, 3, 4], column_gap: 10 });
  assert.deepEqual([layout.vLineWidth(), buildTableLayout({ lines: "rows" }).vLineWidth()], [0.5, 0]);
  assert.deepEqual([layout.hLineColor(1, node), layout.hLineColor(2, node)], ["#222222", "#111111"]);
  assert.deepEqual([0, 1, 2].map((columnIndex) => [layout.paddingLeft(columnIndex, node), layout.paddingRight(columnIndex, node)]), [[1, 8], [6, 8], [6, 3]]);
  assert.deepEqual([layout.paddingTop(), layout.paddingBottom(), buildTableLayout({ padding: 7 }).paddingLeft(0, node)], [2, 4, 7]);
});
