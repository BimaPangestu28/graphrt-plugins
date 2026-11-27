/**
 * Checks a logo before it goes on a document: it must be a PNG or JPEG
 * (recognised by its content, not its name), small enough to keep every
 * document light, and of a sane pixel size. The file is read through the
 * allowed folders like every other input.
 */
import { invalidInput } from "./errors.mjs";
import { assertRasterFormat } from "./raster-format.mjs";

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_SIDE_PIXELS = 4000;
const MIN_LOGO_SIDE_PIXELS = 16;
const LOGO_FORMATS = ["png", "jpeg"];
// JPEG markers that start a frame and carry the picture's size (SOF0-SOF15 without DHT, JPG and DAC).
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * Reads the pixel size of a PNG or JPEG from its bytes.
 *
 * @param bytes - File contents (Buffer)
 * @param format - "png" or "jpeg" (string)
 * @returns `{width, height}`, or null when the file does not say (object | null)
 *
 * @example
 * readImageSize(pngBytes, "png"); // { width: 640, height: 200 }
 */
export function readImageSize(bytes, format) {
  if (format === "png") {
    // The IHDR chunk always comes first: 8 signature bytes, 4 length, "IHDR", then width and height.
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (JPEG_FRAME_MARKERS.has(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    // Markers without a length: restart markers and start/end of image.
    const hasNoLength = (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01;
    offset += hasNoLength ? 2 : 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

/**
 * Checks the bytes of a logo.
 *
 * @param bytes - File contents (Buffer)
 * @param label - How to name the file in a message, e.g. `The logo "logo.png"` (string)
 * @returns `{format, width, height, size_bytes}` (object)
 * @throws PluginError kind `invalid_input` - When it is not a PNG or JPEG, is over 2 MB, or its sides are outside 16 to 4000 pixels
 */
export function checkLogoBytes(bytes, label) {
  const format = assertRasterFormat(bytes, LOGO_FORMATS, label);
  if (bytes.length > MAX_LOGO_BYTES) throw invalidInput(`${label} is ${describeSize(bytes.length)}; a logo may be at most 2 MB. Save a smaller version of it (about 800 pixels wide is plenty)`);
  const size = readImageSize(bytes, format);
  if (!size || size.width < MIN_LOGO_SIDE_PIXELS || size.height < MIN_LOGO_SIDE_PIXELS) throw invalidInput(`${label} is not a usable picture: it is damaged or smaller than ${MIN_LOGO_SIDE_PIXELS} pixels`);
  if (size.width > MAX_LOGO_SIDE_PIXELS || size.height > MAX_LOGO_SIDE_PIXELS) throw invalidInput(`${label} is ${size.width} x ${size.height} pixels; a logo may be at most ${MAX_LOGO_SIDE_PIXELS} pixels on each side. Save a smaller version of it (about 800 pixels wide is plenty)`);
  return { format, width: size.width, height: size.height, size_bytes: bytes.length };
}

/**
 * Reads a logo from the allowed folders and checks it.
 *
 * @param client - From createDocumentClient (object)
 * @param logoPath - Path as given (string)
 * @returns `{path, format, width, height, size_bytes}`; path is the file's real path (object)
 * @throws PluginError kinds `invalid_input` (not a usable logo), `not_found` (missing or outside the allowed folders)
 */
export async function readLogoFile(client, logoPath) {
  const file = await client.fileAccess.readInputFile(logoPath, { parameterName: "logo" });
  return { path: file.path, ...checkLogoBytes(file.bytes, `The logo ${JSON.stringify(logoPath)}`) };
}

function describeSize(byteCount) {
  return `${(byteCount / (1024 * 1024)).toFixed(1)} MB`;
}
