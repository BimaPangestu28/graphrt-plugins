/**
 * Protected (encrypted) PDFs: the kind that opens without a password and
 * only carries its publisher's restrictions, as official forms do, and the
 * kind that asks for a password. The fixtures are protected here with qpdf.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkerLauncher } from "../lib/worker-launcher.mjs";
import { AS_TOOL, SKIP_WITHOUT_LIBRARIES, pdfLib, readPageTexts, withPdfRunner, writeTestPdf } from "./helpers.mjs";
import { protectPdf } from "./protect-pdf.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES };
const OPEN_PASSWORD = "Rahasia sekali é-42";
const PERMISSIONS_PASSWORD = "publisher-only";
const FORMATS = [40, 128, "128-aes", 256];
const isRefused = (pattern) => (error) => error.kind === "invalid_input" && pattern.test(error.message);
// The 40-bit format knows fewer, broader switches than the later ones.
const onlyPrintingForbidden = (bits) => (bits === 40 ? ["--print=n"] : ["--print=none"]);
const everythingForbidden = (bits) => (bits === 40 ? ["--extract=n", "--modify=n", "--annotate=n"] : ["--extract=n", "--modify=none"]);

async function writeProtectedPdf(inputDirectory, fileName, protection) {
  const plainPath = join(inputDirectory, `plain-${fileName}`);
  await writeTestPdf(plainPath, { label: fileName });
  await writeFile(join(inputDirectory, fileName), await protectPdf(await readFile(plainPath), protection));
}

// Loaded without `ignoreEncryption`: pdf-lib refuses any protected file.
async function readUnprotected(filePath) {
  const bytes = await readFile(filePath);
  assert.equal((await pdfLib.PDFDocument.load(bytes)).isEncrypted, false);
  return bytes;
}

// Every operation that reads a PDF, with what it needs from the file.
const READING_OPERATIONS = [
  ["extract_text", {}, /The publisher of input has locked it against having its text copied out/],
  ["merge", {}, /The publisher of inputs\[0\] has locked it against having its pages joined, taken out or rotated/],
  ["extract_pages", { pages: "2" }, /against having its pages joined, taken out or rotated/],
  ["split", {}, /against having its pages joined, taken out or rotated/],
  ["rotate", {}, /against having its pages joined, taken out or rotated/],
  ["watermark", { text: "DRAFT" }, /The publisher of input has locked it against having its pages changed/],
];
const callArguments = (operation, fileName, extra) => ({ ...(operation === "merge" ? { inputs: [fileName, fileName] } : { input: fileName }), ...extra });

test("a PDF that is only restricted is read without a password in every protection format, and results have no protection", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory }) => {
    for (const bits of FORMATS) {
      const fileName = `restricted-${bits}.pdf`;
      await writeProtectedPdf(inputDirectory, fileName, { bits, restrictions: onlyPrintingForbidden(bits) });
      const info = await runOperation("info", { input: fileName }, AS_TOOL);
      assert.deepEqual([info.data.page_count, info.data.encrypted, info.data.password_required, info.data.title, info.data.permissions], [3, true, false, "Test document", { copy_text: true, assemble_pages: true, change_pages: true, fill_forms: true, print: false }], fileName);
      assert.equal((await runOperation("extract_text", { input: fileName }, AS_TOOL)).data.pages[1].text, `Page 2 of ${fileName}`);
      const merged = await runOperation("merge", { inputs: [fileName, `plain-${fileName}`] }, AS_TOOL);
      assert.deepEqual([merged.data.page_count, merged.data.was_protected], [6, true]);
      assert.equal((await readPageTexts(await readUnprotected(merged.data.path))).length, 6);
      const extracted = await runOperation("extract_pages", { input: fileName, pages: "3" }, AS_TOOL);
      assert.deepEqual([await readPageTexts(await readUnprotected(extracted.data.path)), extracted.data.was_protected], [[`Page 3 of ${fileName}`], true]);
      const split = await runOperation("split", { input: fileName }, AS_TOOL);
      assert.deepEqual([split.data.files.length, split.data.was_protected], [3, true]);
      await readUnprotected(split.data.files[0].path);
      const rotated = await runOperation("rotate", { input: fileName, pages: "1" }, AS_TOOL);
      assert.equal((await pdfLib.PDFDocument.load(await readUnprotected(rotated.data.path))).getPage(0).getRotation().angle, 90);
      const watermarked = await runOperation("watermark", { input: fileName, text: "DRAFT" }, AS_TOOL);
      assert.ok((await readPageTexts(await readUnprotected(watermarked.data.path)))[0].includes("DRAFT"), fileName);
    }
    assert.equal((await runOperation("rotate", { input: "plain-restricted-256.pdf", password: "not needed" }, AS_TOOL)).data.was_protected, false);
  }));

test("what the publisher forbids is refused, operation by operation, unless the permissions password is given", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory }) => {
    for (const bits of FORMATS) {
      const fileName = `locked-down-${bits}.pdf`;
      await writeProtectedPdf(inputDirectory, fileName, { bits, restrictions: everythingForbidden(bits), permissionsPassword: PERMISSIONS_PASSWORD });
      const info = await runOperation("info", { input: fileName }, AS_TOOL);
      assert.deepEqual([info.data.page_count, info.data.title, info.data.permissions], [3, "Test document", { copy_text: false, assemble_pages: false, change_pages: false, fill_forms: false, print: true }], fileName);
      for (const [operation, extra, refusal] of READING_OPERATIONS) {
        await assert.rejects(runOperation(operation, callArguments(operation, fileName, extra), AS_TOOL), isRefused(refusal), `${operation} ${fileName}`);
        await assert.rejects(runOperation(operation, callArguments(operation, fileName, { ...extra, password: "not it" }), AS_TOOL), isRefused(/is not a password of input/), `${operation} ${fileName}`);
        const unlocked = await runOperation(operation, callArguments(operation, fileName, { ...extra, password: PERMISSIONS_PASSWORD }), AS_TOOL);
        if (operation !== "extract_text") assert.equal(unlocked.data.was_protected, true, `${operation} ${fileName}`);
      }
      assert.equal((await runOperation("info", { input: fileName, password: PERMISSIONS_PASSWORD }, AS_TOOL)).data.permissions.copy_text, true);
    }
    // Each permission is its own: pages may be rearranged but not changed, text not copied.
    await writeProtectedPdf(inputDirectory, "assembly-only.pdf", { restrictions: ["--extract=n", "--modify=assembly"] });
    assert.deepEqual((await runOperation("info", { input: "assembly-only.pdf" }, AS_TOOL)).data.permissions, { copy_text: false, assemble_pages: true, change_pages: false, fill_forms: false, print: true });
    assert.equal((await runOperation("rotate", { input: "assembly-only.pdf" }, AS_TOOL)).data.was_protected, true);
    await assert.rejects(runOperation("watermark", { input: "assembly-only.pdf", text: "DRAFT" }, AS_TOOL), isRefused(/having its pages changed/));
    await assert.rejects(runOperation("extract_text", { input: "assembly-only.pdf" }, AS_TOOL), isRefused(/having its text copied out/));
  }));

test("a PDF that asks for a password opens only with the password given, which appears in no result and no message", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory }) => {
    for (const bits of [128, 256]) {
      const fileName = `asks-${bits}.pdf`;
      await writeProtectedPdf(inputDirectory, fileName, { bits, openPassword: OPEN_PASSWORD, permissionsPassword: PERMISSIONS_PASSWORD, restrictions: onlyPrintingForbidden(bits) });
      const said = [];
      const refusedWith = (pattern) => (error) => said.push(error.message) > 0 && isRefused(pattern)(error);
      const lockedInfo = await runOperation("info", { input: fileName }, AS_TOOL);
      assert.deepEqual([lockedInfo.data.encrypted, lockedInfo.data.password_required, lockedInfo.data.page_count, lockedInfo.data.title, lockedInfo.data.permissions], [true, true, null, null, null]);
      await assert.rejects(runOperation("info", { input: fileName, password: "a guess" }, AS_TOOL), refusedWith(/is not a password of input/));
      for (const [operation, extra] of READING_OPERATIONS) {
        await assert.rejects(runOperation(operation, callArguments(operation, fileName, extra), AS_TOOL), refusedWith(/A password is needed to open input(s\[0\])?\. Give it as `password`/), operation);
        await assert.rejects(runOperation(operation, callArguments(operation, fileName, { ...extra, password: "a guess" }), AS_TOOL), refusedWith(/is not a password of input/), operation);
        await assert.rejects(runOperation(operation, callArguments(operation, fileName, { ...extra, password: "two\nlines" }), AS_TOOL), refusedWith(/one line of at most 256 characters/), operation);
        said.push(await runOperation(operation, callArguments(operation, fileName, { ...extra, password: OPEN_PASSWORD }), AS_TOOL));
      }
      const info = await runOperation("info", { input: fileName, password: OPEN_PASSWORD }, AS_TOOL);
      assert.deepEqual([info.data.page_count, info.data.title, info.data.password_required, info.data.permissions.print], [3, "Test document", false, false]);
      const merged = await runOperation("merge", { inputs: [fileName, `plain-${fileName}`], password: OPEN_PASSWORD }, AS_TOOL);
      assert.equal((await readPageTexts(await readUnprotected(merged.data.path)))[1], `Page 2 of ${fileName}`);
      const everythingSaid = JSON.stringify([said, lockedInfo, info, merged]);
      for (const secret of [OPEN_PASSWORD, PERMISSIONS_PASSWORD, "a guess"]) assert.equal(everythingSaid.includes(secret), false, secret);
    }
  }));

test("a file marked as protected that nothing can open is refused, and `info` says no more than that it is locked", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory }) => {
    const brokenPdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n3 0 obj<</Filter/Standard/V 1/R 2/O(x)/U(y)/P -4>>endobj\ntrailer<</Root 1 0 R/Encrypt 3 0 R/Size 4>>\n%%EOF";
    await writeFile(join(inputDirectory, "broken.pdf"), brokenPdf);
    await assert.rejects(runOperation("merge", { inputs: ["broken.pdf", "broken.pdf"] }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("extract_text", { input: "broken.pdf" }, AS_TOOL), { kind: "invalid_input" });
  }));

test("a protected PDF goes through the real worker process", options, () =>
  withPdfRunner({ runTask: createWorkerLauncher() }, async ({ runOperation, inputDirectory }) => {
    await writeProtectedPdf(inputDirectory, "asks.pdf", { openPassword: OPEN_PASSWORD, restrictions: onlyPrintingForbidden(256) });
    const rotated = await runOperation("rotate", { input: "asks.pdf", password: OPEN_PASSWORD }, AS_TOOL);
    assert.equal(rotated.data.was_protected, true);
    assert.equal((await readPageTexts(await readUnprotected(rotated.data.path)))[2], "Page 3 of asks.pdf");
    await assert.rejects(runOperation("extract_text", { input: "asks.pdf" }, AS_TOOL), isRefused(/A password is needed to open input/));
  }));
