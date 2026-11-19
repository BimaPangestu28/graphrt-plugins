/**
 * Extended JSON (relaxed) at the plugin boundary.
 *
 * Inputs (filters, documents, pipelines) arrive as JSON and are turned into
 * BSON values: `{"$oid": "…"}` → ObjectId, `{"$date": "…"}` → Date,
 * `{"$numberDecimal": "…"}` → Decimal128 and so on. Outputs go the other way,
 * so every result is plain JSON an LLM or a template can read and send back.
 */
import { invalidInput } from "./errors.mjs";

export const MAX_INPUT_BYTES = 4_000_000;
export const MAX_INPUT_DEPTH = 64;

/**
 * Creates the EJSON codec around the driver's EJSON implementation.
 *
 * @param ejson - `EJSON` from the bson package (object with serialize/deserialize)
 * @returns `{decode(value, label), encode(value), measure(value)}` (object)
 *
 * @example
 * const codec = createDocumentCodec(EJSON);
 * codec.decode({ _id: { $oid: "65a1…" } }, "filter"); // { _id: ObjectId("65a1…") }
 */
export function createDocumentCodec(ejson) {
  return {
    decode(value, label) {
      assertJsonShape(value, label);
      try {
        return ejson.deserialize(value, { relaxed: true });
      } catch (decodeError) {
        throw invalidInput(`\`${label}\` is not valid Extended JSON: ${decodeError?.message ?? decodeError}`);
      }
    },
    encode(value) {
      return ejson.serialize(value, { relaxed: true });
    },
  };
}

/**
 * Size of a JSON value in UTF-8 bytes, as it will be sent back to the host.
 *
 * @param value - JSON value (unknown)
 * @returns Bytes (number)
 */
export function measureJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/**
 * Checks that an input is bounded in size and nesting before it is decoded or scanned.
 *
 * @param value - Decoded JSON argument (unknown)
 * @param label - Argument name for messages (string)
 * @throws PluginError kind `invalid_input` - When it is too large or too deep
 */
export function assertJsonShape(value, label) {
  if (measureJsonBytes(value) > MAX_INPUT_BYTES) throw invalidInput(`\`${label}\` is larger than ${MAX_INPUT_BYTES} bytes`);
  if (exceedsDepth(value, MAX_INPUT_DEPTH)) throw invalidInput(`\`${label}\` is nested deeper than ${MAX_INPUT_DEPTH} levels`);
}

function exceedsDepth(value, remainingDepth) {
  if (value === null || typeof value !== "object") return false;
  if (remainingDepth <= 0) return true;
  return Object.values(value).some((child) => exceedsDepth(child, remainingDepth - 1));
}
