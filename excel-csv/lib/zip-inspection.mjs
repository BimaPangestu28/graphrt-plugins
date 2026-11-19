/**
 * Checks an .xlsx (zip) file's central directory before it is unpacked, so a
 * small file that would inflate to gigabytes (a zip bomb) is refused.
 *
 * The declared sizes are what a zip says about itself; they stop accidental
 * and naive bombs, and the input byte cap still bounds everything else.
 */
import { invalidInput } from "./errors.mjs";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const MAX_COMMENT_LENGTH = 65535;
const ZIP64_MARKER = 0xffffffff;

/**
 * Reads the declared entry count and total uncompressed size of a zip.
 *
 * @param bytes - Zip file contents (Buffer)
 * @returns `{entryCount, uncompressedBytes}` (object)
 * @throws PluginError kind `invalid_input` - When the bytes are not a readable zip
 */
export function readZipTotals(bytes) {
  const endOffset = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  let uncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_FILE_HEADER_SIGNATURE) throw invalidInput("The file is not a valid .xlsx (broken zip directory)");
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    if (uncompressedSize === ZIP64_MARKER) throw invalidInput("The .xlsx uses zip64 entries (over 4 GiB), which are not supported");
    uncompressedBytes += uncompressedSize;
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return { entryCount, uncompressedBytes };
}

function findEndOfCentralDirectory(bytes) {
  const lowestOffset = Math.max(0, bytes.length - 22 - MAX_COMMENT_LENGTH);
  for (let offset = bytes.length - 22; offset >= lowestOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  throw invalidInput("The file is not a valid .xlsx (no zip directory found)");
}

/**
 * Refuses zips whose declared contents exceed the limits.
 *
 * @param bytes - Zip file contents (Buffer)
 * @param limits - `{maxUnzippedBytes, maxEntries}` (object)
 * @throws PluginError kind `invalid_input` - When the zip is unreadable or over a limit
 */
export function assertZipWithinLimits(bytes, { maxUnzippedBytes, maxEntries }) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw invalidInput("The file is not an .xlsx workbook (not a zip archive)");
  const { entryCount, uncompressedBytes } = readZipTotals(bytes);
  if (entryCount > maxEntries) throw invalidInput(`The .xlsx has ${entryCount} parts, over the limit of ${maxEntries}`);
  if (uncompressedBytes > maxUnzippedBytes) {
    throw invalidInput(`The .xlsx would unpack to ${uncompressedBytes} bytes, over the ${maxUnzippedBytes}-byte limit (EXCEL_CSV_MAX_UNZIPPED_BYTES)`);
  }
}
