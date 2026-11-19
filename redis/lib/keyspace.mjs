/**
 * Key prefix isolation (REDIS_KEY_PREFIX).
 *
 * Every key (and pub/sub channel) an operation sends is prefixed, and keys
 * read back (SCAN) are stripped of it, so callers only ever see and reach
 * their own part of the keyspace. SCAN patterns get the prefix as a literal
 * (glob-escaped) start, so a pattern cannot match keys outside it.
 */
import { invalidInput } from "./errors.mjs";
import { encodeName } from "./values.mjs";

export const MAX_KEY_BYTES = 4096;
const GLOB_SPECIAL_CHARACTERS = /[*?[\]\\]/g;

/**
 * Creates the keyspace helpers for a prefix.
 *
 * @param keyPrefix - REDIS_KEY_PREFIX, "" for none (string)
 * @returns `{prefix, toServerKey(key, label), toServerKeys(keys, label), fromServerKey(buffer), scanPattern(match)}` (object)
 *
 * @example
 * const keyspace = createKeyspace("shop:");
 * keyspace.toServerKey("cart:1");       // "shop:cart:1"
 * keyspace.scanPattern("cart:*");       // "shop:cart:*"
 */
export function createKeyspace(keyPrefix) {
  const prefixBuffer = Buffer.from(keyPrefix, "utf8");
  const toServerKey = (key, label = "key") => {
    const name = validateKey(key, label);
    return typeof name === "string" ? `${keyPrefix}${name}` : Buffer.concat([prefixBuffer, name]);
  };
  return {
    prefix: keyPrefix,
    toServerKey,
    toServerKeys: (keys, label = "keys") => keys.map((key, index) => toServerKey(key, `${label}[${index}]`)),
    /** Strips the prefix from a key read from the server; null when it is outside the prefix. */
    fromServerKey(keyBuffer) {
      const keyBytes = Buffer.isBuffer(keyBuffer) ? keyBuffer : Buffer.from(String(keyBuffer), "utf8");
      if (prefixBuffer.length === 0) return keyBytes;
      if (keyBytes.length < prefixBuffer.length || !keyBytes.subarray(0, prefixBuffer.length).equals(prefixBuffer)) return null;
      return keyBytes.subarray(prefixBuffer.length);
    },
    scanPattern: (match) => `${escapeGlob(keyPrefix)}${match ?? "*"}`,
  };
}

/**
 * Escapes glob characters so text matches literally in a SCAN/KEYS pattern.
 *
 * @param text - Literal text (string)
 * @returns Escaped pattern (string)
 */
export function escapeGlob(text) {
  return text.replace(GLOB_SPECIAL_CHARACTERS, "\\$&");
}

/**
 * Validates a key name given by a caller (text, or a binary name as `{"base64": "…"}` / `"base64:<…>"`).
 *
 * @param key - Key (string | {base64})
 * @param label - Argument name for messages (string)
 * @returns The key to send (string | Buffer)
 * @throws PluginError kind `invalid_input`
 */
export function validateKey(key, label) {
  const name = encodeName(key, label);
  const byteLength = Buffer.isBuffer(name) ? name.length : Buffer.byteLength(name, "utf8");
  if (byteLength === 0) throw invalidInput(`\`${label}\` must not be empty`);
  if (byteLength > MAX_KEY_BYTES) throw invalidInput(`\`${label}\` is longer than ${MAX_KEY_BYTES} bytes`);
  return name;
}
