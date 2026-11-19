/**
 * Keeps operation results within FIRESTORE_MAX_RESULT_BYTES (JSON bytes), so one call cannot flood a workflow or
 * an agent's context. Whole documents are kept or dropped; a single document over the cap keeps only its metadata
 * and field names.
 */

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Keeps whole documents while their JSON stays within maxBytes.
 *
 * @param documents - Decoded documents (object[])
 * @param maxBytes - Byte cap (number)
 * @returns `{documents, truncated, omittedCount}` (object)
 */
export function capDocuments(documents, maxBytes) {
  const kept = [];
  let totalBytes = 2;
  for (const document of documents) {
    totalBytes += jsonBytes(document) + 1;
    if (totalBytes > maxBytes) break;
    kept.push(document);
  }
  return { documents: kept, truncated: kept.length < documents.length, omittedCount: documents.length - kept.length };
}

/**
 * Caps one document: over maxBytes, its fields are replaced by their names.
 *
 * @param document - Decoded document (object)
 * @param maxBytes - Byte cap (number)
 * @returns The document with `truncated` (and `field_names` when cut) (object)
 */
export function capDocument(document, maxBytes) {
  if (jsonBytes(document) <= maxBytes) return { ...document, truncated: false };
  return { ...document, fields: {}, field_names: Object.keys(document.fields ?? {}), truncated: true };
}
