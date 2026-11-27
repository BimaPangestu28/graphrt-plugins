/**
 * Protected (encrypted) PDF forms: the kind that opens without a password
 * and only carries restrictions, as official forms do (seen on USCIS G-1145,
 * I-765 and G-28, OPM SF 181 and the Australian Form 80), and the kind that
 * asks for a password. The fixtures are protected here with qpdf; the real
 * forms are not in the repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mayBeProtected, openProtectedPdf } from "../lib/pdf-protection.mjs";
import { createWorkerLauncher } from "../lib/worker-launcher.mjs";
import { AS_TOOL, SKIP_WITHOUT_LIBRARIES, buildFormPdf, pdfLib, protectPdf, readPageTexts, withDocumentRunner } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES };
const OPEN_PASSWORD = "Rahasia sekali é-42";
const PERMISSIONS_PASSWORD = "publisher-only";
const isRefused = (pattern) => (error) => error.kind === "invalid_input" && pattern.test(error.message);
const fields = { InvoiceNo: "INV-7", Client: "PT Contoh Ünïcode", Paid: true };

async function assertOpensEverywhere(pdfBytes) {
  // Loaded without `ignoreEncryption`: pdf-lib refuses any protected file.
  const document = await pdfLib.PDFDocument.load(pdfBytes);
  assert.equal(document.isEncrypted, false);
  assert.equal(mayBeProtected(pdfBytes), false);
  return document;
}

test("fill_pdf_form: a form that is only restricted is filled without a password, in every protection format, and the result has no protection", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    for (const bits of [40, 128, "128-aes", 256]) {
      const template = `restricted-${bits}.pdf`;
      await writeFile(join(inputDirectory, template), await protectPdf(await buildFormPdf(), { bits }));
      const described = await runOperation("describe_template", { template }, AS_TOOL);
      assert.deepEqual([described.data.kind, described.data.is_protected, described.data.filling_allowed, described.data.hint, described.data.fields.map((field) => field.name)], ["pdf_form", true, true, null, ["InvoiceNo", "Client", "Total", "Notes", "Paid"]], template);
      const editable = await runOperation("fill_pdf_form", { template, fields, flatten: false, file_name: `editable-${bits}` }, AS_TOOL);
      assert.equal(editable.data.was_protected, true);
      const form = (await assertOpensEverywhere(await readFile(editable.data.path))).getForm();
      assert.deepEqual([form.getTextField("InvoiceNo").getText(), form.getTextField("Client").getText(), form.getCheckBox("Paid").isChecked()], ["INV-7", "PT Contoh Ünïcode", true], template);
      const flattened = await runOperation("fill_pdf_form", { template, fields, file_name: `flat-${bits}` }, AS_TOOL);
      const flatBytes = await readFile(flattened.data.path);
      await assertOpensEverywhere(flatBytes);
      assert.ok((await readPageTexts(flatBytes))[0].includes("PT Contoh Ünïcode"), template);
    }
    await writeFile(join(inputDirectory, "plain.pdf"), await buildFormPdf());
    const plain = await runOperation("fill_pdf_form", { template: "plain.pdf", fields, password: "not needed", file_name: "plain" }, AS_TOOL);
    assert.equal(plain.data.was_protected, false);
    assert.deepEqual([(await runOperation("describe_template", { template: "plain.pdf" }, AS_TOOL)).data.is_protected, mayBeProtected(await buildFormPdf())], [false, false]);
  }));

test("fill_pdf_form: a PDF that asks for a password opens only with the password given, which appears in no result and no message", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    for (const bits of [128, 256]) {
      const template = `locked-${bits}.pdf`;
      await writeFile(join(inputDirectory, template), await protectPdf(await buildFormPdf(), { bits, openPassword: OPEN_PASSWORD, permissionsPassword: PERMISSIONS_PASSWORD }));
      const messages = [];
      const refusedWith = (pattern) => (error) => messages.push(error.message) > 0 && isRefused(pattern)(error);
      for (const operation of ["describe_template", "fill_pdf_form"]) {
        await assert.rejects(runOperation(operation, { template, fields, file_name: "never" }, AS_TOOL), refusedWith(/asks for a password.*Give that password as `password`/), operation);
        await assert.rejects(runOperation(operation, { template, fields, password: "", file_name: "never" }, AS_TOOL), refusedWith(/asks for a password/), operation);
        await assert.rejects(runOperation(operation, { template, fields, password: "a guess", file_name: "never" }, AS_TOOL), refusedWith(/is not a password of this PDF/), operation);
        await assert.rejects(runOperation(operation, { template, fields, password: "two\nlines", file_name: "never" }, AS_TOOL), refusedWith(/one line of at most 256 characters/), operation);
      }
      const described = await runOperation("describe_template", { template, password: OPEN_PASSWORD }, AS_TOOL);
      assert.deepEqual([described.data.is_protected, described.data.filling_allowed, described.data.fields.length], [true, true, 5]);
      const filled = await runOperation("fill_pdf_form", { template, fields, password: OPEN_PASSWORD, file_name: `opened-${bits}` }, AS_TOOL);
      assert.ok((await readPageTexts((await readFile(filled.data.path))))[0].includes("INV-7"));
      await assertOpensEverywhere(await readFile(filled.data.path));
      const everythingSaid = JSON.stringify([described, filled, messages]);
      for (const secret of [OPEN_PASSWORD, PERMISSIONS_PASSWORD, "a guess"]) assert.equal(everythingSaid.includes(secret), false, secret);
    }
  }));

test("fill_pdf_form: a form its publisher locked against filling in is listed but not filled, unless the permissions password is given", options, () =>
  withDocumentRunner({}, async ({ runOperation, inputDirectory }) => {
    for (const bits of [40, 128, 256]) {
      const template = `no-filling-${bits}.pdf`;
      await writeFile(join(inputDirectory, template), await protectPdf(await buildFormPdf(), { bits, isFillingAllowed: false, permissionsPassword: PERMISSIONS_PASSWORD }));
      const described = await runOperation("describe_template", { template }, AS_TOOL);
      assert.deepEqual([described.data.kind, described.data.is_protected, described.data.filling_allowed, described.data.fields.length], ["pdf_form", true, false, 5], template);
      assert.match(described.data.hint, /locked it against being filled in.*permissions password/);
      await assert.rejects(runOperation("fill_pdf_form", { template, fields, file_name: "never" }, AS_TOOL), isRefused(/locked it against being filled in.*permissions password.*`password`/), template);
      await assert.rejects(runOperation("fill_pdf_form", { template, fields, password: "not it", file_name: "never" }, AS_TOOL), isRefused(/is not a password of this PDF/), template);
      const unlocked = await runOperation("fill_pdf_form", { template, fields, password: PERMISSIONS_PASSWORD, file_name: `unlocked-${bits}` }, AS_TOOL);
      assert.ok((await readPageTexts(await readFile(unlocked.data.path)))[0].includes("INV-7"), template);
      assert.equal((await runOperation("describe_template", { template, password: PERMISSIONS_PASSWORD }, AS_TOOL)).data.filling_allowed, true);
    }
  }));

test("a protected PDF that cannot be read is refused in plain words, and opening leaves the process's exit code and stderr alone", options, async () => {
  const { PDFDocument, PDFHexString } = pdfLib;
  // Marked as protected, with entries no password fits.
  const unreadable = await PDFDocument.load(await buildFormPdf());
  unreadable.context.trailerInfo.Encrypt = unreadable.context.register(unreadable.context.obj({ Filter: "Standard", V: 1, R: 2, O: PDFHexString.of("00".repeat(32)), U: PDFHexString.of("00".repeat(32)), P: -44 }));
  const unreadableBytes = await unreadable.save({ useObjectStreams: false });
  const exitCodeBefore = process.exitCode;
  const writeToStderr = process.stderr.write;
  const written = [];
  process.stderr.write = (chunk) => written.push(String(chunk)) > 0;
  try {
    await assert.rejects(openProtectedPdf({ bytes: unreadableBytes }), isRefused(/asks for a password/));
    await assert.rejects(openProtectedPdf({ bytes: Buffer.from("%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >> endobj\nnot a real file") }), isRefused(/not a PDF that can be opened here: /));
    await assert.rejects(openProtectedPdf({ bytes: unreadableBytes, password: 42 }), isRefused(/`password` must be a text/));
  } finally {
    process.stderr.write = writeToStderr;
  }
  assert.deepEqual([process.exitCode, written], [exitCodeBefore, []]);
});

test("a protected form is filled through the real worker process", options, () =>
  withDocumentRunner({ runTask: createWorkerLauncher() }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "locked.pdf"), await protectPdf(await buildFormPdf(), { openPassword: OPEN_PASSWORD }));
    const filled = await runOperation("fill_pdf_form", { template: "locked.pdf", fields, password: OPEN_PASSWORD, file_name: "from-worker" }, AS_TOOL);
    assert.equal(filled.data.was_protected, true);
    assert.ok((await readPageTexts(await readFile(filled.data.path)))[0].includes("INV-7"));
    await assert.rejects(runOperation("fill_pdf_form", { template: "locked.pdf", fields, file_name: "never" }, AS_TOOL), isRefused(/asks for a password/));
  }));

test("fill_pdf_form: the most boxes a form may have is a setting", options, () =>
  withDocumentRunner({ environment: { DOCUMENT_TEMPLATES_MAX_FORM_FIELDS: "4" } }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "form.pdf"), await buildFormPdf());
    for (const operation of ["describe_template", "fill_pdf_form"]) {
      await assert.rejects(runOperation(operation, { template: "form.pdf", fields: { Client: "x" }, file_name: "never" }, AS_TOOL), isRefused(/5 form fields, over the limit of 4 \(DOCUMENT_TEMPLATES_MAX_FORM_FIELDS\)/), operation);
    }
    await assert.rejects(runOperation("fill_pdf_form", { template: "form.pdf", fields: { a: 1, b: 2, c: 3, d: 4, e: 5 }, file_name: "never" }, AS_TOOL), isRefused(/1 to 4 form fields/));
  }));
