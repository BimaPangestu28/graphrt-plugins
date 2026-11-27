/**
 * The look of a document without editing a template: look options, the
 * logo checks, named colours in templates, and saved brands, down to the
 * PDF that comes out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyBrandToFormValues, applyBrandToValues, listFormPlaceholders, mergeBrandDetails, readBrandDetails, readBrandName } from "../lib/brand-profile.mjs";
import { readFormatSettings } from "../lib/formatting.mjs";
import { calculateInvoice } from "../lib/invoice-totals.mjs";
import { expandLayout, readNamedColors } from "../lib/layout-template.mjs";
import { MAX_LOGO_BYTES, checkLogoBytes, readImageSize } from "../lib/logo-file.mjs";
import { COLOR_NAMES, applyLookToValues, applyShowToValues, mergeLooks, readAccentColor, readLook } from "../lib/look-options.mjs";
import { loadBuiltInTemplate } from "../lib/template-library.mjs";
import { AS_TOOL, INVOICE_VALUES, SKIP_WITHOUT_LIBRARIES, buildDocx, buildFormPdf, buildPng, pdfLib, readDocxEntry, readDocxParagraphs, readPageTexts, withDocumentRunner, wordParagraph } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES };
const settings = readFormatSettings({ language: "id" });
const BRAND = {
  look: { accent_color: "biru tua", title: "Faktur", language: "id", show: { notes: false } },
  seller: { name: "CV Kenanga Digital", address: "Jalan Kenanga 12\nBandung 40115" },
  payment_details: [{ label: "Bank", value: "Bank Contoh" }, { label: "No. rekening", value: "000 111 2222" }],
  notes: ["Terima kasih."],
};
const CLIENT_ONLY = { number: "INV-2026-0009", client: { name: "PT Maju Bersama" }, items: [{ description: "Desain", period: "Nov 2026", quantity: 2, unit_price: 1500000 }] };

// A baseline JPEG header: SOI, an APP0 segment, then a frame header that carries height and width.
function buildJpegHeader(width, height) {
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), frame]);
}

function collect(node, key, found = []) {
  if (Array.isArray(node)) node.forEach((entry) => collect(entry, key, found));
  else if (typeof node === "object" && node !== null) {
    for (const [name, value] of Object.entries(node)) {
      if (name === key) found.push(value);
      collect(value, key, found);
    }
  }
  return found;
}

test("look: options are checked and returned in one shape", () => {
  assert.deepEqual(readLook(undefined), {});
  assert.deepEqual(readLook({ logo: " logo.png ", accent_color: "Biru  Tua", title: " Tax   Invoice ", language: "Indonesia", labels: { tax: "PPN", bill_to: "" }, show: { period: "false", quantity: true, notes: "" } }), {
    logo: "logo.png", accent_color: "#1F3A5F", title: "Tax Invoice", language: "id", labels: { tax: "PPN" }, show: { period: false, quantity: true },
  });
  const refused = [
    ["navy", /object/],
    [{ colour: "navy" }, /does not know "colour"/],
    [{ accent_color: "sky" }, /colour such as #1D4ED8/],
    [{ accent_color: "#FFEE00" }, /too light/],
    [{ accent_color: "url(x)" }, /colour/],
    [{ title: "x".repeat(41) }, /at most 40/],
    [{ title: "Tax\u0007" }, /title/],
    [{ language: "fr" }, /en \(English\) or id/],
    [{ labels: { "Bad Name": "x" } }, /label name/],
    [{ labels: { tax: { text: "x" } } }, /labels\.tax/],
    [{ show: { footer: false } }, /does not know "footer"/],
    [{ show: { notes: "maybe" } }, /true or false/],
    [{ logo: 7 }, /PNG or JPEG/],
  ];
  for (const [look, message] of refused) assert.throws(() => readLook(look), { kind: "invalid_input", message }, JSON.stringify(look));
});

test("look: every colour name is a readable colour, and hex colours are accepted in the usual spellings", () => {
  for (const name of Object.keys(COLOR_NAMES)) assert.match(readAccentColor(name, "accent_color"), /^#[0-9A-F]{6}$/, name);
  assert.deepEqual(["#1d4ed8", "1D4ED8", "#03c", " NAVY "].map((color) => readAccentColor(color, "accent_color")), ["#1D4ED8", "#1D4ED8", "#03C", "#1F3A5F"]);
});

test("look: the look of a call wins over the values, a saved look only fills what is open", () => {
  const values = { language: "en", seller: { name: "A", logo: "own.png" }, labels: { title: "Quotation", tax: "VAT" } };
  const look = { language: "id", logo: "brand.png", title: "Faktur", labels: { tax: "PPN", due: "Tempo" } };
  assert.deepEqual(applyLookToValues(values, look, { isDefault: true }), { language: "en", seller: { name: "A", logo: "own.png" }, labels: { title: "Quotation", tax: "VAT", due: "Tempo" } });
  assert.deepEqual(applyLookToValues(values, look, { isDefault: false }), { language: "id", seller: { name: "A", logo: "brand.png" }, labels: { title: "Faktur", tax: "PPN", due: "Tempo" } });
  assert.deepEqual(applyLookToValues({ number: "1" }, {}, { isDefault: false }), { number: "1" });
  assert.deepEqual(mergeLooks({ accent_color: "#111111", show: { notes: false, period: false } }, { title: "X", show: { period: true } }), { accent_color: "#111111", title: "X", show: { notes: false, period: true } });
});

test("look: hidden parts leave the document, everything else stays", () => {
  const calculated = calculateInvoice({ ...CLIENT_ONLY, payment: { details: [{ label: "Bank", value: "X" }], reference: "R1" }, notes: ["n"] }, 0);
  assert.deepEqual([calculated.flags.has_period, calculated.flags.has_quantity], [true, true]);
  const hidden = applyShowToValues(calculated, { period: false, quantity: false, payment_details: false, notes: false });
  assert.deepEqual([hidden.flags.has_period, hidden.flags.has_quantity, hidden.payment, hidden.notes, hidden.totals.total], [false, false, { details: undefined, reference: "R1" }, undefined, "3000000"]);
  assert.deepEqual(applyShowToValues(calculated, { period: true }).flags, calculated.flags);
  assert.equal(calculated.notes.length, 1, "the input is not changed");
});

test("named colours: a template names a colour once, and a look replaces it everywhere", async () => {
  const invoice = await loadBuiltInTemplate("invoice");
  assert.deepEqual(readNamedColors(invoice), { accent: "#1C1C1A" });
  const values = calculateInvoice(INVOICE_VALUES, 0);
  const plain = expandLayout(invoice, values, settings, { today: "2026-11-27" });
  const blue = expandLayout(invoice, values, settings, { today: "2026-11-27", colors: { accent: "#1D4ED8", unknown: "#FF0000" } });
  const colorsOf = (plan) => [...collect(plan.content, "color"), ...collect(plan.content, "header_line_color")];
  assert.ok(!JSON.stringify(plain).includes("@accent"));
  assert.equal(colorsOf(plain).filter((color) => color === "#1C1C1A").length, 4, "the default accent is the text colour, so the invoice looks as before");
  assert.equal(colorsOf(blue).filter((color) => color === "#1D4ED8").length, 4);
  assert.ok(!JSON.stringify(blue).includes("#FF0000"));

  const custom = (extra) => ({ format: "graphrt-document-template", version: 1, name: "t", content: [{ text: "@accent is a text here", color: "@accent" }], ...extra });
  const expanded = expandLayout(custom({ colors: { accent: "#0A0" }, styles: { head: { color: "@accent" } } }), {}, settings, { today: "2026-11-27" });
  assert.deepEqual([expanded.content[0], expanded.styles.head], [{ text: "@accent is a text here", color: "#0A0" }, { color: "#0A0" }]);
  for (const [template, message] of [
    [custom({ colors: { accent: "#0A0", other: "red" } }), /colors\.other/],
    [custom({ colors: { Accent: "#0A0" } }), /colour name/],
    [custom({ colors: ["#0A0"] }), /colors/],
    [custom({ colors: { main: "#0A0" } }), /names the colour "@accent"/],
    [custom({}), /color/],
  ]) assert.throws(() => expandLayout(template, {}, settings, { today: "2026-11-27" }), { kind: "invalid_input", message });
});

test("logo: only a PNG or JPEG of a sane size passes", () => {
  assert.deepEqual(readImageSize(buildPng(640, 200), "png"), { width: 640, height: 200 });
  assert.deepEqual(readImageSize(buildJpegHeader(800, 300), "jpeg"), { width: 800, height: 300 });
  assert.equal(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), "jpeg"), null);
  assert.deepEqual(checkLogoBytes(buildPng(640, 200), "The logo"), { format: "png", width: 640, height: 200, size_bytes: buildPng(640, 200).length });
  const oversized = Buffer.concat([buildPng(64, 64), Buffer.alloc(MAX_LOGO_BYTES)]);
  for (const [bytes, message] of [
    [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), /png, jpeg image/],
    [Buffer.from("GIF89a-and-more-bytes"), /png, jpeg image/],
    [oversized, /at most 2 MB/],
    [buildPng(8, 4), /smaller than 16 pixels/],
    [buildJpegHeader(5000, 300), /5000 x 300 pixels/],
    [buildPng(64, 64).subarray(0, 20), /damaged/],
  ]) assert.throws(() => checkLogoBytes(bytes, "The logo"), { kind: "invalid_input", message });
});

test("brand: details are checked, joined part by part, and only fill what a document leaves open", () => {
  assert.deepEqual(["", "Kenanga Studio", " STUDIO_2 "].map(readBrandName), ["default", "kenanga-studio", "studio_2"]);
  for (const name of ["none", "!!!", "x".repeat(60)]) assert.throws(() => readBrandName(name), { kind: "invalid_input" }, name);
  const details = readBrandDetails(BRAND);
  assert.deepEqual(details, { look: { accent_color: "#1F3A5F", title: "Faktur", language: "id", show: { notes: false } }, seller: { name: "CV Kenanga Digital", address: ["Jalan Kenanga 12", "Bandung 40115"] }, payment_details: BRAND.payment_details, notes: ["Terima kasih."] });
  for (const [bad, message] of [
    [{ seller: { name: "A", logo: "x.png" } }, /a logo goes in `look`/],
    [{ seller: "A" }, /seller/],
    [{ payment_details: [{ label: "Bank" }] }, /payment_details\[0\]/],
    [{ payment_details: { label: "Bank", value: "X" } }, /payment_details/],
    [{ notes: Array(13).fill("n") }, /notes/],
    [{ seller: { name: "x".repeat(201) } }, /seller\.name/],
  ]) assert.throws(() => readBrandDetails(bad), { kind: "invalid_input", message }, JSON.stringify(bad).slice(0, 60));

  const changed = mergeBrandDetails(details, readBrandDetails({ look: { accent_color: "green", show: { period: false } }, seller: { tagline: "Studio" } }));
  assert.deepEqual([changed.look, changed.seller.name, changed.seller.tagline, changed.notes], [{ accent_color: "#15803D", title: "Faktur", language: "id", show: { notes: false, period: false } }, "CV Kenanga Digital", "Studio", ["Terima kasih."]]);
  assert.deepEqual(mergeBrandDetails(null, {}), {});

  const filled = applyBrandToValues({ ...CLIENT_ONLY, seller: { name: "", tagline: "Lain" }, notes: ["Catatan sendiri"] }, details);
  assert.deepEqual([filled.seller, filled.payment.details.length, filled.notes, filled.language, filled.labels], [{ name: "CV Kenanga Digital", address: ["Jalan Kenanga 12", "Bandung 40115"], tagline: "Lain" }, 2, ["Catatan sendiri"], "id", { title: "Faktur" }]);
  assert.equal(applyBrandToValues(CLIENT_ONLY, null), CLIENT_ONLY);
});

test("render_pdf: a look changes the title, language, labels and hidden parts of the ready-made invoice", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "logo.png"), buildPng(320, 120));
    const values = { ...INVOICE_VALUES, items: [{ description: "Desain antarmuka", period: "Minggu ke-2", quantity: 2, unit: "hari", unit_price: 1500000 }], payment: { details: [{ label: "Bank", value: "Bank Contoh" }] }, notes: ["Catatan kaki"] };
    const plain = await runOperation("render_pdf", { values }, AS_TOOL);
    const [plainText] = await readPageTexts(await readFile(plain.data.path));
    for (const expected of ["INVOICE", "Minggu ke-2", "PERIODE", "JML", "HARGA SATUAN", "Bank Contoh", "Catatan kaki", "PPN (11%)"]) assert.ok(plainText.includes(expected), `${expected} in ${plainText}`);
    assert.equal(plain.data.brand, undefined);

    const look = { logo: "logo.png", accent_color: "navy", title: "Tax Invoice", language: "en", labels: { bill_to: "Customer" }, show: { period: false, quantity: "false", payment_details: false, notes: false } };
    const styled = await runOperation("render_pdf", { values, look: JSON.stringify(look), file_name: "styled" }, AS_TOOL);
    const [styledText] = await readPageTexts(await readFile(styled.data.path));
    for (const expected of ["TAX INVOICE", "CUSTOMER", "DESCRIPTION", "Desain antarmuka"]) assert.ok(styledText.includes(expected), `${expected} in ${styledText}`);
    for (const hidden of ["PERIOD", "QTY", "UNIT PRICE", "Bank Contoh", "Catatan kaki", "Minggu ke-2"]) assert.ok(!styledText.includes(hidden), `${hidden} in ${styledText}`);
    assert.equal(styled.data.totals.total, plain.data.totals.total, "hiding columns never changes an amount");
    assert.ok(styled.data.size_bytes > plain.data.size_bytes, "the logo is in the file");

    await writeFile(join(inputDirectory, "tiny.png"), buildPng(8, 4));
    await writeFile(join(inputDirectory, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    for (const [badLook, expected] of [
      [{ logo: "tiny.png" }, { kind: "invalid_input", message: /lebih kecil dari 16 piksel/ }],
      [{ logo: "logo.svg" }, { kind: "invalid_input", message: /harus berupa gambar png, jpeg/ }],
      [{ logo: "/etc/hostname" }, { kind: "not_found" }],
      [{ logo: "missing.png" }, { kind: "not_found" }],
      [{ accent_color: "#FFFFFF" }, { kind: "invalid_input", message: /terlalu terang/ }],
    ]) await assert.rejects(runOperation("render_pdf", { values, look: badLook, file_name: "bad" }, AS_TOOL), expected, JSON.stringify(badLook));
  }));

test("save_brand: saved once, used for every later document, changed part by part, and never needed", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory, outputDirectory, outsideDirectory }) => {
    assert.deepEqual((await runOperation("show_brand", {}, AS_TOOL)).data.saved, false);
    await assert.rejects(runOperation("render_pdf", { values: CLIENT_ONLY }, AS_TOOL), { kind: "invalid_input", message: /seller\.name/ });
    await assert.rejects(runOperation("save_brand", {}, AS_TOOL), { kind: "invalid_input", message: /at least one thing/ });
    await assert.rejects(runOperation("save_brand", { look: { logo: "nowhere.png" } }, AS_TOOL), { kind: "not_found" });

    await writeFile(join(inputDirectory, "logo.png"), buildPng(320, 120));
    const saved = await runOperation("save_brand", { ...BRAND, look: { ...BRAND.look, logo: "logo.png" } }, AS_TOOL);
    assert.deepEqual([saved.data.name, saved.data.look.logo, saved.data.logo_checked.width, saved.data.look.accent_color], ["default", join(inputDirectory, "logo.png"), 320, "#1F3A5F"]);
    assert.match(saved.data.used_for, /^Every document from now on/);
    assert.match(saved.data.used_for, /logo and colour are not added/);
    assert.deepEqual(saved.data.word_and_form_placeholders, ["{{business.name}}", "{{business.address | join}}", "{{payment.bank}}", "{{payment.no_rekening}}", "{{notes}}"]);
    assert.deepEqual(await readdir(join(outputDirectory, ".document-templates", "brands")), ["default.json"]);

    const first = await runOperation("render_pdf", { values: CLIENT_ONLY }, AS_TOOL);
    const [firstText] = await readPageTexts(await readFile(first.data.path));
    assert.equal(first.data.brand, "default");
    for (const expected of ["FAKTUR", "CV Kenanga Digital", "Jalan Kenanga 12", "Bank Contoh", "DESKRIPSI", "Rp 3.000.000"]) assert.ok(firstText.includes(expected), `${expected} in ${firstText}`);
    assert.ok(!firstText.includes("Terima kasih."), "the brand hides notes");

    // One thing changes; the rest of the brand stays.
    const changed = await runOperation("save_brand", { look: { show: { notes: true }, title: "Invoice" } }, AS_TOOL);
    assert.deepEqual([changed.data.look.accent_color, changed.data.look.title, changed.data.seller.name], ["#1F3A5F", "Invoice", "CV Kenanga Digital"]);
    const second = await runOperation("render_pdf", { values: { ...CLIENT_ONLY, number: "INV-2026-0010", language: "en" }, look: { title: "Receipt" } }, AS_TOOL);
    const [secondText] = await readPageTexts(await readFile(second.data.path));
    for (const expected of ["RECEIPT", "Terima kasih.", "DESCRIPTION"]) assert.ok(secondText.includes(expected), `${expected} in ${secondText}`);

    // Without the brand, and with a brand that does not exist.
    await assert.rejects(runOperation("render_pdf", { values: { ...CLIENT_ONLY, number: "INV-2026-0011" }, brand: "none" }, AS_TOOL), { kind: "invalid_input", message: /seller\.name/ });
    await assert.rejects(runOperation("render_pdf", { values: CLIENT_ONLY, brand: "studio" }, AS_TOOL), { kind: "not_found", message: /no saved brand named "studio"/ });
    await runOperation("save_brand", { name: "Studio", seller: { name: "Studio Dua" } }, AS_TOOL);
    assert.equal((await runOperation("render_pdf", { values: { ...CLIENT_ONLY, number: "INV-2026-0012" }, brand: "studio" }, AS_TOOL)).data.brand, "studio");

    const reset = await runOperation("save_brand", { seller: { name: "Baru" }, reset: true }, AS_TOOL);
    assert.deepEqual([reset.data.look, reset.data.notes, reset.data.seller], [undefined, undefined, { name: "Baru" }]);
    const shown = await runOperation("show_brand", {}, AS_TOOL);
    assert.deepEqual([shown.data.saved, shown.data.seller, shown.data.color_names.includes("biru tua")], [true, { name: "Baru" }, true]);

    // A file edited by hand into something else is refused, with the way out.
    await writeFile(join(outputDirectory, ".document-templates", "brands", "default.json"), JSON.stringify({ version: 1, look: { accent_color: "javascript:alert(1)" } }));
    await assert.rejects(runOperation("render_pdf", { values: { ...CLIENT_ONLY, number: "INV-2026-0013" } }, AS_TOOL), { kind: "invalid_input", message: /saved brand "default" is damaged/ });
    await runOperation("save_brand", { seller: { name: "Baru" }, reset: true }, AS_TOOL);

    // A brands folder that is a link to somewhere else is not written through.
    await mkdir(join(outsideDirectory, "brands"));
    await withDocumentRunner({}, async (other) => {
      await mkdir(join(other.outputDirectory, ".document-templates"));
      await symlink(join(outsideDirectory, "brands"), join(other.outputDirectory, ".document-templates", "brands"));
      await assert.rejects(other.runOperation("save_brand", { seller: { name: "X" } }, AS_TOOL), { kind: "invalid_input", message: /not a plain folder/ });
      assert.deepEqual(await readdir(join(outsideDirectory, "brands")), []);
    });
  }));

test("brand in Word and forms: details fill what the values leave open, with business.* and payment.<label> shortcuts", () => {
  const brand = readBrandDetails({ ...BRAND, payment_details: [...BRAND.payment_details, { label: "Atas nama (a/n)", value: "CV Kenanga" }, { label: "Details", value: "x" }, { label: "Bank", value: "Bank Kedua" }] });
  const filled = applyBrandToFormValues({ client: { name: "PT Maju" } }, brand);
  assert.deepEqual(filled.business, { name: "CV Kenanga Digital", address: ["Jalan Kenanga 12", "Bandung 40115"] });
  assert.deepEqual(filled.seller, filled.business);
  assert.deepEqual([filled.payment.bank, filled.payment.no_rekening, filled.payment.atas_nama_a_n, filled.payment.details.length], ["Bank Contoh", "000 111 2222", "CV Kenanga", 5], "the first of two equal labels wins; `details` stays the list");
  assert.deepEqual([filled.notes, filled.language], [["Terima kasih."], "id"]);
  // Only the details and the language: the look's logo, title and labels belong to render_pdf's layout.
  assert.deepEqual([filled.labels, filled.seller.logo], [undefined, undefined]);
  assert.equal(applyBrandToFormValues({}, readBrandDetails({ look: { logo: "x.png", accent_color: "navy" } })).seller, undefined);

  // The values of the call always win, also over a shortcut.
  const given = applyBrandToFormValues({ language: "en", seller: { name: "Nama Lain" }, business: { tagline: "Toko" }, payment: { bank: "Bank Saya", terms: "14 hari" }, notes: ["Sendiri"] }, brand);
  assert.deepEqual([given.language, given.business.name, given.business.tagline, given.business.address.length, given.payment.bank, given.payment.terms, given.payment.no_rekening, given.notes], ["en", "Nama Lain", "Toko", 2, "Bank Saya", "14 hari", "000 111 2222", ["Sendiri"]]);
  // Without a brand (`brand: none`, or none saved) only the call's own values are there, still with the shortcuts.
  assert.deepEqual(applyBrandToFormValues({ seller: { name: "A" }, payment: { details: [{ label: "Bank", value: "B" }] } }, null), { seller: { name: "A" }, business: { name: "A" }, payment: { details: [{ label: "Bank", value: "B" }], bank: "B" } });
  assert.deepEqual(applyBrandToFormValues({ number: "1" }, null), { number: "1" });
  assert.deepEqual(listFormPlaceholders({ seller: { name: "A", details: ["NPWP 1"] }, payment_details: [{ label: "Kode Bank", value: "014" }, { label: "kode bank", value: "x" }] }), ["{{business.name}}", "{{business.details | join}}", "{{payment.kode_bank}}"]);
});

test("fill_docx and fill_pdf_form: the saved brand fills your details, never your logo, and `brand: none` leaves them out", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "logo.png"), buildPng(320, 120));
    await runOperation("save_brand", { ...BRAND, look: { ...BRAND.look, logo: "logo.png" } }, AS_TOOL);
    await writeFile(join(inputDirectory, "surat.docx"), buildDocx({
      bodyXml: wordParagraph(["{{business.name}} · {{business.address | join}}"]) + wordParagraph(["Kepada {{client.name}}"]) + wordParagraph(["Transfer ke {{payment.bank}} {{payment.no_rekening}}, {{totals.total | money}}"]) + wordParagraph(["{{notes}}"]),
    }));
    const values = { client: { name: "PT Maju Bersama" }, items: [{ description: "Desain", quantity: 2, unit_price: 1500000 }] };
    const filled = await runOperation("fill_docx", { template: "surat.docx", values, file_name: "surat" }, AS_TOOL);
    const bytes = await readFile(filled.data.path);
    assert.equal(filled.data.brand, "default");
    assert.deepEqual(readDocxParagraphs(bytes), ["CV Kenanga Digital · Jalan Kenanga 12, Bandung 40115", "Kepada PT Maju Bersama", "Transfer ke Bank Contoh 000 111 2222, Rp 3.000.000", "Terima kasih."]);
    assert.ok(!Object.keys(new (await import("pizzip")).default(bytes).files).some((entryName) => entryName.startsWith("word/media/")), "no logo is put into a Word file");
    assert.ok(!readDocxEntry(bytes, "word/document.xml").includes("1F3A5F"), "no accent colour is put into a Word file");

    // The call's values win; `brand: none` uses only them; a letterhead needs no values at all.
    const own = await runOperation("fill_docx", { template: "surat.docx", values: { ...values, seller: { name: "Toko Sendiri" }, payment: { bank: "Bank Lain" } }, file_name: "own" }, AS_TOOL);
    assert.deepEqual(readDocxParagraphs(await readFile(own.data.path)).slice(0, 3), ["Toko Sendiri · Jalan Kenanga 12, Bandung 40115", "Kepada PT Maju Bersama", "Transfer ke Bank Lain 000 111 2222, Rp 3.000.000"]);
    const none = await runOperation("fill_docx", { template: "surat.docx", values, brand: "none", file_name: "none" }, AS_TOOL);
    assert.equal(none.data.brand, undefined);
    assert.deepEqual(readDocxParagraphs(await readFile(none.data.path)), [" · ", "Kepada PT Maju Bersama", "Transfer ke  , USD 3,000,000.00", ""]);
    const letterhead = await runOperation("fill_docx", { template: "surat.docx", file_name: "kop" }, AS_TOOL);
    assert.equal(readDocxParagraphs(await readFile(letterhead.data.path))[0], "CV Kenanga Digital · Jalan Kenanga 12, Bandung 40115");
    await assert.rejects(runOperation("fill_docx", { template: "surat.docx", brand: "studio" }, AS_TOOL), { kind: "not_found", message: /no saved brand named "studio"/ });

    await writeFile(join(inputDirectory, "form.pdf"), await buildFormPdf());
    const fields = { Client: "{{business.name}}", Notes: "{{payment.bank}} {{payment.no_rekening}}", Total: "{{amount | money}}" };
    const form = await runOperation("fill_pdf_form", { template: "form.pdf", fields, values: { amount: 1250000 }, flatten: false, file_name: "form" }, AS_TOOL);
    assert.equal(form.data.brand, "default");
    const formFields = (await pdfLib.PDFDocument.load(await readFile(form.data.path))).getForm();
    assert.deepEqual(["Client", "Notes", "Total"].map((name) => formFields.getTextField(name).getText()), ["CV Kenanga Digital", "Bank Contoh 000 111 2222", "Rp 1.250.000"]);
    const plain = await runOperation("fill_pdf_form", { template: "form.pdf", fields, values: { amount: 1250000 }, brand: "none", flatten: false, file_name: "plain" }, AS_TOOL);
    const plainFields = (await pdfLib.PDFDocument.load(await readFile(plain.data.path))).getForm();
    assert.deepEqual(["Client", "Total"].map((name) => plainFields.getTextField(name).getText() ?? ""), ["", "USD 1,250,000.00"]);
  }));
