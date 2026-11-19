import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition, pluginDefinition } from "../definition.mjs";
import { readImageDimensions } from "../lib/image-dimensions.mjs";

const AS_TOOL = { source: "tool" };
const librariesInstalled = (await import("qrcode").then(() => true, () => false)) && (await import("zxing-wasm/reader").then(() => true, () => false));
const options = { skip: librariesInstalled ? false : "qrcode/zxing-wasm are not installed (run npm install in qr-code)" };
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  throw new Error("network is not allowed in qr-code tests");
};

async function withQrRunner(environment, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-qr-test-")));
  const directories = { inputDirectory: join(baseDirectory, "in"), outputDirectory: join(baseDirectory, "out"), outsideDirectory: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const runOperation = createOperationRunner(createPluginDefinition(), { QR_CODE_INPUT_DIRS: directories.inputDirectory, QR_CODE_OUTPUT_DIR: directories.outputDirectory, ...environment });
  try {
    return await work({ runOperation, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

function pngHeaderClaiming(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

test("manifest: local only, no secrets, two tools, pixel cap env declared", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["generate", "decode"]);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  for (const variableName of ["QR_CODE_INPUT_DIRS", "QR_CODE_OUTPUT_DIR", "QR_CODE_MAX_INPUT_PIXELS"]) assert.ok(manifest.permissions.env.includes(variableName));
});

test("image dimensions come from headers: png, gif, bmp, jpeg", () => {
  assert.deepEqual(readImageDimensions(pngHeaderClaiming(300, 200), "png"), { width: 300, height: 200 });
  assert.deepEqual(readImageDimensions(Buffer.from("GIF89a\x0a\x00\x14\x00", "latin1"), "gif"), { width: 10, height: 20 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x78, 0x00, 0xa0, 0x03]);
  assert.deepEqual(readImageDimensions(jpeg, "jpeg"), { width: 160, height: 120 });
  assert.throws(() => readImageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "jpeg"), { kind: "invalid_input" });
});

test("generate a PNG, decode it back, with no network access for the wasm decoder", options, () =>
  withQrRunner({}, async ({ runOperation }) => {
    const generated = await runOperation("generate", { text: "https://example.com/pesan?id=42", error_correction: "H", output_name: "promo" }, AS_TOOL);
    assert.match(generated.data.file_name, /^promo-.*\.png$/);
    const decoded = await runOperation("decode", { input: generated.data.path }, AS_TOOL);
    assert.equal(decoded.data.count, 1);
    assert.equal(decoded.data.codes[0].text, "https://example.com/pesan?id=42");
    assert.equal(decoded.data.codes[0].format, "QRCode");
    assert.deepEqual(fetchCalls, []);
  }));

test("SVG output, inline data, colours validated, oversize text refused", options, () =>
  withQrRunner({}, async ({ runOperation }) => {
    const svg = await runOperation("generate", { text: "halo", format: "svg", dark_color: "#123", include_data: true }, AS_TOOL);
    assert.ok(svg.data.data.startsWith("<svg"));
    assert.ok(svg.data.data.includes("#112233"));
    assert.equal(await readFile(svg.data.path, "utf8"), svg.data.data);
    const png = await runOperation("generate", { text: "halo", image_size: 200, include_data: true }, AS_TOOL);
    assert.ok(png.data.data.startsWith("data:image/png;base64,"));
    await assert.rejects(runOperation("generate", { text: "x", dark_color: "black\" onload=\"x" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("generate", { text: "x".repeat(3000), error_correction: "H" }, AS_TOOL), { kind: "invalid_input" });
  }));

test("decode refuses non-images, unsupported formats, oversized images and outside files", options, () =>
  withQrRunner({ QR_CODE_MAX_INPUT_PIXELS: "1000000" }, async ({ runOperation, inputDirectory, outsideDirectory }) => {
    await writeFile(join(inputDirectory, "huge.png"), pngHeaderClaiming(100000, 100000));
    await writeFile(join(inputDirectory, "vector.png"), "<svg/>");
    await writeFile(join(inputDirectory, "photo.webp"), Buffer.from("RIFF\0\0\0\0WEBPVP8 "));
    await writeFile(join(outsideDirectory, "x.png"), pngHeaderClaiming(10, 10));
    await assert.rejects(runOperation("decode", { input: "huge.png" }, AS_TOOL), (error) => error.kind === "invalid_input" && /pixel limit/.test(error.message));
    await assert.rejects(runOperation("decode", { input: "vector.png" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("decode", { input: "photo.webp" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("decode", { input: join(outsideDirectory, "x.png") }, AS_TOOL), { kind: "not_found" });
  }));

test("an image without a QR code decodes to an empty list", options, () =>
  withQrRunner({}, async ({ runOperation, inputDirectory }) => {
    const blankGif = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
    await writeFile(join(inputDirectory, "blank.gif"), blankGif);
    assert.deepEqual((await runOperation("decode", { input: "blank.gif" }, AS_TOOL)).data.codes, []);
  }));

test("review regression: a PNG over QR_CODE_MAX_OUTPUT_PIXELS is refused before rendering; SVG and small PNGs pass", options, () =>
  withQrRunner({}, async ({ runOperation, outputDirectory }) => {
    const longText = "x".repeat(2000);
    await assert.rejects(runOperation("generate", { text: longText, module_size: 50 }, AS_TOOL), (error) => error.kind === "invalid_input" && /QR_CODE_MAX_OUTPUT_PIXELS/.test(error.message));
    assert.deepEqual(await readdir(outputDirectory), []);
    assert.equal((await runOperation("generate", { text: longText, module_size: 50, format: "svg" }, AS_TOOL)).data.format, "svg");
    assert.equal((await runOperation("generate", { text: longText, image_size: 4096 }, AS_TOOL)).data.format, "png");
    await assert.rejects(runOperation("generate", { text: "x".repeat(4000), error_correction: "H" }, AS_TOOL), (error) => /too long/.test(error.message));
  }));
