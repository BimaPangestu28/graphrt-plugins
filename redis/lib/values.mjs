/**
 * Binary-safe value encoding at the plugin boundary.
 *
 * Redis values are bytes. Inputs are UTF-8 text by default, or base64 with
 * `encoding: "base64"`. Replies are read as Buffers; with `encoding: "utf8"`
 * valid UTF-8 comes back as a string and anything else as `{"base64": "…"}`
 * (never a lossy string), and with `encoding: "base64"` every value is a
 * base64 string.
 */
import { invalidInput } from "./errors.mjs";

export const ENCODINGS = Object.freeze(["utf8", "base64"]);
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const BINARY_NAME_PREFIX = "base64:";

/**
 * Turns an input value into the bytes to send.
 *
 * @param value - String (or number, sent as its decimal text) (string | number)
 * @param options - `{encoding, label, maxBytes}` (object)
 * @returns Bytes (Buffer)
 * @throws PluginError kind `invalid_input` - Wrong type, invalid base64, or larger than maxBytes
 *
 * @example
 * encodeValue("aGk=", { encoding: "base64", label: "value", maxBytes: 1024 }); // <Buffer 68 69>
 */
export function encodeValue(value, { encoding = "utf8", label, maxBytes }) {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") throw invalidInput(`\`${label}\` must be a string`);
  let bytes;
  if (encoding === "base64") {
    bytes = decodeStrictBase64(value, label);
  } else {
    bytes = Buffer.from(value, "utf8");
  }
  if (bytes.length > maxBytes) throw invalidInput(`\`${label}\` is ${bytes.length} bytes; the limit is REDIS_MAX_VALUE_BYTES (${maxBytes})`);
  return bytes;
}

/**
 * Turns reply bytes into a JSON value.
 *
 * @param bytes - Reply (Buffer | null)
 * @param encoding - "utf8" or "base64" (string)
 * @returns String, `{base64}` for non-UTF-8 bytes in utf8 mode, or null (string | object | null)
 *
 * @example
 * decodeValue(Buffer.from([0xff]), "utf8"); // { base64: "/w==" }
 */
export function decodeValue(bytes, encoding = "utf8") {
  if (bytes === null || bytes === undefined) return null;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  if (encoding === "base64") return buffer.toString("base64");
  try {
    return strictUtf8Decoder.decode(buffer);
  } catch {
    return { base64: buffer.toString("base64") };
  }
}

/**
 * Decodes a name used as a JSON object key (hash field): non-UTF-8 names become "base64:<…>".
 *
 * @param bytes - Field name (Buffer)
 * @param encoding - "utf8" or "base64" (string)
 * @returns Object key (string)
 */
export function decodeName(bytes, encoding = "utf8") {
  const decoded = decodeValue(bytes, encoding);
  return typeof decoded === "string" ? decoded : `${BINARY_NAME_PREFIX}${decoded.base64}`;
}

/**
 * Turns a key or field name from a caller into what is sent: a string, or bytes for a binary name.
 * Binary names come as `{"base64": "…"}` (how `scan` lists them) or `"base64:<…>"` (how `hgetall` lists
 * field names). The string form only counts as binary when it decodes to bytes that are NOT valid UTF-8,
 * exactly the names the plugin itself prints that way, so ordinary names starting with "base64:" still work.
 *
 * @param name - Name (string | number | {base64: string})
 * @param label - Argument name for messages (string)
 * @returns Name to send (string | Buffer)
 * @throws PluginError kind `invalid_input` - Wrong type or invalid base64
 *
 * @example
 * encodeName({ base64: "/w==" }, "key"); // <Buffer ff>
 * encodeName("base64:aGk=", "key");      // "base64:aGk=" (decodes to "hi", so it is an ordinary name)
 */
export function encodeName(name, label) {
  if (typeof name === "number" && Number.isFinite(name)) return String(name);
  if (name && typeof name === "object" && !Array.isArray(name) && typeof name.base64 === "string") {
    return decodeStrictBase64(name.base64, label);
  }
  if (typeof name !== "string") throw invalidInput(`\`${label}\` must be a string or {"base64": "…"}`);
  if (!name.startsWith(BINARY_NAME_PREFIX)) return name;
  const encoded = name.slice(BINARY_NAME_PREFIX.length);
  if (encoded.length === 0 || !STRICT_BASE64.test(encoded)) return name;
  const bytes = Buffer.from(encoded, "base64");
  return typeof decodeValue(bytes) === "string" ? name : bytes;
}

function decodeStrictBase64(text, label) {
  const compact = text.replace(/\s+/g, "");
  if (!STRICT_BASE64.test(compact)) throw invalidInput(`\`${label}\` is not valid base64`);
  return Buffer.from(compact, "base64");
}

/**
 * Decodes any reply recursively (the `command` escape hatch).
 *
 * @param reply - Buffer, number, null, array or Error (unknown)
 * @param encoding - "utf8" or "base64" (string)
 * @returns JSON value (unknown)
 */
export function decodeReply(reply, encoding = "utf8") {
  if (Buffer.isBuffer(reply)) return decodeValue(reply, encoding);
  if (Array.isArray(reply)) return reply.map((item) => decodeReply(item, encoding));
  if (reply instanceof Error) return { error: reply.message };
  if (typeof reply === "bigint") return reply.toString();
  // ioredis turns some replies (HGETALL) into plain objects.
  if (reply && typeof reply === "object") {
    return Object.fromEntries(Object.entries(reply).map(([name, value]) => [name, decodeReply(value, encoding)]));
  }
  return reply ?? null;
}

/**
 * Size of a decoded JSON value in UTF-8 bytes.
 *
 * @param value - JSON value (unknown)
 * @returns Bytes (number)
 */
export function measureJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/**
 * Keeps leading items while their decoded size fits the result cap.
 *
 * @param items - Decoded items (unknown[])
 * @param maxBytes - REDIS_MAX_RESULT_BYTES (number)
 * @returns `{items, truncated}` (object)
 */
export function capItems(items, maxBytes) {
  const keptItems = [];
  let usedBytes = 0;
  for (const item of items) {
    usedBytes += measureJsonBytes(item);
    if (usedBytes > maxBytes) return { items: keptItems, truncated: true };
    keptItems.push(item);
  }
  return { items: keptItems, truncated: false };
}
