/**
 * The operations end to end, with the engine in this process: real PDFs and
 * Word files are produced in temp directories and read back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { readDocumentSettings } from "../lib/client.mjs";
import { runEngineTask } from "../lib/document-engine.mjs";
import { AS_NODE, AS_TOOL, INVOICE_VALUES, SKIP_WITHOUT_LIBRARIES, buildDocx, buildFormPdf, buildPlainPdf, buildPng, pdfLib, readDocxParagraphs, readPageTexts, withDocumentRunner } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES };
const LAYOUT = { format: "graphrt-document-template", version: 1, name: "letter", content: [{ text: "Kepada {{client.name}}", bold: true }, "{{body}}"] };

test("manifest: local only, no secrets, ten tools, the documents folder first, and descriptions without setting names", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["list_templates", "describe_template", "save_template_copy", "next_number", "save_brand", "show_brand", "check_values", "render_pdf", "fill_pdf_form", "fill_docx"]);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  assert.deepEqual(manifest.permissions.env, ["DOCUMENT_TEMPLATES_OUTPUT_DIR", "DOCUMENT_TEMPLATES_INPUT_DIRS", "DOCUMENT_TEMPLATES_MAX_INPUT_BYTES", "DOCUMENT_TEMPLATES_MAX_OUTPUT_BYTES", "DOCUMENT_TEMPLATES_MAX_PAGES", "DOCUMENT_TEMPLATES_MAX_FORM_FIELDS", "DOCUMENT_TEMPLATES_TIMEOUT_MS", "DOCUMENT_TEMPLATES_MAX_MEMORY_MB", "DOCUMENT_TEMPLATES_FONTS"]);
  assert.ok(manifest.limits.timeout_ms > readDocumentSettings({}).timeoutMs);
  // What the app shows to people who set up and build agents: no variable names, no "node".
  for (const text of JSON.stringify(manifest).match(/"description":"(?:[^"\\]|\\.)*"/g)) assert.doesNotMatch(text, /DOCUMENT_TEMPLATES_|\bnodes?\b|AcroForm/, text);
  // Every setting but the documents folder has a default.
  assert.deepEqual(readDocumentSettings({}), { ...readDocumentSettings({}), maxPages: 200, timeoutMs: 60000, maxMemoryMb: 768, extraFontPaths: [] });
});

test("settings: limits and font files are validated", () => {
  assert.deepEqual(readDocumentSettings({ HOME: "/home/someone", DOCUMENT_TEMPLATES_FONTS: "~/fonts/NotoSansJP-Regular.ttf, /fonts/collection.TTC" }).extraFontPaths, [join("/home/someone", "fonts", "NotoSansJP-Regular.ttf"), resolve("/fonts/collection.TTC")]);
  for (const environment of [{ DOCUMENT_TEMPLATES_FONTS: "relative.ttf" }, { DOCUMENT_TEMPLATES_FONTS: "/fonts/font.woff2" }, { DOCUMENT_TEMPLATES_FONTS: Array(9).fill("/f.ttf").join(",") }, { DOCUMENT_TEMPLATES_MAX_PAGES: "0" }, { DOCUMENT_TEMPLATES_TIMEOUT_MS: "999999999" }]) {
    assert.throws(() => readDocumentSettings(environment), { kind: "invalid_input" }, JSON.stringify(environment));
  }
});

test("list_templates and describe_template need no configuration for the built-in invoice", async () => {
  await withDocumentRunner({ environment: { DOCUMENT_TEMPLATES_INPUT_DIRS: "", DOCUMENT_TEMPLATES_OUTPUT_DIR: "" } }, async ({ runOperation }) => {
    const listing = await runOperation("list_templates", {}, AS_TOOL);
    assert.deepEqual(listing.data.built_in.map((template) => [template.name, template.operation, template.languages]), [["invoice", "render_pdf", ["en", "id"]]]);
    const described = await runOperation("describe_template", {}, AS_TOOL);
    assert.deepEqual([described.data.kind, described.data.built_in, described.data.layout], ["layout", true, undefined]);
    assert.ok(described.data.fields.some((field) => field.name === "client.name" && field.required));
    assert.equal(described.data.sample_values.items.length, 2);
    assert.equal((await runOperation("describe_template", { template: "Invoice", include_layout: "true" }, AS_TOOL)).data.layout.format, "graphrt-document-template");
    await assert.rejects(runOperation("render_pdf", { values: INVOICE_VALUES }, AS_TOOL), { kind: "setup_required" });
  });
});

test("render_pdf: the built-in invoice becomes a filed PDF with the calculated figures as real text", options, () =>
  withDocumentRunner({}, async ({ runOperation, outputDirectory }) => {
    const result = await runOperation("render_pdf", { values: JSON.stringify(INVOICE_VALUES) }, AS_TOOL);
    assert.deepEqual({ ...result.data, size_bytes: 0 }, {
      path: join(outputDirectory, "2026", "11", "INV-2026-0007.pdf"), folder_path: join(outputDirectory, "2026", "11"), relative_path: "2026/11/INV-2026-0007.pdf", folder: "2026/11", file_name: "INV-2026-0007.pdf", size_bytes: 0, replaced_existing: false,
      template: "invoice", number: "INV-2026-0007",
      totals: { currency: "IDR", subtotal: "10000000", discount: "0", tax_total: "1100000", total: "11100000", amount_paid: "0", balance_due: "11100000", total_text: "Rp 11.100.000", balance_due_text: "Rp 11.100.000" },
      page_count: 1,
    });
    const bytes = await readFile(result.data.path);
    const [pageText] = await readPageTexts(bytes);
    for (const expected of ["CV Kenanga Digital", "PT Maju Bersama", "Jakarta 10110", "27 November 2026", "Desain antarmuka", "3,5 hari", "2.000.000", "7.000.000", "PPN (11%)", "Rp 1.100.000", "Rp 11.100.000", "HALAMAN 1 DARI 1"]) {
      assert.ok(pageText.includes(expected), `${expected} in: ${pageText}`);
    }
    const document = await pdfLib.PDFDocument.load(bytes);
    assert.deepEqual([document.getTitle(), document.getAuthor(), Math.round(document.getPage(0).getWidth())], ["Invoice INV-2026-0007", "CV Kenanga Digital", 595]);
  }));

test("render_pdf: many items continue over pages with the table header repeated, and the page cap applies", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory, outputDirectory }) => {
    const items = Array.from({ length: 70 }, (_unused, index) => ({ description: `Layanan nomor ${index + 1}`, amount: 100000 }));
    await writeFile(join(inputDirectory, "big.json"), JSON.stringify({ ...INVOICE_VALUES, items, taxes: [], notes: "Terima kasih." }));
    const result = await runOperation("render_pdf", { values_file: "big.json", folder: "Invoices/{client}", file_name: "{number} {client}" }, AS_TOOL);
    assert.equal(result.data.relative_path, "Invoices/PT Maju Bersama/INV-2026-0007 PT Maju Bersama.pdf");
    assert.ok(result.data.page_count >= 3);
    assert.equal(result.data.totals.total_text, "Rp 7.000.000");
    const pageTexts = await readPageTexts(await readFile(result.data.path));
    assert.equal(pageTexts.length, result.data.page_count);
    for (const pageText of pageTexts.slice(0, 3)) assert.ok(pageText.includes("DESKRIPSI"), pageText.slice(0, 120));
    assert.ok(pageTexts.at(-1).includes("Terima kasih.") && pageTexts.at(-1).includes(`HALAMAN ${pageTexts.length} DARI ${pageTexts.length}`));
    assert.ok(pageTexts.join(" ").includes("Layanan nomor 70"));
    await withDocumentRunner({ environment: { DOCUMENT_TEMPLATES_INPUT_DIRS: inputDirectory, DOCUMENT_TEMPLATES_OUTPUT_DIR: outputDirectory, DOCUMENT_TEMPLATES_MAX_PAGES: "2" } }, async (capped) => {
      await assert.rejects(capped.runOperation("render_pdf", { values_file: "big.json", file_name: "capped" }, AS_TOOL), (error) => error.kind === "invalid_input" && /DOCUMENT_TEMPLATES_MAX_PAGES/.test(error.message));
      assert.deepEqual(await readdir(outputDirectory), ["Invoices"]);
    });
  }));

test("render_pdf: an existing document is kept; a tool may not overwrite, a node may", options, () =>
  withDocumentRunner({}, async ({ runOperation }) => {
    const first = await runOperation("render_pdf", { values: INVOICE_VALUES }, AS_TOOL);
    const original = await readFile(first.data.path);
    // The invoice is in Indonesian, so is the message; the kind stays the same.
    await assert.rejects(runOperation("render_pdf", { values: INVOICE_VALUES }, AS_TOOL), (error) => error.kind === "invalid_input" && /^"2026\/11\/INV-2026-0007\.pdf" sudah ada; tidak ada yang disimpan/.test(error.message));
    await assert.rejects(runOperation("render_pdf", { values: { ...INVOICE_VALUES, language: "en" } }, AS_TOOL), (error) => error.kind === "invalid_input" && /already exists/.test(error.message));
    await assert.rejects(runOperation("render_pdf", { values: INVOICE_VALUES, if_exists: "overwrite" }, AS_TOOL), { kind: "permission_denied" });
    assert.deepEqual(await readFile(first.data.path), original);
    assert.equal((await runOperation("render_pdf", { values: INVOICE_VALUES, if_exists: "number" }, AS_TOOL)).data.file_name, "INV-2026-0007-2.pdf");
    const replaced = await runOperation("render_pdf", { values: { ...INVOICE_VALUES, client: { name: "PT Lain" } }, if_exists: "overwrite" }, AS_NODE);
    assert.equal(replaced.data.replaced_existing, true);
    assert.ok((await readPageTexts(await readFile(first.data.path)))[0].includes("PT Lain"));
  }));

test("render_pdf: a taken file name or a missing output folder is noticed before the document is drawn", options, async () => {
  let taskCount = 0;
  const countingTask = (task, payload) => {
    taskCount += 1;
    return runEngineTask(task, structuredClone(payload));
  };
  await withDocumentRunner({ runTask: countingTask }, async ({ runOperation }) => {
    await runOperation("render_pdf", { values: INVOICE_VALUES }, AS_TOOL);
    await assert.rejects(runOperation("render_pdf", { values: INVOICE_VALUES }, AS_TOOL), /sudah ada/);
    assert.equal(taskCount, 1);
  });
  await withDocumentRunner({ runTask: countingTask, environment: { DOCUMENT_TEMPLATES_OUTPUT_DIR: "" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("render_pdf", { values: INVOICE_VALUES }, AS_TOOL), { kind: "setup_required" });
    assert.equal(taskCount, 1);
  });
});

test("render_pdf: missing values, bad numbers and bad file names are refused before anything is written", options, () =>
  withDocumentRunner({}, async ({ runOperation, outputDirectory }) => {
    const refused = [
      [{ values: { number: "X" } }, /needs these values: seller\.name, client\.name, items/],
      [{ values: { ...INVOICE_VALUES, items: [{ description: "x", amount: "1.500.000" }] } }, /^Nilai item 1 harus berupa angka biasa/],
      [{ values: { ...INVOICE_VALUES, language: "en", items: [{ description: "x", amount: "1.500.000" }] } }, /^`items\[0\]\.amount` must be a plain number/],
      [{ values: { ...INVOICE_VALUES, currency: "RUPIAH" } }, /^Mata uang harus berupa kode tiga huruf/],
      [{ values: INVOICE_VALUES, folder: "{nope}" }, /penanda \{nope\} yang tidak dikenal/],
      [{ values: INVOICE_VALUES, values_file: "x.json" }, /tidak keduanya/],
      [{}, /`values` is required/],
      [{ values: "[1,2]" }, /values/],
      [{ values: INVOICE_VALUES, template: "report.docx" }, /fill_docx/],
      [{ values: INVOICE_VALUES, template: "nothing.xlsx" }, /\.json, \.docx, \.dotx atau \.pdf/],
      [{ values: { ...INVOICE_VALUES, client: { name: "株式会社 東京" } } }, /^Tidak ada font yang punya huruf ini: 株 \(U\+682A\)/],
      [{ values: { ...INVOICE_VALUES, language: "en", client: { name: "株式会社 東京" } } }, /^No available font has these characters: 株 \(U\+682A\)/],
    ];
    for (const [args, pattern] of refused) await assert.rejects(runOperation("render_pdf", args, AS_TOOL), (error) => error.kind === "invalid_input" && pattern.test(error.message), JSON.stringify(args).slice(0, 80));
    await assert.rejects(runOperation("render_pdf", { values: INVOICE_VALUES, template: "missing.json" }, AS_TOOL), { kind: "not_found" });
    assert.deepEqual(await readdir(outputDirectory), []);
  }));

test("render_pdf: your own layout, a logo and a letterhead background, all from the allowed directories only", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory, outsideDirectory }) => {
    await writeFile(join(inputDirectory, "letter.json"), JSON.stringify({ ...LAYOUT, content: [{ image: "{{logo}}", width: 40 }, ...LAYOUT.content], footer: { text: "{{page.number}} / {{page.count}}", alignment: "center" } }));
    await writeFile(join(inputDirectory, "logo.png"), buildPng());
    await writeFile(join(inputDirectory, "fake.png"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await writeFile(join(inputDirectory, "broken.png"), Buffer.concat([buildPng().subarray(0, 40), Buffer.alloc(30, 7)]));
    await writeFile(join(outsideDirectory, "secret.png"), buildPng());
    await symlink(join(outsideDirectory, "secret.png"), join(inputDirectory, "link.png"));
    await writeFile(join(inputDirectory, "letterhead.pdf"), await buildPlainPdf(2));
    const values = { client: { name: "Ibu Sari" }, body: "Привет, Việt Nam, Ελλάδα — € £", logo: "logo.png", items: ["not invoice items: this layout does not calculate"] };
    const plain = await runOperation("render_pdf", { template: "letter.json", values, file_name: "plain" }, AS_TOOL);
    assert.deepEqual([plain.data.relative_path, plain.data.template, plain.data.number, plain.data.totals], ["2026/11/plain.pdf", "letter", null, undefined]);
    assert.ok((await readPageTexts(await readFile(plain.data.path)))[0].includes("Kepada Ibu Sari Привет, Việt Nam, Ελλάδα — € £ 1 / 1"));
    const onLetterhead = await runOperation("render_pdf", { template: "letter.json", values, background: "letterhead.pdf", file_name: "letterhead" }, AS_TOOL);
    const letterheadText = (await readPageTexts(await readFile(onLetterhead.data.path)))[0];
    assert.ok(letterheadText.includes("Letterhead page 1") && letterheadText.includes("Kepada Ibu Sari"), letterheadText);
    for (const [logo, kind] of [["fake.png", "invalid_input"], ["broken.png", "invalid_input"], ["link.png", "not_found"], [join(outsideDirectory, "secret.png"), "not_found"], ["../outside/secret.png", "not_found"]]) {
      await assert.rejects(runOperation("render_pdf", { template: "letter.json", values: { ...values, logo }, file_name: "never" }, AS_TOOL), { kind }, logo);
    }
    await assert.rejects(runOperation("render_pdf", { template: "letter.json", values, background: "logo.png", file_name: "never" }, AS_TOOL), /not a PDF/);
    await assert.rejects(runOperation("render_pdf", { template: join(outsideDirectory, "secret.png").replace(".png", ".json"), values }, AS_TOOL), { kind: "not_found" });
  }));

test("fill_pdf_form: fields are filled from values and calculated totals; names and kinds are checked", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "form.pdf"), await buildFormPdf());
    await writeFile(join(inputDirectory, "plain.pdf"), await buildPlainPdf());
    await writeFile(join(inputDirectory, "map.json"), JSON.stringify({ InvoiceNo: "{{number}}", Client: "{{client.name}}", Total: "{{totals.total | money}}", Paid: true }));
    const described = await runOperation("describe_template", { template: "form.pdf" }, AS_TOOL);
    assert.deepEqual([described.data.kind, described.data.operation, described.data.fields.map((field) => `${field.name}:${field.kind}`)], ["pdf_form", "fill_pdf_form", ["InvoiceNo:text", "Client:text", "Total:text", "Notes:text", "Paid:checkbox"]]);
    const editable = await runOperation("fill_pdf_form", { template: "form.pdf", fields_file: "map.json", values: INVOICE_VALUES, flatten: false }, AS_TOOL);
    assert.deepEqual([editable.data.relative_path, editable.data.filled_fields, editable.data.empty_fields, editable.data.totals.total], ["2026/11/INV-2026-0007.pdf", ["InvoiceNo", "Client", "Total", "Paid"], ["Notes"], "11100000"]);
    const form = (await pdfLib.PDFDocument.load(await readFile(editable.data.path))).getForm();
    assert.deepEqual([form.getTextField("InvoiceNo").getText(), form.getTextField("Client").getText(), form.getTextField("Total").getText(), form.getCheckBox("Paid").isChecked()], ["INV-2026-0007", "PT Maju Bersama", "Rp 11.100.000", true]);
    const flattened = await runOperation("fill_pdf_form", { template: "form.pdf", fields: { Client: "Ünïcode Привет", Notes: "Lunas" }, file_name: "flat" }, AS_TOOL);
    const flatDocument = await pdfLib.PDFDocument.load(await readFile(flattened.data.path));
    assert.equal(flatDocument.getForm().getFields().length, 0);
    assert.equal(flatDocument.getPage(0).node.Annots(), undefined, "no annotation may point at a deleted form widget");
    assert.ok((await readPageTexts(await readFile(flattened.data.path)))[0].includes("Ünïcode Привет"));
    const refused = [
      [{ template: "form.pdf", fields: { Nope: "x" } }, /no form field named "Nope"\. Its fields: InvoiceNo, Client/],
      [{ template: "form.pdf", fields: { Client: { nested: true } } }, /must be a text/],
      [{ template: "form.pdf" }, /`fields` is required/],
      [{ template: "form.pdf", fields: {} }, /1 to 10000/],
      [{ template: "plain.pdf", fields: { Client: "x" } }, /no fillable form fields/],
      [{ template: "invoice", fields: { Client: "x" } }, /render_pdf/],
    ];
    for (const [args, pattern] of refused) await assert.rejects(runOperation("fill_pdf_form", { file_name: "never", ...args }, AS_TOOL), (error) => error.kind === "invalid_input" && pattern.test(error.message), JSON.stringify(args));
    const plain = await runOperation("describe_template", { template: "plain.pdf" }, AS_TOOL);
    assert.deepEqual([plain.data.kind, plain.data.is_form, plain.data.operation], ["pdf", false, null]);
    assert.match(plain.data.hint, /background/);
  }));

test("fill_docx: placeholders, a repeating table row and conditions; the result is a Word file", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    const template = buildDocx({
      paragraphs: ["Invoice {{number}} untuk {{client.name | upper}}", "Tanggal {{date | date}}", "{{#flags.has_taxes}}Termasuk pajak{{/flags.has_taxes}}{{^flags.has_discount}}Tanpa diskon{{/flags.has_discount}}", "Total {{totals.total | money}} <&> {{seller.name}}"],
      rows: [["Deskripsi", "Jumlah"], ["{{#items}}{{number}}. {{description}}", "{{amount | amount}}{{/items}}"]],
    });
    await writeFile(join(inputDirectory, "invoice.docx"), template);
    const described = await runOperation("describe_template", { template: "invoice.docx" }, AS_TOOL);
    assert.deepEqual([described.data.kind, described.data.operation], ["docx", "fill_docx"]);
    assert.ok(described.data.placeholders.includes("client.name | upper") && described.data.sections.includes("items"), JSON.stringify(described.data));
    const result = await runOperation("fill_docx", { template: "invoice.docx", values: { ...INVOICE_VALUES, seller: { name: "A & B <Tbk>" } }, folder: "Word" }, AS_TOOL);
    assert.deepEqual([result.data.relative_path, result.data.totals.total_text], ["Word/INV-2026-0007.docx", "Rp 11.100.000"]);
    assert.deepEqual(readDocxParagraphs(await readFile(result.data.path)), [
      "Invoice INV-2026-0007 untuk PT MAJU BERSAMA", "Tanggal 27 November 2026", "Termasuk pajakTanpa diskon", "Total Rp 11.100.000 <&> A & B <Tbk>",
      "Deskripsi", "Jumlah", "1. Desain antarmuka", "3.000.000", "2. Pengembangan", "7.000.000",
    ]);
  }));

test("fill_docx: files that are not plain Word templates, and malformed placeholders, are refused", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    const files = {
      "text.docx": Buffer.from("not a zip at all, just text padded to be long enough"),
      "macro.docx": buildDocx({ paragraphs: ["x"], extraFiles: { "word/vbaProject.bin": "macro" } }),
      "unclosed.docx": buildDocx({ paragraphs: ["Halo {{client.name"] }),
      "rawxml.docx": buildDocx({ paragraphs: ["{{@raw}}"] }),
      "code.docx": buildDocx({ paragraphs: ["{{1 + 1}}"] }),
      "openloop.docx": buildDocx({ paragraphs: ["{{#items}}never closed"] }),
    };
    for (const [fileName, bytes] of Object.entries(files)) await writeFile(join(inputDirectory, fileName), bytes);
    for (const fileName of ["text.docx", "macro.docx", "unclosed.docx", "rawxml.docx", "code.docx", "openloop.docx"]) {
      await assert.rejects(runOperation("fill_docx", { template: fileName, values: { ...INVOICE_VALUES, raw: "<w:p/>" } }, AS_TOOL), { kind: "invalid_input" }, fileName);
    }
    await assert.rejects(runOperation("fill_docx", { template: "invoice", values: INVOICE_VALUES }, AS_TOOL), /render_pdf/);
  }));

test("next_number feeds render_pdf: two invoices get consecutive numbers and their own files", options, () =>
  withDocumentRunner({}, async ({ runOperation, outputDirectory }) => {
    const paths = [];
    for (const expected of ["INV-2026-0001", "INV-2026-0002"]) {
      const issued = await runOperation("next_number", {}, AS_TOOL);
      assert.equal(issued.data.number, expected);
      paths.push((await runOperation("render_pdf", { values: { ...INVOICE_VALUES, number: issued.data.number } }, AS_TOOL)).data.relative_path);
    }
    assert.deepEqual(paths, ["2026/11/INV-2026-0001.pdf", "2026/11/INV-2026-0002.pdf"]);
    assert.deepEqual((await runOperation("next_number", { pattern: "{SEQ:3}/INV/{ROMAN}/{YYYY}", date: "2026-03-01", start_at: "12", preview: "true" }, AS_TOOL)).data, { number: "012/INV/III/2026", sequence: 12, counter: "{SEQ:3}/INV/III/2026", reserved: false });
    assert.deepEqual((await readdir(outputDirectory)).sort(), [".document-templates", "2026"]);
    await mkdir(join(outputDirectory, "x"));
    await assert.rejects(runOperation("next_number", { pattern: "no sequence" }, AS_TOOL), { kind: "invalid_input" });
  }));

test("check_values: checks everything render_pdf checks, draws the PDF and throws it away, saves nothing and uses no number", options, () =>
  withDocumentRunner({}, async ({ runOperation, outputDirectory }) => {
    const { number: _number, ...valuesWithoutNumber } = INVOICE_VALUES;
    const checked = await runOperation("check_values", { values: valuesWithoutNumber, number_pattern: "INV-{YYYY}-{SEQ:4}" }, AS_NODE);
    assert.deepEqual({ ...checked.data, totals: checked.data.totals.balance_due_text }, { ok: true, problem: null, template: "invoice", number: "INV-2026-0001", totals: "Rp 11.100.000", page_count: 1, relative_path: "2026/11/INV-2026-0001.pdf" });
    assert.deepEqual(await readdir(outputDirectory), [], "no file, no numbering file");
    // Without a series, the number given in the values is the one checked.
    assert.equal((await runOperation("check_values", { values: INVOICE_VALUES }, AS_TOOL)).data.relative_path, "2026/11/INV-2026-0007.pdf");

    // Everything a person can fix comes back as a problem in plain words, not as a failure, in the invoice's language.
    const english = { ...valuesWithoutNumber, language: "en" };
    const problems = [
      ["The unit price of item 1 must be a plain number", { ...english, items: [{ description: "Jasa", quantity: 2, unit_price: "seratus ribu" }] }],
      ["The unit price of item 1 is required when quantity is given", { ...english, items: [{ description: "Jasa", quantity: 2 }] }],
      ["Currency must be a three-letter code such as IDR or USD, got \"Rp\"", { ...english, currency: "Rp" }],
      ["The invoice template needs these values: client.name", { ...english, client: {} }],
      ["Harga satuan item 1 harus berupa angka biasa seperti 1500000", { ...valuesWithoutNumber, items: [{ description: "Jasa", quantity: 2, unit_price: "seratus ribu" }] }],
      ["Harga satuan item 1 wajib diisi bila jumlah diisi", { ...valuesWithoutNumber, items: [{ description: "Jasa", quantity: 2 }] }],
      ["Mata uang harus berupa kode tiga huruf seperti IDR atau USD, bukan \"Rp\"", { ...valuesWithoutNumber, currency: "Rp" }],
      ["Template invoice memerlukan data berikut: nama klien", { ...valuesWithoutNumber, client: {} }],
      ["Tarif pajak ke-1 harus berupa persen dari -100 sampai 100", { ...valuesWithoutNumber, taxes: [{ name: "PPN", rate: 300 }] }],
    ];
    for (const [expected, values] of problems) {
      const result = await runOperation("check_values", { values, number_pattern: "INV-{YYYY}-{SEQ:4}" }, AS_NODE);
      assert.deepEqual([result.data.ok, result.data.number, result.data.problem.startsWith(expected)], [false, null, true], result.data.problem);
    }
    for (const [args, expected] of [
      [{ values: { ...INVOICE_VALUES, language: "en" }, number_pattern: "INV-{SEQ}" }, /Give the document's number in values or a number pattern, not both/],
      [{ values: INVOICE_VALUES, number_pattern: "INV-{SEQ}" }, /^Berikan nomor dokumen di data atau pola nomor, tidak keduanya$/],
      [{ values: valuesWithoutNumber, number_pattern: "INV-no-sequence" }, /^Pola nomor harus punya tepat satu \{SEQ\}/],
      [{ values: { ...valuesWithoutNumber, seller: { ...valuesWithoutNumber.seller, logo: "missing.png" } }, number_pattern: "INV-{SEQ}" }, /^Tidak ada file "missing\.png" di dalam/],
    ]) assert.match((await runOperation("check_values", args, AS_NODE)).data.problem, expected);
    // A file that is already there is a problem too, before any number is taken.
    await mkdir(join(outputDirectory, "2026", "11"), { recursive: true });
    await writeFile(join(outputDirectory, "2026", "11", "INV-2026-0001.pdf"), "taken");
    assert.match((await runOperation("check_values", { values: valuesWithoutNumber, number_pattern: "INV-{YYYY}-{SEQ:4}" }, AS_NODE)).data.problem, /^"2026\/11\/INV-2026-0001\.pdf" sudah ada/);
    assert.deepEqual((await readdir(outputDirectory)).sort(), ["2026"]);
  }));

test("check_values: what is not the values' fault is still a failure (no documents folder, a broken renderer)", options, async () => {
  await withDocumentRunner({ environment: { DOCUMENT_TEMPLATES_OUTPUT_DIR: "" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("check_values", { values: INVOICE_VALUES }, AS_NODE), { kind: "setup_required" });
    await assert.rejects(runOperation("check_values", { values: { ...INVOICE_VALUES, number: "" }, number_pattern: "INV-{SEQ}" }, AS_NODE), { kind: "setup_required" });
  });
  const brokenRenderer = async () => { throw Object.assign(new Error("renderer crashed"), { kind: "plugin_error" }); };
  await withDocumentRunner({ runTask: brokenRenderer }, async ({ runOperation }) => {
    await assert.rejects(runOperation("check_values", { values: INVOICE_VALUES }, AS_NODE), /renderer crashed/);
  });
});

test("render_pdf with number_pattern: the number is used only once the PDF is saved, so a failed invoice leaves no gap", options, () => {
  let isRendererBroken = false;
  const runTask = (task, payload) => {
    if (isRendererBroken) throw Object.assign(new Error("renderer crashed"), { kind: "plugin_error" });
    return runEngineTask(task, structuredClone(payload));
  };
  return withDocumentRunner({ runTask }, async ({ runOperation, outputDirectory }) => {
    const { number: _number, ...values } = INVOICE_VALUES;
    const render = (overrides = {}) => runOperation("render_pdf", { values: { ...values, ...overrides }, number_pattern: "INV-{YYYY}-{SEQ:4}" }, AS_NODE);
    const counterPath = join(outputDirectory, ".document-templates", "numbering.json");
    const readLast = async () => JSON.parse(await readFile(counterPath, "utf8").catch(() => "{\"counters\":{}}")).counters["INV-2026-{SEQ:4}"]?.last ?? 0;

    // The desktop test: an amount in words fails, and no number is used.
    await assert.rejects(render({ items: [{ description: "Jasa", quantity: 2, unit_price: "seratus ribu" }] }), { kind: "invalid_input" });
    assert.equal(await readLast(), 0);
    isRendererBroken = true;
    await assert.rejects(render(), /renderer crashed/);
    isRendererBroken = false;
    assert.equal(await readLast(), 0);

    const first = await render();
    assert.deepEqual([first.data.number, first.data.relative_path], ["INV-2026-0001", "2026/11/INV-2026-0001.pdf"]);
    assert.ok((await readPageTexts(await readFile(first.data.path)))[0].includes("INV-2026-0001"));
    // Saving fails (the file name is taken): the number is given back.
    await writeFile(join(outputDirectory, "2026", "11", "INV-2026-0002.pdf"), "someone else's file");
    await assert.rejects(render(), /sudah ada/);
    assert.equal(await readLast(), 1);
    await rm(join(outputDirectory, "2026", "11", "INV-2026-0002.pdf"));
    assert.equal((await render()).data.number, "INV-2026-0002");

    // The series follows the document's date, and two at the same time get their own numbers.
    assert.equal((await render({ date: "2027-01-04" })).data.relative_path, "2027/01/INV-2027-0001.pdf");
    const together = await Promise.all([render(), render(), render()]);
    assert.deepEqual(together.map((result) => result.data.number).sort(), ["INV-2026-0003", "INV-2026-0004", "INV-2026-0005"]);
    assert.equal(await readLast(), 5);
    await assert.rejects(runOperation("render_pdf", { values: INVOICE_VALUES, number_pattern: "INV-{SEQ}" }, AS_NODE), /tidak keduanya/);
  });
});

test("only the documents folder has to be set up: a copy of the invoice template is saved there, never over another, and used for a PDF", options, () =>
  withDocumentRunner({ environment: { DOCUMENT_TEMPLATES_INPUT_DIRS: "" } }, async ({ runOperation, outputDirectory }) => {
    const copy = await runOperation("save_template_copy", {}, AS_TOOL);
    assert.deepEqual([copy.data.path, copy.data.folder_path, copy.data.relative_path, copy.data.copied_from, copy.data.replaced_existing], [join(outputDirectory, "Templates", "invoice.json"), join(outputDirectory, "Templates"), "Templates/invoice.json", "invoice", false]);
    assert.ok(copy.data.how_to_use.includes(JSON.stringify(copy.data.path)));
    const layout = JSON.parse(await readFile(copy.data.path, "utf8"));
    layout.labels.en.title = "Quotation";
    await writeFile(copy.data.path, JSON.stringify(layout));
    const second = await runOperation("save_template_copy", { template: " Invoice " }, AS_TOOL);
    assert.equal(second.data.relative_path, "Templates/invoice-2.json");
    assert.equal(JSON.parse(await readFile(copy.data.path, "utf8")).labels.en.title, "Quotation", "the first copy and its changes are kept");
    assert.equal((await runOperation("save_template_copy", { name: "../Penawaran: 2026?" }, AS_TOOL)).data.relative_path, "Templates/Penawaran- 2026.json");
    const rendered = await runOperation("render_pdf", { template: copy.data.path, values: { ...INVOICE_VALUES, language: "en" }, folder: "", file_name: " " }, AS_TOOL);
    assert.equal(rendered.data.relative_path, "2026/11/INV-2026-0007.pdf");
    assert.ok((await readPageTexts(await readFile(rendered.data.path)))[0].includes("QUOTATION"));
    assert.deepEqual((await runOperation("describe_template", { template: copy.data.path }, AS_TOOL)).data.built_in, false);
    await assert.rejects(runOperation("save_template_copy", { template: "report" }, AS_TOOL), (error) => error.kind === "invalid_input" && /ready-made template \(invoice\)/.test(error.message));
    await assert.rejects(runOperation("save_template_copy", { name: "..." }, AS_TOOL), { kind: "invalid_input" });
  }));

test("graphrt-settings.json: only the documents folder is required, and each default is the one the plugin uses", async () => {
  const { settings } = JSON.parse(await readFile(new URL("../graphrt-settings.json", import.meta.url), "utf8"));
  const byName = Object.fromEntries(settings.map((setting) => [setting.name, setting]));
  assert.deepEqual(Object.keys(byName).sort(), [...buildManifest(pluginDefinition).permissions.env].sort());
  assert.deepEqual(settings.filter((setting) => setting.required).map((setting) => setting.name), ["DOCUMENT_TEMPLATES_OUTPUT_DIR"]);
  const defaults = readDocumentSettings({});
  assert.deepEqual(
    ["MAX_INPUT_BYTES", "MAX_OUTPUT_BYTES", "MAX_PAGES", "MAX_FORM_FIELDS", "TIMEOUT_MS", "MAX_MEMORY_MB"].map((suffix) => byName[`DOCUMENT_TEMPLATES_${suffix}`].default),
    [defaults.files.maxInputBytes, defaults.files.maxOutputBytes, defaults.maxPages, defaults.maxFormFields, defaults.timeoutMs, defaults.maxMemoryMb],
  );
});
