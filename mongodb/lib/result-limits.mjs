/**
 * Reads cursor results under a document cap and a byte cap.
 *
 * The byte cap counts each document's encoded (Extended JSON) size, so the
 * reply sent to the host stays bounded even for large documents.
 */
import { measureJsonBytes } from "./documents.mjs";

/**
 * Drains up to `maxDocuments` encoded documents from a cursor, then closes it.
 *
 * @param cursor - Driver cursor (async iterable with close()) (object)
 * @param options - Limits (object)
 * @param options.maxDocuments - Documents to return; one more is read to detect `has_more` (number)
 * @param options.maxBytes - Encoded bytes to return (number)
 * @param options.encode - `(document) => json` (function)
 * @returns `{documents, truncated, hasMore}`; `truncated` means the byte cap stopped reading (Promise<object>)
 *
 * @example
 * await collectDocuments(collection.find({}, { limit: 101 }), { maxDocuments: 100, maxBytes: 1e6, encode });
 */
export async function collectDocuments(cursor, { maxDocuments, maxBytes, encode }) {
  const documents = [];
  let usedBytes = 0;
  try {
    for await (const document of cursor) {
      if (documents.length >= maxDocuments) return { documents, truncated: false, hasMore: true };
      const encodedDocument = encode(document);
      usedBytes += measureJsonBytes(encodedDocument);
      if (usedBytes > maxBytes) return { documents, truncated: true, hasMore: true };
      documents.push(encodedDocument);
    }
    return { documents, truncated: false, hasMore: false };
  } finally {
    await cursor.close?.().catch(() => {});
  }
}

/**
 * Keeps the leading values of an array while their encoded size fits.
 *
 * @param values - Encoded values (unknown[])
 * @param maxValues - Values to keep (number)
 * @param maxBytes - Encoded bytes to keep (number)
 * @returns `{values, truncated}` (object)
 */
export function capValues(values, maxValues, maxBytes) {
  const keptValues = [];
  let usedBytes = 0;
  for (const value of values) {
    usedBytes += measureJsonBytes(value);
    if (keptValues.length >= maxValues || usedBytes > maxBytes) return { values: keptValues, truncated: true };
    keptValues.push(value);
  }
  return { values: keptValues, truncated: false };
}
