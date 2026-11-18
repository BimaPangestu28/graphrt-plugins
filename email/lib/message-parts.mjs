/**
 * Helpers that turn imapflow fetch results into plugin output: body part
 * selection from BODYSTRUCTURE, attachment metadata, address lists, header
 * parsing and capped stream reading.
 *
 * Every string that comes from a message is stripped of control characters
 * (except tab and newline in bodies) before it is returned.
 */

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const HEADER_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/**
 * Picks the text/plain and text/html body parts and lists attachments.
 *
 * @param bodyStructure - imapflow MessageStructureObject (object)
 * @returns `{textPart, htmlPart, attachments}`; parts are `{part, charset, size}` or null (object)
 *
 * @example
 * findBodyParts({ type: "text/plain", size: 120 }); // textPart.part === "1" (single-part message)
 */
export function findBodyParts(bodyStructure) {
  const found = { textPart: null, htmlPart: null, attachments: [] };
  if (bodyStructure) visitStructureNode(bodyStructure, found);
  return found;
}

function visitStructureNode(structureNode, found) {
  const contentType = String(structureNode.type ?? "").toLowerCase();
  if (structureNode.childNodes?.length && contentType.startsWith("multipart/")) {
    for (const childNode of structureNode.childNodes) visitStructureNode(childNode, found);
    return;
  }
  // RFC 3501: the body of a single-part message is part "1".
  const partId = structureNode.part ?? "1";
  const fileName = structureNode.dispositionParameters?.filename ?? structureNode.parameters?.name ?? null;
  const isAttachment = String(structureNode.disposition ?? "").toLowerCase() === "attachment" || Boolean(fileName);
  const bodyPart = { part: partId, charset: structureNode.parameters?.charset ?? null, size: structureNode.size ?? null };
  if (!isAttachment && contentType === "text/plain" && !found.textPart) found.textPart = bodyPart;
  else if (!isAttachment && contentType === "text/html" && !found.htmlPart) found.htmlPart = bodyPart;
  else if (isAttachment || !contentType.startsWith("text/")) found.attachments.push(describeAttachment(structureNode, partId, fileName, contentType));
}

function describeAttachment(structureNode, partId, fileName, contentType) {
  const encodedSize = structureNode.size ?? null;
  const isBase64 = String(structureNode.encoding ?? "").toLowerCase() === "base64";
  return {
    part: partId,
    filename: fileName ? cleanHeaderText(fileName).slice(0, 255) : null,
    content_type: contentType || "application/octet-stream",
    // BODYSTRUCTURE gives the encoded size; base64 is 4/3 of the content.
    size_bytes: encodedSize !== null && isBase64 ? Math.floor((encodedSize * 3) / 4) : encodedSize,
    disposition: structureNode.disposition ? String(structureNode.disposition).toLowerCase() : null,
    content_id: structureNode.id ? cleanHeaderText(structureNode.id) : null,
  };
}

/**
 * Formats an envelope address list.
 *
 * @param addressList - imapflow `[{name, address}]` (object[] | undefined)
 * @returns `[{name, address}]` with clean strings (object[])
 */
export function formatAddressList(addressList) {
  return (addressList ?? []).map((entry) => ({ name: cleanHeaderText(entry.name ?? ""), address: cleanHeaderText(entry.address ?? "") }));
}

/**
 * Removes control characters (incl. line breaks) from a header value.
 *
 * @param value - Header text (string)
 * @returns Single-line text (string)
 */
export function cleanHeaderText(value) {
  return String(value ?? "").replace(HEADER_CONTROL_CHARACTERS, " ").trim();
}

/**
 * Removes control characters except tab and newline from body text.
 *
 * @param value - Body text (string)
 * @returns Clean text (string)
 */
export function cleanBodyText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(CONTROL_CHARACTERS, "");
}

/**
 * Reads the Message-IDs of the References header out of a raw header block.
 *
 * @param headerBuffer - Raw header lines from a FETCH (Buffer | string | undefined)
 * @returns `["<a@x>", ...]` (string[])
 */
export function parseReferencesHeader(headerBuffer) {
  const headerText = String(headerBuffer ?? "").replace(/\r?\n[ \t]+/g, " ");
  const referencesLine = /^references:(.*)$/im.exec(headerText);
  if (!referencesLine) return [];
  return (referencesLine[1].match(/<[^<>\s]{1,998}>/g) ?? []).slice(0, 100);
}

/**
 * Reads a stream into a string, stopping after `maxBytes`.
 *
 * @param contentStream - Readable stream (object)
 * @param maxBytes - Byte cap (number)
 * @returns `{text, truncated}` (Promise<object>)
 */
export async function readStreamText(contentStream, maxBytes) {
  const chunks = [];
  let byteCount = 0;
  let truncated = false;
  for await (const chunk of contentStream) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (byteCount + chunkBuffer.byteLength > maxBytes) {
      chunks.push(chunkBuffer.subarray(0, maxBytes - byteCount));
      truncated = true;
      contentStream.destroy?.();
      break;
    }
    chunks.push(chunkBuffer);
    byteCount += chunkBuffer.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/**
 * Converts a date-like value to an ISO string.
 *
 * @param dateValue - Date or string (Date | string | undefined)
 * @returns ISO string or null (string | null)
 */
export function formatDate(dateValue) {
  if (!dateValue) return null;
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
