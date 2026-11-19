import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { chooseOutputFormat, mapSharpError } from "../lib/client.mjs";
import { classifyImportError } from "../lib/errors.mjs";
import { detectRasterFormat } from "../lib/raster-format.mjs";
import { buildTextSvg, computeOverlayPosition, escapeXml, normalizeHexColor } from "../lib/watermark.mjs";
import { AS_TOOL, SKIP_WITHOUT_SHARP, sharp, withImageRunner, writeTestImage } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_SHARP };

test("manifest: local only, no secrets, eight tools, pixel cap env declared", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["metadata", "resize", "crop", "rotate", "convert", "compress", "thumbnails", "watermark"]);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  for (const variableName of ["IMAGE_TOOLS_INPUT_DIRS", "IMAGE_TOOLS_OUTPUT_DIR", "IMAGE_TOOLS_MAX_INPUT_PIXELS", "IMAGE_TOOLS_TIMEOUT_SECONDS"]) assert.ok(manifest.permissions.env.includes(variableName));
});

test("raster detection by content: SVG, PDF and text are not images", () => {
  assert.equal(detectRasterFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "png");
  assert.equal(detectRasterFormat(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(detectRasterFormat(Buffer.from("\0\0\0\x1cftypavif")), "avif");
  for (const notImage of ["<svg xmlns='http://www.w3.org/2000/svg'/>", "%PDF-1.7", "hello", ""]) assert.equal(detectRasterFormat(Buffer.from(notImage)), null);
});

test("watermark helpers: hex colours, XML escaping, overlay placement kept inside the image", () => {
  assert.equal(normalizeHexColor("#FFF"), "#ffffff");
  assert.throws(() => normalizeHexColor("red; fill:url(file:///etc/passwd)"), { kind: "invalid_input" });
  assert.equal(escapeXml(`<a href="x">&'\u0001`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  const { svg } = buildTextSvg({ text: "</text><image href='file:///etc/passwd'/>", fontSize: 20, color: "#ffffff", opacity: 0.5, maxWidth: 100, maxHeight: 50 });
  assert.ok(!svg.includes("<image"));
  assert.deepEqual(computeOverlayPosition("bottom-right", { width: 100, height: 50 }, { width: 20, height: 10 }, 5), { left: 75, top: 35 });
  assert.deepEqual(computeOverlayPosition("center", { width: 100, height: 50 }, { width: 20, height: 10 }, 5), { left: 40, top: 20 });
  assert.deepEqual(computeOverlayPosition("top-left", { width: 10, height: 10 }, { width: 20, height: 20 }, 5), { left: 0, top: 0 });
});

test("output format choice and sharp error mapping", () => {
  assert.equal(chooseOutputFormat(undefined, "heif"), "jpeg");
  assert.equal(chooseOutputFormat(undefined, "bmp"), "png");
  assert.equal(chooseOutputFormat("avif", "png"), "avif");
  const settings = { timeoutSeconds: 5 };
  assert.equal(mapSharpError(new Error("Input image exceeds pixel limit"), settings).kind, "invalid_input");
  assert.equal(mapSharpError(new Error("timeout: 30% complete"), settings).kind, "timeout");
  assert.equal(mapSharpError(new Error("something else"), settings).kind, "plugin_error");
});

test("without sharp installed every image call is setup_required", () => {
  const missingSharp = async () => {
    throw classifyImportError("sharp", "image-tools", Object.assign(new Error("Cannot find package 'sharp'"), { code: "ERR_MODULE_NOT_FOUND" }));
  };
  return withImageRunner({ dependencies: { loadSharp: missingSharp } }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await assert.rejects(runOperation("metadata", { input: "a.png" }, AS_TOOL), { kind: "setup_required" });
  });
});

test("non-raster content is refused whatever the extension; outside files are not_found", () =>
  withImageRunner({}, async ({ runOperation, inputDirectory, outsideDirectory }) => {
    await writeFile(join(inputDirectory, "vector.png"), "<svg xmlns='http://www.w3.org/2000/svg'><image href='file:///etc/passwd'/></svg>");
    await writeFile(join(inputDirectory, "doc.jpg"), "%PDF-1.4");
    await writeFile(join(outsideDirectory, "x.png"), "x");
    await assert.rejects(runOperation("metadata", { input: "vector.png" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("metadata", { input: "doc.jpg" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("metadata", { input: join(outsideDirectory, "x.png") }, AS_TOOL), { kind: "not_found" });
  }));

test("metadata reports displayed size after EXIF orientation", options, () =>
  withImageRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeTestImage(join(inputDirectory, "phone.jpg"), { width: 400, height: 200, orientation: 6 });
    const { data } = await runOperation("metadata", { input: "phone.jpg" }, AS_TOOL);
    assert.deepEqual([data.format, data.width, data.height, data.orientation, data.has_exif], ["jpeg", 200, 400, 6, true]);
  }));

test("decompression bombs: images over the pixel cap are refused before decoding", options, () =>
  withImageRunner({ environment: { IMAGE_TOOLS_MAX_INPUT_PIXELS: "1000000" } }, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeTestImage(join(inputDirectory, "big.png"), { width: 1100, height: 1000 });
    await assert.rejects(runOperation("resize", { input: "big.png", target_width: 10 }, AS_TOOL), { kind: "invalid_input" });
    const tinyHugePng = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    await writeFile(join(inputDirectory, "bomb.png"), tinyHugePng);
    assert.ok(tinyHugePng.length < 50000);
    await assert.rejects(runOperation("convert", { input: "bomb.png", format: "webp" }, AS_TOOL), { kind: "invalid_input" });
    assert.deepEqual(await readdir(outputDirectory), []);
  }));

test("resize, crop, rotate, convert and compress write new files with the expected sizes, without EXIF", options, () =>
  withImageRunner({}, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeTestImage(join(inputDirectory, "card.jpg"), { width: 400, height: 200, orientation: 6 });
    const resized = await runOperation("resize", { input: "card.jpg", target_width: "100" }, AS_TOOL);
    assert.deepEqual([resized.data.width, resized.data.height, resized.data.format], [100, 200, "jpeg"]);
    assert.equal((await sharp(resized.data.path).metadata()).exif, undefined);
    const cropped = await runOperation("crop", { input: "card.jpg", left: 10, top: 20, crop_width: 50, crop_height: 60, format: "png" }, AS_TOOL);
    assert.deepEqual([cropped.data.width, cropped.data.height], [50, 60]);
    await assert.rejects(runOperation("crop", { input: "card.jpg", left: 190, top: 0, crop_width: 50, crop_height: 10 }, AS_TOOL), { kind: "invalid_input" });
    const rotated = await runOperation("rotate", { input: "card.jpg", angle: 90, flop: true }, AS_TOOL);
    assert.deepEqual([rotated.data.width, rotated.data.height], [400, 200]);
    const avif = await runOperation("convert", { input: "card.jpg", format: "avif", quality: 50 }, AS_TOOL);
    assert.equal((await sharp(avif.data.path).metadata()).format, "heif");
    const compressed = await runOperation("compress", { input: "card.jpg", quality: 30, max_dimension: 100 }, AS_TOOL);
    assert.ok(compressed.data.saved_bytes > 0);
    assert.equal((await readdir(outputDirectory)).length, 5);
  }));

test("thumbnails at several widths, never enlarged", options, () =>
  withImageRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeTestImage(join(inputDirectory, "card.png"));
    const { data } = await runOperation("thumbnails", { input: "card.png", widths: "[64, 128, 800]" }, AS_TOOL);
    assert.deepEqual(data.thumbnails.map((thumbnail) => [thumbnail.width, thumbnail.format]), [[64, "webp"], [128, "webp"], [400, "webp"]]);
    assert.match(data.thumbnails[0].file_name, /^card-64w-/);
  }));

test("review regression: thumbnails are all or nothing; a failed one removes the others and names them", options, () =>
  withImageRunner({}, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeTestImage(join(inputDirectory, "card.png"), { width: 1600, height: 800 });
    const sizes = (await runOperation("thumbnails", { input: "card.png", widths: [64, 1600], format: "tiff" }, AS_TOOL)).data.thumbnails.map((thumbnail) => thumbnail.size_bytes);
    assert.ok(sizes[1] > 1024 && sizes[0] < sizes[1] - 1, `sizes ${sizes}`);
    await withImageRunner({ environment: { IMAGE_TOOLS_INPUT_DIRS: inputDirectory, IMAGE_TOOLS_OUTPUT_DIR: outputDirectory, IMAGE_TOOLS_MAX_OUTPUT_BYTES: String(sizes[1] - 1) } }, async (capped) => {
      const before = await readdir(outputDirectory);
      await assert.rejects(capped.runOperation("thumbnails", { input: "card.png", widths: [64, 1600], format: "tiff" }, AS_TOOL), (error) => error.kind === "invalid_input" && /removed the 1 file\(s\) already written: card-64w-/.test(error.message));
      assert.deepEqual(await readdir(outputDirectory), before);
    });
  }));

test("watermark with text or an image keeps the input size; exactly one of them is required", options, () =>
  withImageRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeTestImage(join(inputDirectory, "card.png"));
    await writeTestImage(join(inputDirectory, "logo.png"), { width: 50, height: 50 });
    const texted = await runOperation("watermark", { input: "card.png", text: "© Toko <Maju> & Co", placement: "bottom-right", color: "#fff" }, AS_TOOL);
    assert.deepEqual([texted.data.width, texted.data.height], [400, 200]);
    const stamped = await runOperation("watermark", { input: "card.png", image: "logo.png", placement: "top-left", opacity: 0.5, image_scale: 0.25 }, AS_TOOL);
    assert.deepEqual([stamped.data.width, stamped.data.height], [400, 200]);
    // The logo's blue half at 50% over the card's red half (logo at 16,16, 100 px wide) blends to purple.
    const { data: pixel } = await sharp(stamped.data.path).extract({ left: 100, top: 50, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    assert.ok(pixel[0] > 90 && pixel[0] < 170 && pixel[2] > 90 && pixel[2] < 170, `pixel ${[...pixel]}`);
    const { data: untouched } = await sharp(stamped.data.path).extract({ left: 150, top: 150, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...untouched].slice(0, 3), [255, 0, 0]);
    await assert.rejects(runOperation("watermark", { input: "card.png" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("watermark", { input: "card.png", text: "x", image: "logo.png" }, AS_TOOL), { kind: "invalid_input" });
  }));
