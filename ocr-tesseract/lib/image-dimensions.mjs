/**
 * Reads width and height from image headers (png, jpeg, gif, bmp, webp,
 * tiff) without decoding, so oversized images are refused before a decoder
 * allocates. This file is identical in the qr-code and ocr-tesseract plugins;
 * keep the copies in step.
 */
import { invalidInput } from "./errors.mjs";

const JPEG_START_OF_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const TIFF_IMAGE_WIDTH_TAG = 256;
const TIFF_IMAGE_LENGTH_TAG = 257;

/**
 * Reads an image's dimensions from its header.
 *
 * @param bytes - Image file contents (Buffer)
 * @param format - "png", "jpeg", "gif", "bmp", "webp" or "tiff" (string)
 * @returns `{width, height}` (object)
 * @throws PluginError kind `invalid_input` - When the header is truncated or malformed
 *
 * @example
 * readImageDimensions(pngBytes, "png"); // { width: 290, height: 290 }
 */
export function readImageDimensions(bytes, format) {
  const readers = {
    png: () => (bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null),
    gif: () => (bytes.length >= 10 ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) } : null),
    bmp: () => (bytes.length >= 26 ? { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) } : null),
    jpeg: () => readJpegDimensions(bytes),
    webp: () => readWebpDimensions(bytes),
    tiff: () => readTiffDimensions(bytes),
  };
  const dimensions = safely(readers[format]);
  if (!dimensions) throw invalidInput(`The ${format} header is truncated or malformed`);
  return dimensions;
}

// Reads past the end of a truncated header throw RangeError; that is "malformed", not a crash.
function safely(reader) {
  try {
    return reader?.() ?? null;
  } catch {
    return null;
  }
}

// Walks the JPEG segments up to the first start-of-frame marker, which holds the size.
function readJpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + segmentLength;
  }
  return null;
}

// RIFF....WEBP then a VP8 (lossy), VP8L (lossless) or VP8X (extended) chunk.
function readWebpDimensions(bytes) {
  const chunkType = bytes.toString("latin1", 12, 16);
  if (chunkType === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (chunkType === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunkType === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  return null;
}

// The first image file directory's ImageWidth and ImageLength tags.
function readTiffDimensions(bytes) {
  const isLittleEndian = bytes.toString("latin1", 0, 2) === "II";
  const readShort = (offset) => (isLittleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset));
  const readLong = (offset) => (isLittleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
  const directoryOffset = readLong(4);
  const entryCount = readShort(directoryOffset);
  const found = {};
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = directoryOffset + 2 + index * 12;
    const tag = readShort(entryOffset);
    const value = readShort(entryOffset + 2) === 3 ? readShort(entryOffset + 8) : readLong(entryOffset + 8);
    if (tag === TIFF_IMAGE_WIDTH_TAG) found.width = value;
    if (tag === TIFF_IMAGE_LENGTH_TAG) found.height = value;
  }
  return found.width && found.height ? { width: found.width, height: found.height } : null;
}
