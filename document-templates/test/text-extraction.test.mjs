/**
 * Text read back out of a rendered PDF: letter-spaced labels must come out as
 * words (copy and paste, search, screen readers) and still be drawn with
 * their spacing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installTrackedText } from "../lib/tracked-text.mjs";
import { AS_TOOL, INVOICE_VALUES, SKIP_WITHOUT_LIBRARIES, readPageTextItems, readPageTexts, withDocumentRunner } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES };
const SPACED_LETTERS = /(?:^| )\p{Lu}(?: \p{Lu}){2,}(?: |$)/u;

function layoutTemplate(content) {
  return JSON.stringify({ format: "graphrt-document-template", version: 1, name: "labels", content });
}

test("the built-in invoice's letter-spaced labels are extracted as words, in English and Indonesian", options, () =>
  withDocumentRunner({}, async ({ runOperation }) => {
    const english = await runOperation("render_pdf", { values: { ...INVOICE_VALUES, language: "en", number: "INV-EN", seller: { ...INVOICE_VALUES.seller, tagline: "Studio desain" }, payment: { details: [{ label: "Bank", value: "Bank Contoh" }] } } }, AS_TOOL);
    const [englishText] = await readPageTexts(await readFile(english.data.path));
    for (const label of ["STUDIO DESAIN", "INVOICE", "FROM", "BILL TO", "DETAILS", "DESCRIPTION", "AMOUNT", "TOTAL DUE", "PAYMENT DETAILS", "PAGE 1 OF 1"]) assert.ok(englishText.includes(label), `${label} in: ${englishText}`);
    assert.doesNotMatch(englishText, SPACED_LETTERS);
    const indonesian = await runOperation("render_pdf", { values: INVOICE_VALUES }, AS_TOOL);
    const [indonesianText] = await readPageTexts(await readFile(indonesian.data.path));
    for (const label of ["DITAGIHKAN KEPADA", "DESKRIPSI", "TOTAL TAGIHAN", "HALAMAN 1 DARI 1"]) assert.ok(indonesianText.includes(label), `${label} in: ${indonesianText}`);
    assert.doesNotMatch(indonesianText, SPACED_LETTERS);
  }));

test("letter spacing keeps its look: the spaced label is wider by the spacing of each of its characters", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    const label = "TOTAL DUE";
    const spacing = 1.6;
    await writeFile(join(inputDirectory, "labels.json"), layoutTemplate([
      { text: label, fontSize: 6.8 },
      { text: label, fontSize: 6.8, characterSpacing: spacing },
      { text: label, fontSize: 6.8, characterSpacing: spacing, bold: true, font: "serif" },
      { text: "tightened text stays as it was", characterSpacing: -0.12 },
    ]));
    const result = await runOperation("render_pdf", { template: "labels.json", values: {}, file_name: "labels" }, AS_TOOL);
    const bytes = await readFile(result.data.path);
    const [items] = await readPageTextItems(bytes);
    const lines = items.filter((item) => item.text.trim() !== "");
    assert.deepEqual(lines.map((item) => item.text), [label, label, label, "tightened text stays as it was"]);
    const [plain, spaced] = lines;
    assert.equal(spaced.x, plain.x);
    assert.ok(Math.abs(spaced.width - plain.width - spacing * label.length) < 0.01, `plain ${plain.width}, spaced ${spaced.width}`);
    // Embedded fonts: sans as it is (plain and tightened text) and one widened copy each of sans and serif bold.
    assert.equal(bytes.toString("latin1").match(/\/Subtype \/CIDFontType2/g).length, 3);
  }));

test("tracked text: a document class without pdfkit's text drawing is left alone", () => {
  assert.equal(installTrackedText(undefined), false);
  assert.equal(installTrackedText(class {}), false);
  let drawn = null;
  class Document {
    _fragment(text, x, y, fragmentOptions) {
      drawn = { text, font: this._font, fragmentOptions };
    }
  }
  assert.equal(installTrackedText(Document), true);
  assert.equal(installTrackedText(Document), true);
  const document = new Document();
  // A standard (not embedded) font has no glyph subset to widen: the spacing is passed on untouched.
  document._font = { id: "F1" };
  document._fontSize = 10;
  document._fragment("LABEL", 1, 2, { characterSpacing: 2 });
  assert.deepEqual(drawn, { text: "LABEL", font: document._font, fragmentOptions: { characterSpacing: 2 } });
});
