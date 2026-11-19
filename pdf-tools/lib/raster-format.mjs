/**
 * Recognises raster image files by their first bytes (not their names).
 *
 * Only plain raster formats pass: SVG, PDF, text lists and anything else a
 * decoder might treat as a script or a list of other files is refused.
 * This file is identical in the image-tools, pdf-tools, ocr-tesseract and
 * qr-code plugins; keep the copies in step.
 */
import { invalidInput } from "./errors.mjs";

const SIGNATURES = [
  { format: "jpeg", matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  { format: "png", matches: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { format: "gif", matches: (bytes) => ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a" },
  { format: "webp", matches: (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP" },
  { format: "tiff", matches: (bytes) => startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]) },
  { format: "bmp", matches: (bytes) => ascii(bytes, 0, 2) === "BM" },
  { format: "avif", matches: (bytes) => ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 12)) },
  { format: "heif", matches: (bytes) => ascii(bytes, 4, 8) === "ftyp" && ["heic", "heix", "mif1", "msf1", "heim", "heis"].includes(ascii(bytes, 8, 12)) },
];

/**
 * Detects the raster format of file bytes.
 *
 * @param bytes - File contents, or at least its first 16 bytes (Buffer | Uint8Array)
 * @returns "jpeg", "png", "gif", "webp", "tiff", "bmp", "avif", "heif", or null (string | null)
 *
 * @example
 * detectRasterFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // "jpeg"
 */
export function detectRasterFormat(bytes) {
  return SIGNATURES.find((signature) => signature.matches(bytes))?.format ?? null;
}

/**
 * Checks that bytes are one of the allowed raster formats.
 *
 * @param bytes - File contents (Buffer | Uint8Array)
 * @param allowedFormats - Formats accepted by the caller (string[])
 * @param label - Parameter or file name for the message (string)
 * @returns The detected format (string)
 * @throws PluginError kind `invalid_input` - When the content is not an allowed raster image
 */
export function assertRasterFormat(bytes, allowedFormats, label) {
  const detectedFormat = detectRasterFormat(bytes);
  if (!detectedFormat || !allowedFormats.includes(detectedFormat)) {
    throw invalidInput(`${label} must be a ${allowedFormats.join(", ")} image (detected from its content: ${detectedFormat ?? "not a supported image"})`);
  }
  return detectedFormat;
}

function startsWith(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes, start, end) {
  if (bytes.length < end) return "";
  return String.fromCharCode(...bytes.subarray(start, end));
}
