/**
 * Settings and the client one qr-code call works with: allowlisted image
 * reads (content and pixel checks), and new output files in QR_CODE_OUTPUT_DIR.
 */
import { createFileAccess, fileAccessVariableNames, readFileAccessSettings } from "./file-access.mjs";
import { readInteger } from "./environment-readers.mjs";
import { assertRasterFormat } from "./raster-format.mjs";
import { readImageDimensions } from "./image-dimensions.mjs";
import { invalidInput } from "./errors.mjs";

export const ENVIRONMENT_PREFIX = "QR_CODE";
export const FILE_VARIABLES = fileAccessVariableNames(ENVIRONMENT_PREFIX);
export const MAX_PIXELS_VARIABLE = "QR_CODE_MAX_INPUT_PIXELS";
export const MAX_OUTPUT_PIXELS_VARIABLE = "QR_CODE_MAX_OUTPUT_PIXELS";
/** Formats the zxing decoder reads (stb_image); webp, tiff and avif are not among them. */
export const DECODABLE_FORMATS = ["png", "jpeg", "gif", "bmp"];
const MEBIBYTE = 1024 ** 2;

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{files, maxInputPixels, maxOutputPixels}` (object)
 */
export function readQrSettings(environment = {}) {
  return {
    files: readFileAccessSettings(environment, { prefix: ENVIRONMENT_PREFIX, defaultMaxInputBytes: 25 * MEBIBYTE, defaultMaxOutputBytes: 10 * MEBIBYTE, maxBytesCeiling: 512 * MEBIBYTE }),
    maxInputPixels: readInteger(environment, MAX_PIXELS_VARIABLE, 40_000_000, { minimum: 10_000, maximum: 400_000_000 }),
    maxOutputPixels: readInteger(environment, MAX_OUTPUT_PIXELS_VARIABLE, 4096 * 4096, { minimum: 1024, maximum: 100_000_000 }),
  };
}

/**
 * Creates the client for one call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{fileAccessDependencies}` overrides for tests (object, optional)
 * @returns `{settings, fileAccess, readDecodableImage}` (object)
 */
export function createQrClient(environment, dependencies = {}) {
  const settings = readQrSettings(environment);
  const fileAccess = createFileAccess(settings.files, dependencies.fileAccessDependencies);
  return { settings, fileAccess, readDecodableImage: (rawPath) => readDecodableImage(fileAccess, settings, rawPath) };
}

async function readDecodableImage(fileAccess, settings, rawPath) {
  const { path, bytes } = await fileAccess.readInputFile(rawPath);
  const format = assertRasterFormat(bytes, DECODABLE_FORMATS, "`input`");
  const { width, height } = readImageDimensions(bytes, format);
  if (width * height > settings.maxInputPixels) {
    throw invalidInput(`The image is ${width}x${height}, over the ${settings.maxInputPixels}-pixel limit (${MAX_PIXELS_VARIABLE})`);
  }
  return { path, bytes, format, width, height };
}
