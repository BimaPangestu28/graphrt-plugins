import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { parsePageSelection } from "../lib/page-ranges.mjs";
import { placeWatermark } from "../lib/pdf-engine.mjs";
import { AS_TOOL, SKIP_WITHOUT_LIBRARIES, pdfLib, readPageTexts, withPdfRunner, writeTestPdf } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES };
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("manifest: local only, no secrets, eight tools, limits env declared", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["info", "extract_text", "merge", "extract_pages", "split", "rotate", "watermark", "images_to_pdf"]);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  for (const variableName of ["PDF_TOOLS_INPUT_DIRS", "PDF_TOOLS_OUTPUT_DIR", "PDF_TOOLS_MAX_PAGES", "PDF_TOOLS_TIMEOUT_MS", "PDF_TOOLS_MAX_MEMORY_MB"]) assert.ok(manifest.permissions.env.includes(variableName));
});

test("page selections: ranges, open ends, order kept, duplicates dropped, bounds checked", () => {
  assert.deepEqual(parsePageSelection("3,1-2,2", 5), [3, 1, 2]);
  assert.deepEqual(parsePageSelection("4-", 5), [4, 5]);
  assert.deepEqual(parsePageSelection("-2", 5), [1, 2]);
  assert.deepEqual(parsePageSelection(undefined, 2), [1, 2]);
  for (const badSelection of ["0", "6", "3-2", "a", "1;2", "", "-"]) assert.throws(() => parsePageSelection(badSelection, 5), { kind: "invalid_input" }, badSelection);
});

test("centred watermark text stays centred when rotated", () => {
  const { x, y } = placeWatermark("center", { width: 200, height: 100 }, { width: 100, height: 0 }, 0);
  assert.deepEqual({ x, y }, { x: 50, y: 50 });
});

test("non-PDF content and files outside the allowlist are refused", () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory, outsideDirectory }) => {
    await writeFile(join(inputDirectory, "fake.pdf"), "hello");
    await writeFile(join(outsideDirectory, "secret.pdf"), "%PDF-1.4");
    await assert.rejects(runOperation("info", { input: "fake.pdf" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("info", { input: join(outsideDirectory, "secret.pdf") }, AS_TOOL), { kind: "not_found" });
  }));

test("info and extract_text read metadata and the text layer per page, with a character cap", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeTestPdf(join(inputDirectory, "doc.pdf"));
    const info = await runOperation("info", { input: "doc.pdf" }, AS_TOOL);
    assert.deepEqual([info.data.page_count, info.data.title, info.data.author, info.data.encrypted], [3, "Test document", "graphrt tests", false]);
    assert.deepEqual(info.data.pages[0], { page: 1, width: 300, height: 200, rotation: 0 });
    const text = await runOperation("extract_text", { input: "doc.pdf", pages: "2-3" }, AS_TOOL);
    assert.deepEqual(text.data.pages.map((page) => page.text), ["Page 2 of doc", "Page 3 of doc"]);
    assert.equal(text.data.truncated, false);
    const capped = await runOperation("extract_text", { input: "doc.pdf", max_chars: 100 }, AS_TOOL);
    assert.equal(capped.data.truncated, false);
  }));

test("the page cap refuses large documents", options, () =>
  withPdfRunner({ environment: { PDF_TOOLS_MAX_PAGES: "2" } }, async ({ runOperation, inputDirectory }) => {
    await writeTestPdf(join(inputDirectory, "doc.pdf"));
    await assert.rejects(runOperation("extract_text", { input: "doc.pdf" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("rotate", { input: "doc.pdf" }, AS_TOOL), { kind: "invalid_input" });
  }));

test("merge, extract_pages and split write new PDFs with the right pages", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeTestPdf(join(inputDirectory, "a.pdf"), { pageCount: 2, label: "a" });
    await writeTestPdf(join(inputDirectory, "b.pdf"), { pageCount: 3, label: "b" });
    const merged = await runOperation("merge", { inputs: ["a.pdf", "b.pdf"] }, AS_TOOL);
    assert.equal(merged.data.page_count, 5);
    assert.match(merged.data.file_name, /^merged-.*\.pdf$/);
    assert.deepEqual(await readPageTexts(await readFile(merged.data.path)), ["Page 1 of a", "Page 2 of a", "Page 1 of b", "Page 2 of b", "Page 3 of b"]);
    const extracted = await runOperation("extract_pages", { input: "b.pdf", pages: "3,1" }, AS_TOOL);
    assert.deepEqual(await readPageTexts(await readFile(extracted.data.path)), ["Page 3 of b", "Page 1 of b"]);
    const split = await runOperation("split", { input: "b.pdf", ranges: ["1-2", "3"] }, AS_TOOL);
    assert.deepEqual(split.data.files.map((file) => file.pages), [[1, 2], [3]]);
    assert.match(split.data.files[1].file_name, /^b-part2-/);
    const perPage = await runOperation("split", { input: "b.pdf" }, AS_TOOL);
    assert.equal(perPage.data.files.length, 3);
    assert.equal((await readdir(outputDirectory)).length, 7);
    await assert.rejects(runOperation("merge", { inputs: ["a.pdf"] }, AS_TOOL), { kind: "invalid_input" });
  }));

test("rotate adds to the current rotation; watermark draws on the selected pages only", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeTestPdf(join(inputDirectory, "doc.pdf"));
    const rotated = await runOperation("rotate", { input: "doc.pdf", degrees: 270, pages: "2" }, AS_TOOL);
    const rotatedDocument = await pdfLib.PDFDocument.load(await readFile(rotated.data.path));
    assert.deepEqual(rotatedDocument.getPages().map((page) => page.getRotation().angle), [0, 270, 0]);
    const marked = await runOperation("watermark", { input: "doc.pdf", text: "CONFIDENTIAL", font_size: 12, pages: "1,3", color: "#00f" }, AS_TOOL);
    assert.deepEqual(marked.data.watermarked_pages, [1, 3]);
    const texts = await readPageTexts(await readFile(marked.data.path));
    assert.ok(texts[0].includes("CONFIDENTIAL") && !texts[1].includes("CONFIDENTIAL") && texts[2].includes("CONFIDENTIAL"));
    await assert.rejects(runOperation("watermark", { input: "doc.pdf", text: "日本語" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("watermark", { input: "doc.pdf", text: "x", color: "red" }, AS_TOOL), { kind: "invalid_input" });
  }));

test("images_to_pdf takes jpeg/png by content, one page each", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "dot.png"), PNG_1X1);
    await writeFile(join(inputDirectory, "fake.png"), "<svg/>");
    const built = await runOperation("images_to_pdf", { images: ["dot.png", "dot.png"], page_size: "a4", margin: 36 }, AS_TOOL);
    const document = await pdfLib.PDFDocument.load(await readFile(built.data.path));
    assert.equal(document.getPageCount(), 2);
    assert.equal(Math.round(document.getPage(0).getWidth()), 595);
    await assert.rejects(runOperation("images_to_pdf", { images: ["fake.png"] }, AS_TOOL), { kind: "invalid_input" });
  }));

test("encrypted PDFs are refused with a clear message", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory }) => {
    const encryptedPdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n3 0 obj<</Filter/Standard/V 1/R 2/O(x)/U(y)/P -4>>endobj\ntrailer<</Root 1 0 R/Encrypt 3 0 R/Size 4>>\n%%EOF";
    await writeFile(join(inputDirectory, "locked.pdf"), encryptedPdf);
    await assert.rejects(runOperation("merge", { inputs: ["locked.pdf", "locked.pdf"] }, AS_TOOL), (error) => error.kind === "invalid_input" && /encrypted/.test(error.message));
    assert.equal((await runOperation("info", { input: "locked.pdf" }, AS_TOOL)).data.encrypted, true);
  }));

test("review regression: merge and images_to_pdf refuse inputs whose combined size passes the total cap", options, () =>
  withPdfRunner({ environment: { PDF_TOOLS_MAX_TOTAL_INPUT_BYTES: "3000" } }, async ({ runOperation, inputDirectory }) => {
    await writeTestPdf(join(inputDirectory, "a.pdf"), { pageCount: 20 });
    await writeTestPdf(join(inputDirectory, "b.pdf"), { pageCount: 20 });
    assert.ok((await readFile(join(inputDirectory, "a.pdf"))).length > 1500);
    await writeFile(join(inputDirectory, "dot.png"), Buffer.concat([PNG_1X1, Buffer.alloc(1600)]));
    await assert.rejects(runOperation("merge", { inputs: ["a.pdf", "b.pdf"] }, AS_TOOL), (error) => error.kind === "invalid_input" && /PDF_TOOLS_MAX_TOTAL_INPUT_BYTES/.test(error.message));
    await assert.rejects(runOperation("images_to_pdf", { images: ["dot.png", "dot.png"] }, AS_TOOL), (error) => /PDF_TOOLS_MAX_TOTAL_INPUT_BYTES/.test(error.message));
  }));

test("review regression: a split that fails partway removes the parts already written and names them", options, () =>
  withPdfRunner({}, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeTestPdf(join(inputDirectory, "doc.pdf"), { pageCount: 30 });
    const small = await runOperation("split", { input: "doc.pdf", ranges: ["1"] }, AS_TOOL);
    const capBytes = small.data.files[0].size_bytes + 500;
    await withPdfRunner({ environment: { PDF_TOOLS_INPUT_DIRS: inputDirectory, PDF_TOOLS_OUTPUT_DIR: outputDirectory, PDF_TOOLS_MAX_OUTPUT_BYTES: String(capBytes) } }, async (capped) => {
      const before = await readdir(outputDirectory);
      await assert.rejects(capped.runOperation("split", { input: "doc.pdf", ranges: ["1", "1-30"] }, AS_TOOL), (error) => error.kind === "invalid_input" && /removed the 1 file\(s\) already written: doc-part1-/.test(error.message));
      assert.deepEqual(await readdir(outputDirectory), before);
    });
  }));
