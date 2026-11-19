/**
 * The image client one operation call works with: allowlisted reads checked
 * by content, sharp pipelines with a pixel cap and timeout, and encoding
 * into a new file in IMAGE_TOOLS_OUTPUT_DIR.
 *
 * sharp is loaded lazily, so the plugin starts (and reports setup_required)
 * without node_modules. sharp work runs on libvips threads and cannot be
 * interrupted midway: cancel is checked before and after it, and libvips'
 * own timeout bounds each pipeline.
 */
import { createFileAccess } from "./file-access.mjs";
import { assertRasterFormat } from "./raster-format.mjs";
import { classifyImportError, invalidInput, operationFailed, throwIfCancelled, timedOut } from "./errors.mjs";
import { readImageSettings } from "./settings.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

/** Formats accepted as inputs, recognised by content (never SVG, PDF or other vector/script formats). */
export const INPUT_FORMATS = ["jpeg", "png", "webp", "gif", "tiff", "avif", "heif"];
/** Formats an output may be written as. */
export const OUTPUT_FORMATS = ["jpeg", "png", "webp", "avif", "gif", "tiff"];
const EXTENSIONS = { jpeg: "jpg", png: "png", webp: "webp", avif: "avif", gif: "gif", tiff: "tiff" };

/**
 * Loads sharp, reporting a missing install as setup_required.
 *
 * @returns The sharp constructor (function)
 * @throws PluginError kind `setup_required` - When sharp is not installed
 */
export async function loadSharpModule() {
  const sharpModule = await import("sharp").catch((importError) => {
    throw classifyImportError("sharp", "image-tools", importError);
  });
  return sharpModule.default;
}

/**
 * Creates the client for one call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{loadSharp, fileAccessDependencies}` overrides for tests (object, optional)
 * @returns `{settings, fileAccess, openImage, encodeImage, saveImage, saveImages}` (object)
 */
export function createImageClient(environment, dependencies = {}) {
  const settings = readImageSettings(environment);
  const context = { settings, fileAccess: createFileAccess(settings.files, dependencies.fileAccessDependencies), loadSharp: dependencies.loadSharp ?? loadSharpModule };
  return {
    settings,
    fileAccess: context.fileAccess,
    openImage: (rawPath, parameterName) => openImage(context, rawPath, parameterName),
    encodeImage: (request) => encodeImage(context, request),
    saveImage: (request) => saveImage(context, request),
    saveImages: (requests) => saveImages(context, requests),
  };
}

/**
 * Reads an allowlisted image and prepares sharp for it.
 *
 * @param context - Client context (object)
 * @param rawPath - Path argument (string)
 * @param parameterName - For messages (string, default "input")
 * @returns `{realPath, bytes, format, metadata, createPipeline}`; metadata.width/height are after EXIF orientation (object)
 */
async function openImage(context, rawPath, parameterName = "input") {
  const { path: realPath, bytes } = await context.fileAccess.readInputFile(rawPath, { parameterName });
  const format = assertRasterFormat(bytes, INPUT_FORMATS, `\`${parameterName}\``);
  const sharp = await context.loadSharp();
  const createPipeline = (sourceBytes = bytes) =>
    sharp(sourceBytes, { limitInputPixels: context.settings.maxInputPixels, failOn: "error", animated: false, sequentialRead: true }).timeout({ seconds: context.settings.timeoutSeconds });
  const metadata = await runSharp(() => createPipeline().metadata(), context.settings);
  assertWithinPixelCap(metadata, context.settings);
  return { realPath, bytes, format, metadata: { ...metadata, ...orientedSize(metadata) }, createPipeline, sharp };
}

// metadata() reads only the header, so the pixel cap is checked here before any decoding.
function assertWithinPixelCap(metadata, settings) {
  if ((metadata.width ?? 0) * (metadata.height ?? 0) > settings.maxInputPixels) {
    throw invalidInput(`The image is ${metadata.width}x${metadata.height}, over the ${settings.maxInputPixels}-pixel limit (IMAGE_TOOLS_MAX_INPUT_PIXELS)`);
  }
}

/**
 * Width and height as displayed: EXIF orientations 5-8 swap the sides.
 *
 * @param metadata - sharp metadata (object)
 * @returns `{width, height}` (object)
 */
export function orientedSize(metadata) {
  const isSwapped = (metadata.orientation ?? 1) >= 5;
  return isSwapped ? { width: metadata.height, height: metadata.width } : { width: metadata.width, height: metadata.height };
}

/**
 * Encodes a pipeline and writes it as a new output file.
 *
 * @param context - Client context (object)
 * @param request - `{pipeline, format, quality, nameHint, signal}` (object)
 * @returns `{path, file_name, size_bytes, format, width, height}` (object)
 */
async function saveImage(context, request) {
  const [savedImage] = await saveImages(context, [request]);
  return savedImage;
}

/**
 * Encodes one pipeline to bytes (checking cancel before and after, since sharp cannot be interrupted).
 *
 * @param context - Client context (object)
 * @param request - `{pipeline, format, quality, signal}` (object)
 * @returns `{data, info}` from sharp (object)
 */
async function encodeImage(context, { pipeline, format, quality, signal }) {
  throwIfCancelled(signal, "Image processing");
  const encoded = await runSharp(() => applyEncoder(pipeline, format, quality).toBuffer({ resolveWithObject: true }), context.settings);
  throwIfCancelled(signal, "Image processing");
  return encoded;
}

// Encodes everything first, then writes all or nothing (a failed write removes the files already written).
async function saveImages(context, requests) {
  const encodedImages = [];
  for (const request of requests) encodedImages.push(await encodeImage(context, request));
  const items = encodedImages.map((encoded, index) => ({ naming: { nameHint: requests[index].nameHint, extension: EXTENSIONS[requests[index].format] }, bytes: encoded.data }));
  const outputFiles = await context.fileAccess.writeOutputFiles(items);
  return outputFiles.map((outputFile, index) => ({ ...outputFile, format: requests[index].format, width: encodedImages[index].info.width, height: encodedImages[index].info.height }));
}

/**
 * Applies the encoder for an output format. Metadata (EXIF, GPS) is not copied to outputs.
 *
 * @param pipeline - sharp instance (object)
 * @param format - One of OUTPUT_FORMATS (string)
 * @param quality - 1-100, or undefined for the encoder's default (number, optional)
 * @returns The pipeline (object)
 */
export function applyEncoder(pipeline, format, quality) {
  const qualityOption = quality === undefined ? {} : { quality };
  const encoders = {
    jpeg: () => pipeline.jpeg({ mozjpeg: true, ...qualityOption }),
    png: () => pipeline.png({ compressionLevel: 9, ...(quality === undefined ? {} : { palette: quality < 100, quality }) }),
    webp: () => pipeline.webp(qualityOption),
    avif: () => pipeline.avif(qualityOption),
    gif: () => pipeline.gif(),
    tiff: () => pipeline.tiff({ compression: "lzw", ...qualityOption }),
  };
  if (!encoders[format]) throw invalidInput(`\`format\` must be one of ${OUTPUT_FORMATS.join(", ")}`);
  return encoders[format]();
}

/**
 * Chooses an output format: the requested one, else the input's own format when sharp can write it, else png.
 *
 * @param requestedFormat - `format` argument (string, optional)
 * @param inputFormat - Detected input format (string)
 * @returns One of OUTPUT_FORMATS (string)
 */
export function chooseOutputFormat(requestedFormat, inputFormat) {
  if (requestedFormat) return requestedFormat;
  if (inputFormat === "heif") return "jpeg";
  return OUTPUT_FORMATS.includes(inputFormat) ? inputFormat : "png";
}

async function runSharp(work, settings) {
  try {
    return await work();
  } catch (sharpError) {
    throw mapSharpError(sharpError, settings);
  }
}

/**
 * Maps sharp/libvips errors to plugin error kinds.
 *
 * @param sharpError - Thrown by sharp (Error)
 * @param settings - For the timeout value (object)
 * @returns PluginError
 */
export function mapSharpError(sharpError, settings) {
  if (sharpError instanceof PluginError) return sharpError;
  const message = String(sharpError?.message ?? sharpError);
  if (/timeout/i.test(message)) return timedOut("Image processing", settings.timeoutSeconds * 1000);
  if (/pixel limit|unsupported image format|corrupt|premature end|bad seek|Invalid|not a known file format|VipsForeignLoad/i.test(message)) {
    return invalidInput(`The image could not be processed: ${message}`);
  }
  return operationFailed(`Image processing failed: ${message}`);
}
