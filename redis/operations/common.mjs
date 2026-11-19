/**
 * Parameter schemas and helpers shared by the Redis operations.
 */
import { invalidInput, permissionDenied } from "../lib/errors.mjs";
import { ENCODINGS, encodeValue } from "../lib/values.mjs";

export const MAX_KEYS = 100;
export const MAX_ITEMS = 1000;
// All values of one write together; each value is also limited by REDIS_MAX_VALUE_BYTES.
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

// No `type`: a key is a string, or {"base64": "…"} for a binary key as `scan` lists it.
export const KEY_PROPERTY = { description: "Key (REDIS_KEY_PREFIX is added in front); a binary key as {\"base64\": \"…\"}" };
export const KEYS_PROPERTY = { type: "array", maxItems: MAX_KEYS, description: "Keys (at most 100); binary keys as {\"base64\": \"…\"}" };
export const ENCODING_PROPERTY = {
  type: "string",
  enum: ENCODINGS,
  default: "utf8",
  description: "`utf8` (text; values that are not valid UTF-8 come back as {\"base64\": \"…\"}) or `base64` (binary)",
};

/**
 * Builds an operation definition and refuses writes from tool calls unless REDIS_TOOL_ALLOW_WRITES=1.
 *
 * @param spec - `{name, title, description, properties, required, isWrite, nodeOnly, execute(context)}` (object)
 * @returns Operation definition for the shared runner (object)
 */
export function defineOperation({ name, title, description, properties, required = [], isWrite = false, nodeOnly = false, execute }) {
  return {
    name,
    title,
    description: isWrite && !nodeOnly ? `${description} Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1.` : description,
    nodeOnly,
    isWrite,
    parameters: { type: "object", properties, required },
    run: async (context) => {
      if (isWrite && context.source === "tool" && !context.client.settings.toolWritesAllowed) {
        throw permissionDenied(`\`${name}\` writes to Redis; agent tool calls need REDIS_TOOL_ALLOW_WRITES=1 (workflow nodes are always allowed)`);
      }
      const data = await execute(context);
      // Paged reads (scan, xrange) also expose their cursor as the node's `next_cursor` output.
      return { data, next_cursor: data?.next_cursor ?? null };
    },
  };
}

/**
 * Sends one command with the operation's signal and write flag.
 *
 * @param context - Operation context (object)
 * @param commandName - Redis command (string)
 * @param commandArguments - Arguments (Array<string | Buffer | number>)
 * @param isWrite - Whether the command changes data (boolean)
 * @returns Reply (Promise<unknown>)
 */
export function sendCommand(context, commandName, commandArguments, isWrite = false) {
  return context.client.send(commandName, commandArguments, { signal: context.signal, isWrite });
}

/**
 * Encodes a list of values with the size caps.
 *
 * @param values - Input values (Array<string | number>)
 * @param context - `{args, client}` (object)
 * @param label - Argument name (string)
 * @returns Bytes per value (Buffer[])
 * @throws PluginError kind `invalid_input`
 */
export function encodeValues(values, { args, client }, label) {
  if (values.length === 0) throw invalidInput(`\`${label}\` must not be empty`);
  const encoded = values.map((value, index) => encodeValue(value, { encoding: args.encoding, label: `${label}[${index}]`, maxBytes: client.settings.maxValueBytes }));
  assertRequestSize(encoded);
  return encoded;
}

/**
 * Refuses a write whose values add up to more than MAX_REQUEST_BYTES.
 *
 * @param buffers - Encoded values (Buffer[])
 * @throws PluginError kind `invalid_input`
 */
export function assertRequestSize(buffers) {
  const totalBytes = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  if (totalBytes > MAX_REQUEST_BYTES) throw invalidInput(`The values add up to ${totalBytes} bytes; one call may send at most ${MAX_REQUEST_BYTES}`);
}

/**
 * Reads an integer reply (ioredis returns numbers for RESP integers).
 *
 * @param reply - Reply (unknown)
 * @returns Number (number)
 */
export function toInteger(reply) {
  return typeof reply === "number" ? reply : Number(Buffer.isBuffer(reply) ? reply.toString("utf8") : reply);
}

/**
 * Reads a status or bulk reply as text (ids, cursors, "OK").
 *
 * @param reply - Reply (Buffer | string | null)
 * @returns Text or null (string | null)
 */
export function toText(reply) {
  if (reply === null || reply === undefined) return null;
  return Buffer.isBuffer(reply) ? reply.toString("utf8") : String(reply);
}

/**
 * Turns a Redis index range into absolute bounds, clamped to at most MAX_ITEMS items.
 *
 * @param start - Start index, negative from the end (number)
 * @param stop - Stop index (inclusive), negative from the end (number)
 * @param length - Collection length (number)
 * @returns `{start, stop, truncated, empty}` with absolute indexes (object)
 *
 * @example
 * clampRange(0, -1, 5000); // { start: 0, stop: 999, truncated: true, empty: false }
 */
export function clampRange(start, stop, length) {
  const absoluteStart = Math.max(0, start < 0 ? length + start : start);
  const absoluteStop = Math.min(length - 1, stop < 0 ? length + stop : stop);
  if (absoluteStart > absoluteStop) return { start: absoluteStart, stop: absoluteStop, truncated: false, empty: true };
  const clampedStop = Math.min(absoluteStop, absoluteStart + MAX_ITEMS - 1);
  return { start: absoluteStart, stop: clampedStop, truncated: clampedStop < absoluteStop, empty: false };
}
