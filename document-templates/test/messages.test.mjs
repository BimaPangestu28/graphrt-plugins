/**
 * The language of the messages a person reads: English by default, Indonesian for a document in Indonesian
 * (its values, its look or the saved brand) and for next_number with `language: id`. Only the text changes:
 * the kind of the error stays the same in both languages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { describeValuePath, readMessageLanguage, toPlainProblem, translateMessage, withMessageLanguage } from "../lib/message-language.mjs";
import { AS_NODE, AS_TOOL, INVOICE_VALUES, SKIP_WITHOUT_LIBRARIES, buildDocx, buildFormPdf, withDocumentRunner } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES };
const ENGLISH_VALUES = { ...INVOICE_VALUES, language: "en" };

test("value paths in words, in English and Indonesian", () => {
  for (const [path, english, indonesian] of [
    ["items[0].unit_price", "the unit price of item 1", "harga satuan item 1"],
    ["items[2]", "item 3", "item 3"],
    ["items[0].discount.percent", "the discount percent of item 1", "persen diskon item 1"],
    ["taxes[1].rate", "the rate of tax 2", "tarif pajak ke-2"],
    ["client.name", "client name", "nama klien"],
    ["values.items", "items", "daftar item"],
    ["currency", "currency", "mata uang"],
    ["some_field", "some field", "some field"],
  ]) assert.deepEqual([describeValuePath(path, "en"), describeValuePath(path, "id")], [english, indonesian], path);
  assert.deepEqual(["id", " EN ", "fr", null, 3].map(readMessageLanguage), ["id", "en", null, null, null]);
});

test("every message a person reads about the details, the number, the file or the folder has an Indonesian text", () => {
  // Messages exactly as the plugin raises them.
  const messages = [
    "`items[0].unit_price` must be a plain number such as 1500000 or 1500000.50 (no thousands separators or currency symbols), got \"seratus ribu\"",
    "`items[0].amount` is too large",
    "`values.items` must be a list of line items",
    "`values.items` has 501 entries, over the limit of 500",
    "`items[1]` must be an object with a description and an amount, or a quantity and unit_price",
    "`items[1]` needs `amount`, or `quantity` and `unit_price`",
    "`items[0].amount` is 100 but quantity x unit_price less its discount is 90; correct one of them or leave `amount` out",
    "`items[0].unit_price` is required when `quantity` is given",
    "`discount` takes `percent` or `amount`, not both",
    "`discount` must be a number, or an object with `percent` or `amount`",
    "`shipping` must not be negative",
    "`taxes` must be a list such as [{\"name\": \"PPN\", \"rate\": 11}]",
    "`taxes[0]` needs `name` and `rate` (a percentage; negative for a withholding)",
    "`taxes[0].rate` must be a percentage from -100 to 100",
    "`currency` must be a three-letter code such as IDR or USD, got \"Rp\"",
    "`decimals` must be an integer from 0 to 4, got 9",
    "`language` must be one of en, id, got \"fr\"",
    "`date` must be a date such as 2026-11-27, got \"27/11/2026\"",
    "Pass `values` or `values_file`, not both",
    "`values` is required: the document's values as an object, or `values_file` for a .json file",
    "The invoice template needs these values: seller.name, client.name, items. describe_template shows every field with an example",
    "Give the document's `number` in `values` or a `number_pattern`, not both",
    "`pattern` must be a text of at most 60 characters such as INV-{YYYY}-{SEQ:4}",
    "`pattern` needs exactly one {SEQ} token (or {SEQ:4} for four digits), e.g. INV-{YYYY}-{SEQ:4}",
    "`pattern` may use letters, digits, spaces, . _ - / # and the tokens {YYYY} {YY} {MM} {DD} {ROMAN} {SEQ}",
    "The numbering file already has 2000 counters; remove old ones from .document-templates/numbering.json",
    ".document-templates/numbering.json is damaged (unexpected content); repair or remove it, then pass `start_at` to continue the numbering",
    "Another call is issuing a number and did not finish within 5 seconds; try again",
    "The document was not saved, and the number INV-2026-0002 could not be given back (EROFS); the next document gets the number after it",
    "Other documents kept taking the next number of \"INV-{SEQ}\"; nothing was saved and no number was used. Try again",
    "\"2026/11/INV-2026-0001.pdf\" already exists; nothing was saved. Use another number or file name, or `if_exists: number` to keep both",
    "\"INV-1.pdf\" and 99 numbered copies already exist; nothing was saved",
    "Could not save the document: ENOSPC",
    "The folder \"a/b\" leads outside DOCUMENT_TEMPLATES_OUTPUT_DIR or is not a folder",
    "`folder` uses the unknown token {nope}; tokens: {YYYY} {MM} and {values.some.field}",
    "`file_name` resolves to an empty name",
    "Set DOCUMENT_TEMPLATES_OUTPUT_DIR to the folder (absolute, or ~/...) where documents are saved",
    "No file at \"logo.png\" inside DOCUMENT_TEMPLATES_INPUT_DIRS",
    "The logo \"logo.png\" is 3.1 MB; a logo may be at most 2 MB. Save a smaller version of it (about 800 pixels wide is plenty)",
    "The logo \"logo.png\" is not a usable picture: it is damaged or smaller than 16 pixels",
    "The document has 250 pages, over the 200-page limit (DOCUMENT_TEMPLATES_MAX_PAGES)",
    "The PDF has no form field named \"Nope\". Its fields: InvoiceNo, Client",
    "The value for the form field \"Client\" must be a text, a number or true/false",
    "Pass `fields` or `fields_file`, not both",
  ];
  for (const message of messages) {
    const indonesian = translateMessage(message, "id");
    assert.notEqual(indonesian, message, message);
    assert.doesNotMatch(indonesian, /\b(must|should|the|is required|got|not both|already exists)\b/, indonesian);
    assert.equal(translateMessage(message, "en"), message);
  }
  assert.equal(translateMessage("Something only a developer reads", "id"), "Something only a developer reads");
  assert.equal(toPlainProblem("`items[0].unit_price` is required when `quantity` is given", "en"), "The unit price of item 1 is required when quantity is given");
});

test("withMessageLanguage changes only the text: kind, retryable and class stay", async () => {
  const raised = new PluginError("`currency` must be a three-letter code such as IDR or USD, got \"Rp\"", { kind: "invalid_input", retryable: false });
  await assert.rejects(withMessageLanguage(async () => "id", async () => { throw raised; }), (error) => error === raised && error instanceof PluginError && error.kind === "invalid_input" && error.retryable === false && error.message === "Mata uang harus berupa kode tiga huruf seperti IDR atau USD, bukan \"Rp\"");
  // A failure that is not a PluginError is left alone, and the language is not even asked for.
  let isAsked = false;
  await assert.rejects(withMessageLanguage(async () => { isAsked = true; return "id"; }, async () => { throw new TypeError("boom"); }), /^TypeError: boom$/);
  assert.equal(isAsked, false);
});

test("the language comes from the values, then the look, then the saved brand; next_number takes `language`", options, () =>
  withDocumentRunner({}, async ({ runOperation }) => {
    const badCurrency = (values, extra = {}) => runOperation("render_pdf", { values: { ...values, currency: "Rp" }, ...extra }, AS_TOOL);
    await assert.rejects(badCurrency(ENGLISH_VALUES), { kind: "invalid_input", message: /^`currency` must be a three-letter code/ });
    await assert.rejects(badCurrency(INVOICE_VALUES), { kind: "invalid_input", message: /^Mata uang harus berupa kode tiga huruf/ });
    const { language: _language, ...withoutLanguage } = INVOICE_VALUES;
    await assert.rejects(badCurrency(withoutLanguage), { message: /^`currency` must be/ }, "no language anywhere: English");
    await assert.rejects(badCurrency(withoutLanguage, { look: { language: "id" } }), { message: /^Mata uang harus/ });
    await assert.rejects(runOperation("next_number", { pattern: "no sequence" }, AS_TOOL), { kind: "invalid_input", message: /^`pattern` needs exactly one \{SEQ\}/ });
    await assert.rejects(runOperation("next_number", { pattern: "no sequence", language: "id" }, AS_TOOL), { kind: "invalid_input", message: /^Pola nomor harus punya tepat satu \{SEQ\}/ });

    // A saved brand in Indonesian makes Indonesian the default; what a call names still wins.
    await runOperation("save_brand", { look: { language: "id" } }, AS_TOOL);
    await assert.rejects(badCurrency(withoutLanguage), { message: /^Mata uang harus/ });
    await assert.rejects(badCurrency(ENGLISH_VALUES), { message: /^`currency` must be/ });
    await assert.rejects(runOperation("next_number", { pattern: "no sequence" }, AS_TOOL), { message: /^Pola nomor harus/ });
    await assert.rejects(runOperation("next_number", { pattern: "no sequence", language: "en" }, AS_TOOL), { message: /^`pattern` needs/ });
    await assert.rejects(badCurrency(withoutLanguage, { brand: "none" }), { message: /^`currency` must be/ }, "brand: none uses no brand");
  }));

test("fill_docx and fill_pdf_form write their messages in the document's language too", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "form.pdf"), await buildFormPdf());
    await writeFile(join(inputDirectory, "letter.docx"), buildDocx({ paragraphs: ["{{client.name}}"] }));
    await assert.rejects(runOperation("fill_pdf_form", { template: "form.pdf", fields: { Nope: "x" }, values: INVOICE_VALUES }, AS_TOOL), { kind: "invalid_input", message: /^PDF ini tidak punya kotak isian bernama "Nope"/ });
    await assert.rejects(runOperation("fill_pdf_form", { template: "form.pdf", fields: { Nope: "x" }, values: ENGLISH_VALUES }, AS_TOOL), { kind: "invalid_input", message: /^The PDF has no form field named "Nope"/ });
    await assert.rejects(runOperation("fill_pdf_form", { template: "form.pdf", fields: {}, fields_file: "x.json", values: INVOICE_VALUES }, AS_TOOL), { message: /^Berikan isian formulir atau file isian formulir, tidak keduanya$/ });
    await assert.rejects(runOperation("fill_docx", { template: "letter.docx", values: { ...INVOICE_VALUES, currency: "Rp" } }, AS_TOOL), { kind: "invalid_input", message: /^Mata uang harus/ });
    await assert.rejects(runOperation("fill_docx", { template: "letter.docx", values: { ...INVOICE_VALUES, currency: "Rp" }, folder: "x" }, AS_NODE), { message: /^Mata uang harus/ });
    await assert.rejects(runOperation("fill_docx", { template: "missing.docx", values: INVOICE_VALUES }, AS_TOOL), { kind: "not_found", message: /^Tidak ada file "missing\.docx"/ });
  }));
