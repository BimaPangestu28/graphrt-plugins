/**
 * Turns feed bytes into text: a byte-order mark wins, then the XML
 * declaration's `encoding`, then UTF-8. Unknown encodings fall back to UTF-8
 * (bad bytes become U+FFFD) rather than failing the whole feed.
 */

const DECLARATION_PATTERN = /^<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._:-]{1,40})["']/;

/**
 * Decodes a fetched feed.
 *
 * @param bytes - Response body (Buffer | Uint8Array)
 * @returns The document text, without a byte-order mark (string)
 *
 * @example
 * decodeFeedBytes(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><a>\xe9</a>', "latin1")); // "...<a>é</a>"
 */
export function decodeFeedBytes(bytes) {
  const encoding = detectEncoding(bytes);
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function detectEncoding(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const head = Buffer.from(bytes.subarray(0, 200)).toString("latin1").trimStart();
  const declared = DECLARATION_PATTERN.exec(head)?.[1]?.toLowerCase();
  // A declaration that says UTF-16 without a BOM is not decodable as ASCII text; trust the bytes instead.
  return declared && !declared.startsWith("utf-16") ? declared : "utf-8";
}
