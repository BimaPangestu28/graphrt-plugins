/**
 * QR generation (`qrcode`) and decoding (`zxing-wasm`, the ZXing C++ reader
 * compiled to WebAssembly). Both are loaded lazily.
 *
 * zxing-wasm fetches its .wasm from a CDN by default; the plugin always hands
 * it the copy inside node_modules instead, so decoding never touches the
 * network.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { classifyImportError, invalidInput, operationFailed } from "./errors.mjs";

const requireFromHere = createRequire(import.meta.url);
let readerModulePromise = null;

async function importPackage(packageName, specifier = packageName) {
  return import(specifier).catch((importError) => {
    throw classifyImportError(packageName, "qr-code", importError);
  });
}

/**
 * Loads the zxing reader once per process with the local wasm binary.
 *
 * @returns The zxing-wasm reader module (object)
 * @throws PluginError kind `setup_required` - When zxing-wasm is not installed
 */
export function loadZxingReader() {
  readerModulePromise ??= prepareZxingReader().catch((loadError) => {
    readerModulePromise = null;
    throw loadError;
  });
  return readerModulePromise;
}

async function prepareZxingReader() {
  const reader = await importPackage("zxing-wasm", "zxing-wasm/reader");
  const wasmBinary = await readFile(requireFromHere.resolve("zxing-wasm/reader/zxing_reader.wasm"));
  await reader.prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
  return reader;
}

/**
 * Renders a QR code.
 *
 * @param request - `{text, format, errorCorrection, margin, moduleSize, imageSize, darkColor, lightColor, maxPixels}` (object)
 * @returns PNG bytes (Buffer) or SVG text as bytes (Buffer)
 * @throws PluginError kind `invalid_input` - When the text does not fit in a QR code, or a PNG would exceed maxPixels
 */
export async function renderQrCode({ text, format, errorCorrection, margin, moduleSize, imageSize, darkColor, lightColor, maxPixels }) {
  const { default: QRCode } = await importPackage("qrcode");
  const options = { errorCorrectionLevel: errorCorrection, margin, scale: moduleSize, color: { dark: darkColor, light: lightColor }, ...(imageSize ? { width: imageSize } : {}) };
  if (format === "png") assertPngWithinPixels(QRCode, text, { errorCorrection, margin, moduleSize, imageSize, maxPixels });
  try {
    return format === "svg" ? Buffer.from(await QRCode.toString(text, { ...options, type: "svg" }), "utf8") : await QRCode.toBuffer(text, { ...options, type: "png" });
  } catch (renderError) {
    if (/too big|amount of data/i.test(renderError.message)) throw invalidInput(`\`text\` is too long for a QR code at error correction ${errorCorrection}: ${renderError.message}`);
    throw operationFailed(`Could not render the QR code: ${renderError.message}`);
  }
}

/**
 * Works out the PNG side length (modules plus margin, times the module size, or image_size) and refuses it over the cap.
 *
 * @param QRCode - The qrcode module (object)
 * @param text - Text to encode (string)
 * @param options - `{errorCorrection, margin, moduleSize, imageSize, maxPixels}` (object)
 * @returns Side length in pixels (number)
 * @throws PluginError kind `invalid_input` - When the image would be over maxPixels, or the text does not fit
 */
export function assertPngWithinPixels(QRCode, text, { errorCorrection, margin, moduleSize, imageSize, maxPixels }) {
  let moduleCount;
  try {
    moduleCount = QRCode.create(text, { errorCorrectionLevel: errorCorrection }).modules.size;
  } catch (createError) {
    throw invalidInput(`\`text\` is too long for a QR code at error correction ${errorCorrection}: ${createError.message}`);
  }
  const side = imageSize ?? (moduleCount + margin * 2) * moduleSize;
  if (side * side > maxPixels) {
    throw invalidInput(`The PNG would be ${side}x${side} pixels, over the ${maxPixels}-pixel limit (QR_CODE_MAX_OUTPUT_PIXELS); lower module_size or set image_size`);
  }
  return side;
}

/**
 * Decodes the QR codes in an image file's bytes.
 *
 * @param bytes - png/jpeg/gif/bmp contents (Buffer)
 * @param options - `{maxCodes, tryHarder}` (object)
 * @returns `[{text, format, is_valid, error_correction_level, position}]` (object[])
 */
export async function decodeQrCodes(bytes, { maxCodes, tryHarder }) {
  const reader = await loadZxingReader();
  const results = await reader.readBarcodes(new Uint8Array(bytes), { formats: ["QRCode", "MicroQRCode", "rMQRCode"], tryHarder, tryRotate: tryHarder, tryInvert: tryHarder, maxNumberOfSymbols: maxCodes }).catch((decodeError) => {
    throw invalidInput(`The image could not be decoded: ${decodeError.message}`);
  });
  return results.filter((result) => result.isValid).map((result) => ({
    text: result.text,
    format: result.format,
    content_type: result.contentType ?? null,
    error_correction_level: result.ecLevel || null,
    position: result.position,
  }));
}
