/**
 * String and generic key operations: get, mget, set, del, exists, expire, ttl, incr, incrby.
 *
 * Reads check STRLEN first, so a value larger than REDIS_MAX_VALUE_BYTES is
 * read with GETRANGE (its first bytes, `truncated: true`) and never loaded whole.
 */
import { invalidInput } from "../lib/errors.mjs";
import { capItems, decodeValue, encodeValue } from "../lib/values.mjs";
import { ENCODING_PROPERTY, KEYS_PROPERTY, KEY_PROPERTY, defineOperation, sendCommand, toInteger, toText } from "./common.mjs";

const EXPIRE_CONDITIONS = ["NX", "XX", "GT", "LT"];

const get = defineOperation({
  name: "get",
  title: "Get value",
  description: "Read a string value. Returns null when the key does not exist; values above REDIS_MAX_VALUE_BYTES come back cut, with `truncated: true`.",
  properties: { key: KEY_PROPERTY, encoding: ENCODING_PROPERTY },
  required: ["key"],
  execute: async (context) => {
    const [entry] = await readStrings(context, [context.args.key]);
    if (entry.wrongType) throw entry.wrongType;
    return { key: context.args.key, value: entry.value, exists: entry.value !== null, truncated: entry.truncated, size: entry.size };
  },
});

const mget = defineOperation({
  name: "mget",
  title: "Get values",
  description:
    "Read up to 100 string values. Keys that do not exist or hold another type give null. When the values together pass REDIS_MAX_RESULT_BYTES, the rest are listed in `omitted_keys`.",
  properties: { keys: KEYS_PROPERTY, encoding: ENCODING_PROPERTY },
  required: ["keys"],
  execute: async (context) => {
    const { keys } = context.args;
    if (keys.length === 0) throw invalidInput("`keys` must not be empty");
    const entries = await readStrings(context, keys);
    const values = entries.map((entry, index) => ({ key: keys[index], value: entry.value, truncated: entry.truncated }));
    const capped = capItems(values, context.client.settings.maxResultBytes);
    return {
      values: capped.items,
      found: capped.items.filter((entry) => entry.value !== null).length,
      truncated: capped.truncated,
      ...(capped.truncated ? { omitted_keys: keys.slice(capped.items.length) } : {}),
    };
  },
});

const set = defineOperation({
  name: "set",
  title: "Set value",
  description: "Write a string value, optionally with an expiry (`ex` seconds or `px` milliseconds) and only if it does not exist (`nx`) or already exists (`xx`).",
  isWrite: true,
  properties: {
    key: KEY_PROPERTY,
    value: { type: "string", description: "Value (text, or base64 with encoding: base64)" },
    encoding: ENCODING_PROPERTY,
    ex: { type: "integer", minimum: 1, maximum: 100_000_000, description: "Expire after this many seconds" },
    px: { type: "integer", minimum: 1, maximum: 100_000_000_000, description: "Expire after this many milliseconds" },
    nx: { type: "boolean", default: false, description: "Only set when the key does not exist" },
    xx: { type: "boolean", default: false, description: "Only set when the key already exists" },
  },
  required: ["key", "value"],
  execute: async (context) => {
    const { args, client } = context;
    if (args.ex !== undefined && args.px !== undefined) throw invalidInput("Pass `ex` or `px`, not both");
    if (args.nx && args.xx) throw invalidInput("Pass `nx` or `xx`, not both");
    const valueBytes = encodeValue(args.value ?? "", { encoding: args.encoding, label: "value", maxBytes: client.settings.maxValueBytes });
    const commandArguments = [client.keyspace.toServerKey(args.key), valueBytes];
    if (args.ex !== undefined) commandArguments.push("EX", args.ex);
    if (args.px !== undefined) commandArguments.push("PX", args.px);
    if (args.nx) commandArguments.push("NX");
    if (args.xx) commandArguments.push("XX");
    const reply = await sendCommand(context, "set", commandArguments, true);
    return { key: args.key, written: toText(reply) === "OK" };
  },
});

const del = defineOperation({
  name: "del",
  title: "Delete keys",
  description: "Delete up to 100 keys. Returns how many existed.",
  isWrite: true,
  properties: { keys: KEYS_PROPERTY },
  required: ["keys"],
  execute: async (context) => {
    if (context.args.keys.length === 0) throw invalidInput("`keys` must not be empty");
    const reply = await sendCommand(context, "del", context.client.keyspace.toServerKeys(context.args.keys), true);
    return { deleted: toInteger(reply) };
  },
});

const exists = defineOperation({
  name: "exists",
  title: "Keys exist",
  description: "Check up to 100 keys: returns which exist and how many.",
  properties: { keys: KEYS_PROPERTY },
  required: ["keys"],
  execute: async (context) => {
    const { keys } = context.args;
    if (keys.length === 0) throw invalidInput("`keys` must not be empty");
    const serverKeys = context.client.keyspace.toServerKeys(keys);
    const results = await context.client.sendAll(serverKeys.map((serverKey) => ["exists", [serverKey]]), { signal: context.signal });
    const existing = keys.filter((key, index) => results[index].status === "fulfilled" && toInteger(results[index].value) === 1);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    return { count: existing.length, existing };
  },
});

const expire = defineOperation({
  name: "expire",
  title: "Set expiry",
  description: "Set a key's time to live in seconds (optionally only when it has none (NX), has one (XX), or the new one is greater (GT) or less (LT)).",
  isWrite: true,
  properties: {
    key: KEY_PROPERTY,
    seconds: { type: "integer", minimum: 1, maximum: 100_000_000, description: "Time to live" },
    condition: { type: "string", enum: EXPIRE_CONDITIONS, description: "NX, XX, GT or LT (Redis 7+)" },
  },
  required: ["key", "seconds"],
  execute: async (context) => {
    const { args, client } = context;
    const commandArguments = [client.keyspace.toServerKey(args.key), args.seconds, ...(args.condition ? [args.condition] : [])];
    const reply = await sendCommand(context, "expire", commandArguments, true);
    return { key: args.key, applied: toInteger(reply) === 1 };
  },
});

const ttl = defineOperation({
  name: "ttl",
  title: "Time to live",
  description: "Read a key's remaining time to live in seconds (`exists: false` when the key is missing, `persistent: true` when it has no expiry).",
  properties: { key: KEY_PROPERTY },
  required: ["key"],
  execute: async (context) => {
    const seconds = toInteger(await sendCommand(context, "ttl", [context.client.keyspace.toServerKey(context.args.key)]));
    return { key: context.args.key, exists: seconds !== -2, persistent: seconds === -1, ttl_seconds: seconds >= 0 ? seconds : null };
  },
});

const incr = defineOperation({
  name: "incr",
  title: "Increment",
  description: "Add 1 to an integer value (a missing key counts as 0). Returns the new value.",
  isWrite: true,
  properties: { key: KEY_PROPERTY },
  required: ["key"],
  execute: async (context) => ({
    key: context.args.key,
    value: toInteger(await sendCommand(context, "incr", [context.client.keyspace.toServerKey(context.args.key)], true)),
  }),
});

const incrby = defineOperation({
  name: "incrby",
  title: "Increment by",
  description: "Add an integer (negative to subtract) to an integer value (a missing key counts as 0). Returns the new value.",
  isWrite: true,
  properties: { key: KEY_PROPERTY, increment: { type: "integer", description: "Amount to add" } },
  required: ["key", "increment"],
  execute: async (context) => {
    if (!Number.isSafeInteger(context.args.increment)) throw invalidInput("`increment` must be a safe integer");
    const reply = await sendCommand(context, "incrby", [context.client.keyspace.toServerKey(context.args.key), context.args.increment], true);
    return { key: context.args.key, value: toInteger(reply) };
  },
});

/**
 * Reads string values without loading any value larger than REDIS_MAX_VALUE_BYTES.
 * A key holding another type gives `wrongType` (its WRONGTYPE error); any other failure (timeout,
 * dropped connection) is thrown, so it is never mistaken for a missing key.
 *
 * @param context - Operation context (object)
 * @param keys - Caller keys (Array<string | {base64}>)
 * @returns Per key `{value, truncated, size, wrongType?}` (Promise<object[]>)
 * @throws The first error that is not WRONGTYPE
 */
async function readStrings(context, keys) {
  const { client, signal, args } = context;
  const { maxValueBytes } = client.settings;
  const serverKeys = client.keyspace.toServerKeys(keys);
  const lengths = (await client.sendAll(serverKeys.map((serverKey) => ["strlen", [serverKey]]), { signal })).map(unwrapUnlessWrongType);
  const readable = serverKeys.map((serverKey, index) => ({ serverKey, index, size: lengths[index] })).filter((entry) => !entry.size?.wrongType);
  const reads = readable.map(({ serverKey, size }) => (toInteger(size) > maxValueBytes ? ["getrange", [serverKey, 0, maxValueBytes - 1]] : ["get", [serverKey]]));
  const replies = (await client.sendAll(reads, { signal })).map(unwrapUnlessWrongType);
  const entries = lengths.map((size) => ({ value: null, truncated: false, size: null, wrongType: size?.wrongType }));
  readable.forEach(({ index, size }, readIndex) => {
    const reply = replies[readIndex];
    if (reply?.wrongType) {
      entries[index] = { value: null, truncated: false, size: null, wrongType: reply.wrongType };
      return;
    }
    const byteLength = toInteger(size);
    entries[index] = { value: decodeValue(reply, args.encoding), truncated: byteLength > maxValueBytes, size: reply === null ? null : byteLength };
  });
  return entries;
}

// Settled result -> its value, `{wrongType: error}` for WRONGTYPE, or throws any other error.
function unwrapUnlessWrongType(result) {
  if (result.status === "fulfilled") return result.value;
  if (/^WRONGTYPE/.test(String(result.reason?.message))) return { wrongType: result.reason };
  throw result.reason;
}

export const stringOperations = [get, mget, set, del, exists, expire, ttl, incr, incrby];
