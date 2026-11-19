/**
 * Review regressions: decoded-size caps before tesseract or pdftoppm allocate, and redacted messages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readImageDimensions } from "../lib/image-dimensions.mjs";
import { planPdfRender } from "../operations/ocr-operations.mjs";
import { AS_TOOL, createFakeProcessRunner, pngHeaderClaiming, withOcrRunner } from "./helpers.mjs";

test("image headers: png, gif, bmp, jpeg, webp (VP8, VP8L, VP8X) and tiff dimensions; truncated headers refused", () => {
  assert.deepEqual(readImageDimensions(pngHeaderClaiming(300, 200), "png"), { width: 300, height: 200 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x78, 0x00, 0xa0, 0x03]);
  assert.deepEqual(readImageDimensions(jpeg, "jpeg"), { width: 160, height: 120 });
  const vp8x = Buffer.alloc(30);
  vp8x.write("RIFF", 0, "latin1");
  vp8x.write("WEBPVP8X", 8, "latin1");
  vp8x.writeUIntLE(999, 24, 3);
  vp8x.writeUIntLE(499, 27, 3);
  assert.deepEqual(readImageDimensions(vp8x, "webp"), { width: 1000, height: 500 });
  const tiff = Buffer.alloc(40);
  tiff.write("II*\0", 0, "latin1");
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  [[256, 3, 640], [257, 4, 480]].forEach(([tag, type, value], index) => {
    tiff.writeUInt16LE(tag, 10 + index * 12);
    tiff.writeUInt16LE(type, 12 + index * 12);
    if (type === 3) tiff.writeUInt16LE(value, 18 + index * 12);
    else tiff.writeUInt32LE(value, 18 + index * 12);
  });
  assert.deepEqual(readImageDimensions(tiff, "tiff"), { width: 640, height: 480 });
  assert.throws(() => readImageDimensions(Buffer.from("II*\0\xff\xff\xff\x00", "latin1"), "tiff"), { kind: "invalid_input" });
});

test("review regression: an image declaring more than OCR_TESSERACT_MAX_INPUT_PIXELS is refused before tesseract runs", () => {
  const fake = createFakeProcessRunner();
  return withOcrRunner({ runProcess: fake.runProcess, environment: { OCR_TESSERACT_MAX_INPUT_PIXELS: "1000000" } }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "bomb.png"), pngHeaderClaiming(60000, 60000));
    await assert.rejects(runOperation("ocr", { input: "bomb.png" }, AS_TOOL), (error) => error.kind === "invalid_input" && /60000x60000, over the 1000000-pixel limit/.test(error.message));
    assert.ok(fake.requests.every((request) => request.args[0] === "--list-langs"));
  });
});

test("review regression: PDF pages are checked as MediaBox x dpi, and pdftoppm is cropped to the page size", () => {
  assert.deepEqual(planPdfRender(Buffer.from("%PDF-1.4 /MediaBox [0 0 612 792] /MediaBox[0 0 100 100]"), 72, 1e6), { width: 612, height: 792 });
  assert.throws(() => planPdfRender(Buffer.from("%PDF-1.4 /MediaBox [0 0 14400 14400]"), 300, 40_000_000), (error) => error.kind === "invalid_input" && /lower `dpi`/.test(error.message));
  assert.deepEqual(planPdfRender(Buffer.from("%PDF-1.5 (page sizes in object streams)"), 300, 40_000), { width: 200, height: 200 });
  const fake = createFakeProcessRunner();
  return withOcrRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "poster.pdf"), "%PDF-1.4\n3 0 obj<</Type/Page/MediaBox[0 0 14400 14400]>>endobj\n");
    await assert.rejects(runOperation("ocr", { input: "poster.pdf", dpi: 300 }, AS_TOOL), { kind: "invalid_input" });
    assert.ok(fake.requests.every((request) => request.displayName !== "pdftoppm"));
    await writeFile(join(inputDirectory, "letter.pdf"), "%PDF-1.4\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]>>endobj\n");
    await runOperation("ocr", { input: "letter.pdf", dpi: 144 }, AS_TOOL);
    const render = fake.requests.find((request) => request.displayName === "pdftoppm");
    assert.deepEqual(render.args.slice(6, 14), ["-x", "0", "-y", "0", "-W", "1224", "-H", "1584"]);
  });
});

test("review regression: pdftoppm/tesseract failures do not reveal library or temp paths", () => {
  const fake = createFakeProcessRunner({ failWith: "dyld[1]: Library not loaded: /opt/homebrew/opt/gpgme/lib/libgpgmepp.6.dylib\n  Referenced from: /opt/homebrew/Cellar/poppler/lib/libpoppler.dylib" });
  return withOcrRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "letter.pdf"), "%PDF-1.4\n/MediaBox[0 0 612 792]\n");
    await assert.rejects(runOperation("ocr", { input: "letter.pdf" }, AS_TOOL), (error) => error.kind === "setup_required" && error.message.includes("[path]") && !error.message.includes("/opt/homebrew"));
  });
});
