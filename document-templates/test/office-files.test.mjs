/**
 * What files from real office software look like, rebuilt small: the shapes
 * below were found in templates written by Microsoft Word and in forms made
 * with Adobe Acrobat and LiveCycle Designer (public US government forms).
 * The real files are not in the repository; these fixtures repeat their
 * structure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AS_TOOL, INVOICE_VALUES, SKIP_WITHOUT_LIBRARIES, buildDocx, pdfLib, readDocxEntry, readDocxParagraphs, readPageTexts, withDocumentRunner, wordControlCell, wordParagraph, wordTextBox } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES };
const isRefused = (pattern) => (error) => error.kind === "invalid_input" && pattern.test(error.message);

test("fill_docx: placeholders Word cut into several runs are filled in the body, a header, a footer and a text box", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "letter.docx"), buildDocx({
      bodyXml: wordParagraph(["Dear", " {{ ", "client.name", " }},"]) + wordParagraph(["{{", "totals.total", " | mo", "ney}}"]) + wordTextBox(["{{sell", "er.name}} · {{", "number", "}}"]),
      parts: { header1: wordParagraph(["{{", "date | date", "}}"]), footer2: wordParagraph(["Page of ", "{{", "seller", ".name", "}}"]) },
    }));
    const described = await runOperation("describe_template", { template: "letter.docx" }, AS_TOOL);
    assert.deepEqual(described.data.placeholders, ["client.name", "date | date", "number", "seller.name", "totals.total | money"]);
    const result = await runOperation("fill_docx", { template: "letter.docx", values: INVOICE_VALUES }, AS_TOOL);
    const bytes = await readFile(result.data.path);
    // The text box is saved twice by Word (the drawing and its copy for older programs); both are filled.
    const paragraphs = readDocxParagraphs(bytes);
    assert.deepEqual(paragraphs.slice(0, 2), ["Dear PT Maju Bersama,", "Rp 11.100.000"]);
    assert.equal(paragraphs.filter((text) => text === "CV Kenanga Digital · INV-2026-0007").length, 2);
    assert.ok(!readDocxEntry(bytes, "word/document.xml").includes("{{"));
    assert.deepEqual([readDocxParagraphs(bytes, "header1"), readDocxParagraphs(bytes, "footer2")], [["27 November 2026"], ["Page of CV Kenanga Digital"]]);
  }));

test("fill_docx: a table row of content controls repeats for every item, with its loop tags split over runs", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    const itemRow = `<w:tr>${wordControlCell(["{{#", "items", "}}{{quantity}}"])}${wordControlCell(["{{description}}"])}${wordControlCell(["{{amount | am", "ount}}{{/", "items}}"])}</w:tr>`;
    await writeFile(join(inputDirectory, "invoice.docx"), buildDocx({ bodyXml: `<w:tbl><w:tr>${wordControlCell(["Qty"])}${wordControlCell(["Description"])}${wordControlCell(["Total"])}</w:tr>${itemRow}</w:tbl>` }));
    const result = await runOperation("fill_docx", { template: "invoice.docx", values: INVOICE_VALUES }, AS_TOOL);
    const bytes = await readFile(result.data.path);
    assert.deepEqual(readDocxParagraphs(bytes), ["Qty", "Description", "Total", "2", "Desain antarmuka", "3.000.000", "3.5", "Pengembangan", "7.000.000"]);
    // Filled controls hold real text now (Word would select and drop "placeholder" text); the header row keeps its mark.
    assert.equal(readDocxEntry(bytes, "word/document.xml").match(/<w:showingPlcHdr\/>/g).length, 3);
  }));

test("fill_docx: only content controls whose text holds a placeholder lose the 'showing placeholder' mark, also nested and in a header", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    const control = (inner, id) => `<w:sdt><w:sdtPr><w:id w:val="${id}"/><w:temporary/><w:showingPlcHdr/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;
    const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
    const bodyXml = `<w:p>${control(run("Click to enter a date"), 1)}${control(run("{") + run("{number}}"), 2)}</w:p>`
      + control(`<w:p>${run("Outer ")}${control(run("{{client.name}}"), 4)}</w:p>`, 3) + `<w:p>${control(run("Company Name"), 5)}</w:p>`;
    await writeFile(join(inputDirectory, "controls.docx"), buildDocx({ bodyXml, parts: { header1: `<w:p>${control(run("{{seller.name}}"), 6)}${control(run("Slogan"), 7)}</w:p>` } }));
    const bytes = await readFile((await runOperation("fill_docx", { template: "controls.docx", values: INVOICE_VALUES }, AS_TOOL)).data.path);
    const documentXml = readDocxEntry(bytes, "word/document.xml");
    const markedIds = (xml) => [...xml.matchAll(/<w:id w:val="(\d+)"\/><w:temporary\/>(<w:showingPlcHdr\/>)?/g)].filter((match) => match[2]).map((match) => match[1]);
    // 3 holds no placeholder of its own, but the control inside it does, so its text is no longer only a placeholder.
    assert.deepEqual(markedIds(documentXml), ["1", "5"]);
    assert.deepEqual(markedIds(readDocxEntry(bytes, "word/header1.xml")), ["7"]);
    assert.deepEqual(readDocxParagraphs(bytes).filter(Boolean), ["Click to enter a dateINV-2026-0007", "Outer PT Maju Bersama", "Company Name"]);
  }));

test("fill_docx: a Word template file (.dotx) is filled and saved as a document", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "Invoice.dotx"), buildDocx({ paragraphs: ["Invoice {{number}}"], isTemplate: true }));
    assert.deepEqual((await runOperation("describe_template", { template: "Invoice.dotx" }, AS_TOOL)).data.placeholders, ["number"]);
    const result = await runOperation("fill_docx", { template: "Invoice.dotx", values: INVOICE_VALUES }, AS_TOOL);
    assert.equal(result.data.file_name, "INV-2026-0007.docx");
    const bytes = await readFile(result.data.path);
    assert.deepEqual(readDocxParagraphs(bytes), ["Invoice INV-2026-0007"]);
    const contentTypes = readDocxEntry(bytes, "[Content_Types].xml");
    assert.ok(contentTypes.includes("document.main+xml") && !contentTypes.includes("template.main+xml"), "Word refuses a .docx that says it is a template");
  }));

test("fill_docx: quotes that Word made typographic work, and a refused placeholder is named with where it is", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "quotes.docx"), buildDocx({ paragraphs: ["Dear {{client.attention | default:“Sir or Madam”}}", "{{terms | default:”-”}} {{due | default:‘n/a’}} {{seller.name == „CV Kenanga Digital“}}"] }));
    const result = await runOperation("fill_docx", { template: "quotes.docx", values: INVOICE_VALUES }, AS_TOOL);
    assert.deepEqual(readDocxParagraphs(await readFile(result.data.path)), ["Dear Sir or Madam", "- n/a true"]);
    await writeFile(join(inputDirectory, "mail-merge.docx"), buildDocx({ paragraphs: ["{{number}}"], parts: { header1: wordParagraph(["{{", "client name", "}}"]), footer1: wordParagraph(["{{number | currency}}"]) } }));
    await assert.rejects(runOperation("fill_docx", { template: "mail-merge.docx", values: INVOICE_VALUES, file_name: "never" }, AS_TOOL), isRefused(/\{\{client name\}\} has an invalid name "client name" \(use letters, digits, _ and dots, e\.g\. client\.name\) \(in the page header\); .*unknown filter "currency".*\(in the page footer\)/));
  }));

// Read from the catalog: pdf-lib's getForm() itself removes the XFA entry.
function readAcroFormEntry(document, entryName) {
  const { PDFDict, PDFName } = pdfLib;
  return document.catalog.lookup(PDFName.of("AcroForm"), PDFDict).get(PDFName.of(entryName));
}

/** A form like the ones agencies publish: comb field, radio group, drop-down, list, read-only field, signature field and push button. */
async function buildAgencyForm({ withXfa = false } = {}) {
  const { PDFDocument, PDFName, PDFString } = pdfLib;
  const document = await PDFDocument.create();
  const page = document.addPage([420, 400]);
  const form = document.getForm();
  const place = (index) => ({ x: 150, y: 350 - index * 40, width: 220, height: 22 });
  form.createTextField("Name").addToPage(page, place(0));
  const taxNumber = form.createTextField("TaxNumber");
  taxNumber.setMaxLength(9);
  taxNumber.enableCombing();
  taxNumber.addToPage(page, place(1));
  const status = form.createRadioGroup("Status");
  status.addOptionToPage("single", page, { x: 150, y: 270, width: 14, height: 14 });
  status.addOptionToPage("married", page, { x: 200, y: 270, width: 14, height: 14 });
  const state = form.createDropdown("State");
  state.addOptions(["", "MEX", "CAN", "IDN"]);
  state.addToPage(page, place(3));
  const services = form.createOptionList("Services");
  services.addOptions(["Design", "Hosting", "Support"]);
  services.enableMultiselect();
  services.addToPage(page, { ...place(5), height: 50 });
  const office = form.createTextField("OfficeUse");
  office.addToPage(page, place(6));
  office.enableReadOnly();
  form.createCheckBox("Agree").addToPage(page, { x: 150, y: 60, width: 14, height: 14 });
  // An unsigned signature field and a push button have no drawing of their own in real forms.
  for (const [name, fieldType] of [["Signature", "Sig"], ["PrintButton", "Btn"]]) {
    const widget = document.context.obj({ Type: "Annot", Subtype: "Widget", FT: fieldType, T: PDFString.of(name), Rect: [150, 20, 250, 40], P: page.ref, ...(fieldType === "Btn" ? { Ff: 1 << 16 } : {}) });
    const widgetRef = document.context.register(widget);
    form.acroForm.addField(widgetRef);
    page.node.addAnnot(widgetRef);
  }
  form.updateFieldAppearances();
  if (withXfa) form.acroForm.dict.set(PDFName.of("XFA"), document.context.obj([PDFString.of("template"), document.context.register(document.context.flateStream("<template/>"))]));
  // Saved without pdf-lib's own pass over the form, which would remove the XFA entry again.
  return document.save({ updateFieldAppearances: false });
}

test("fill_pdf_form: comb field, radio group, drop-down, list, read-only field and non-Latin text; flattening survives fields with nothing to draw", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "agency.pdf"), await buildAgencyForm({ withXfa: true }));
    const described = await runOperation("describe_template", { template: "agency.pdf" }, AS_TOOL);
    assert.deepEqual(described.data.fields.map((field) => `${field.name}:${field.kind}`), ["Name:text", "TaxNumber:text", "Status:radiogroup", "State:dropdown", "Services:optionlist", "OfficeUse:text", "Agree:checkbox", "Signature:signature", "PrintButton:button"]);
    assert.deepEqual([described.data.is_form, described.data.is_xfa_only, described.data.fields[1].max_length, described.data.fields[2].options, described.data.fields[5].read_only], [true, false, 9, ["single", "married"], true]);
    const fields = { Name: "Søren Ünal Привет Ελένη", TaxNumber: "123456789", Status: "married", State: "IDN", Services: "Hosting", OfficeUse: "A-17", Agree: "yes" };
    const editable = await runOperation("fill_pdf_form", { template: "agency.pdf", fields, flatten: false, file_name: "editable" }, AS_TOOL);
    const editableBytes = await readFile(editable.data.path);
    const editableDocument = await pdfLib.PDFDocument.load(editableBytes);
    // The XFA copy of a hybrid form is dropped: a viewer that prefers it would show the form empty.
    assert.equal(readAcroFormEntry(editableDocument, "XFA"), undefined);
    assert.notEqual(readAcroFormEntry(await pdfLib.PDFDocument.load(await buildAgencyForm({ withXfa: true })), "XFA"), undefined);
    const form = editableDocument.getForm();
    assert.deepEqual([form.getTextField("Name").getText(), form.getTextField("TaxNumber").getText(), form.getRadioGroup("Status").getSelected(), form.getDropdown("State").getSelected(), form.getOptionList("Services").getSelected(), form.getTextField("OfficeUse").getText(), form.getCheckBox("Agree").isChecked()],
      ["Søren Ünal Привет Ελένη", "123456789", "married", ["IDN"], ["Hosting"], "A-17", true]);
    const flattened = await runOperation("fill_pdf_form", { template: "agency.pdf", fields, file_name: "flat" }, AS_TOOL);
    const flatBytes = await readFile(flattened.data.path);
    assert.equal((await pdfLib.PDFDocument.load(flatBytes)).getForm().getFields().length, 0);
    const [pageText] = await readPageTexts(flatBytes);
    for (const expected of ["Søren Ünal Привет Ελένη", "1 2 3 4 5 6 7 8 9", "IDN", "Hosting", "A-17"]) assert.ok(pageText.includes(expected), `${expected} in: ${pageText}`);
    await assert.rejects(runOperation("fill_pdf_form", { template: "agency.pdf", fields: { TaxNumber: "1234567890" }, file_name: "never" }, AS_TOOL), isRefused(/"TaxNumber" was not accepted/));
    await assert.rejects(runOperation("fill_pdf_form", { template: "agency.pdf", fields: { State: "JPN" }, file_name: "never" }, AS_TOOL), isRefused(/"State" was not accepted: "JPN" is not one of its options \("", "MEX", "CAN", "IDN"\)/));
    await assert.rejects(runOperation("fill_pdf_form", { template: "agency.pdf", fields: { Signature: "me" }, file_name: "never" }, AS_TOOL), isRefused(/"Signature" was not accepted: fields of kind Signature cannot be filled/));
  }));

test("fill_pdf_form: an XFA-only form is refused with what to do", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    const { PDFDocument, PDFName, PDFString } = pdfLib;
    // LiveCycle Designer's dynamic forms: one "Please wait..." page, the form itself only as XFA, at most a signature field.
    const xfaOnly = await PDFDocument.create();
    const page = xfaOnly.addPage([300, 200]);
    const acroForm = xfaOnly.getForm().acroForm;
    const signatureRef = xfaOnly.context.register(xfaOnly.context.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("SignatureField1"), Rect: [0, 0, 0, 0], P: page.ref }));
    acroForm.addField(signatureRef);
    page.node.addAnnot(signatureRef);
    acroForm.dict.set(PDFName.of("XFA"), xfaOnly.context.register(xfaOnly.context.flateStream("<xdp/>")));
    await writeFile(join(inputDirectory, "dynamic.pdf"), await xfaOnly.save());
    const described = await runOperation("describe_template", { template: "dynamic.pdf" }, AS_TOOL);
    assert.deepEqual([described.data.kind, described.data.is_form, described.data.is_xfa_only, described.data.operation], ["pdf", false, true, null]);
    assert.match(described.data.hint, /XFA form/);
    await assert.rejects(runOperation("fill_pdf_form", { template: "dynamic.pdf", fields: { SignatureField1: "x" }, file_name: "never" }, AS_TOOL), isRefused(/XFA form \(made with Adobe LiveCycle Designer.*Ask whoever published the form for a standard fillable PDF/));
  }));

test("fill_pdf_form: values a NeedAppearances form came with are still there after flattening", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    const { PDFBool, PDFDocument, PDFName } = pdfLib;
    const document = await PDFDocument.create();
    const page = document.addPage([400, 200]);
    const form = document.getForm();
    for (const [index, name] of ["Company", "Contact"].entries()) form.createTextField(name).addToPage(page, { x: 100, y: 140 - index * 40, width: 240, height: 22 });
    // Such a form stores the value only; the viewer is asked to draw it.
    form.getTextField("Company").setText("PT Maju Bersama");
    for (const field of form.getFields()) for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of("AP"));
    form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
    await writeFile(join(inputDirectory, "viewer-drawn.pdf"), await document.save({ updateFieldAppearances: false }));
    const flattened = await runOperation("fill_pdf_form", { template: "viewer-drawn.pdf", fields: { Contact: "Ibu Sari" }, file_name: "flat" }, AS_TOOL);
    const [pageText] = await readPageTexts(await readFile(flattened.data.path));
    assert.ok(pageText.includes("PT Maju Bersama") && pageText.includes("Ibu Sari"), pageText);
    const editable = await runOperation("fill_pdf_form", { template: "viewer-drawn.pdf", fields: { Contact: "Ibu Sari" }, flatten: false, file_name: "editable" }, AS_TOOL);
    assert.equal(readAcroFormEntry(await PDFDocument.load(await readFile(editable.data.path)), "NeedAppearances"), undefined);
  }));
