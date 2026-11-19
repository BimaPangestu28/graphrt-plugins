/**
 * Hash, list, set and sorted-set operations.
 *
 * Reads return at most 1000 items and at most REDIS_MAX_RESULT_BYTES; a
 * bigger collection is read partially (HSCAN/SSCAN, or a clamped index range)
 * and reported with `truncated: true`, so one call never loads a huge key.
 */
import { invalidInput } from "../lib/errors.mjs";
import { capItems, decodeName, decodeValue, encodeName, encodeValue } from "../lib/values.mjs";
import {
  ENCODING_PROPERTY,
  KEY_PROPERTY,
  MAX_ITEMS,
  assertRequestSize,
  clampRange,
  defineOperation,
  encodeValues,
  sendCommand,
  toInteger,
  toText,
} from "./common.mjs";

const VALUES_PROPERTY = { type: "array", items: { type: "string" }, maxItems: MAX_ITEMS, description: "Values (at most 1000)" };
const MEMBERS_PROPERTY = { type: "array", items: { type: "string" }, maxItems: MAX_ITEMS, description: "Members (at most 1000)" };
// No `type`: a binary field name comes as {"base64": "…"} or "base64:<…>" (how hgetall lists it).
const FIELD_PROPERTY = { description: "Field name; a binary name as {\"base64\": \"…\"} or \"base64:<…>\"" };
const START_PROPERTY = { type: "integer", default: 0, description: "First index (negative counts from the end)" };
// HSCAN rounds per hgetall call; a sparse hashtable may need several to fill a page.
const MAX_HASH_SCAN_ROUNDS = 20;
const STOP_PROPERTY = { type: "integer", default: -1, description: "Last index, inclusive (-1 is the last item); at most 1000 items are returned" };

const hget = defineOperation({
  name: "hget",
  title: "Get hash field",
  description:
    "Read one field of a hash. Returns null when the key or field does not exist. A field above REDIS_MAX_VALUE_BYTES is not read: value null, `truncated: true` and its `size`.",
  properties: { key: KEY_PROPERTY, field: FIELD_PROPERTY, encoding: ENCODING_PROPERTY },
  required: ["key", "field"],
  execute: async (context) => {
    const { args, client } = context;
    const commandArguments = [client.keyspace.toServerKey(args.key), encodeName(args.field, "field")];
    // Hash fields cannot be read partially, so HSTRLEN decides whether the field is read at all.
    const size = toInteger(await sendCommand(context, "hstrlen", commandArguments));
    if (size > client.settings.maxValueBytes) return { key: args.key, field: args.field, value: null, exists: true, truncated: true, size };
    const reply = await sendCommand(context, "hget", commandArguments);
    return { key: args.key, field: args.field, value: decodeValue(reply, args.encoding), exists: reply !== null, truncated: false, size: reply === null ? null : size };
  },
});

const hset = defineOperation({
  name: "hset",
  title: "Set hash fields",
  description: "Set one or more fields of a hash, e.g. {\"name\": \"Budi\", \"city\": \"Bandung\"}. Returns how many fields were new.",
  isWrite: true,
  properties: {
    key: KEY_PROPERTY,
    fields: { type: "object", description: "Field names to values (strings; base64 values with encoding: base64); at most 1000 fields" },
    encoding: ENCODING_PROPERTY,
  },
  required: ["key", "fields"],
  execute: async (context) => {
    const { args, client } = context;
    const entries = Object.entries(args.fields);
    if (entries.length === 0 || entries.length > MAX_ITEMS) throw invalidInput(`\`fields\` must have 1 to ${MAX_ITEMS} entries`);
    const encodedValues = entries.map(([fieldName, fieldValue]) =>
      encodeValue(fieldValue, { encoding: args.encoding, label: `fields.${fieldName}`, maxBytes: client.settings.maxValueBytes }),
    );
    assertRequestSize(encodedValues);
    const pairs = entries.flatMap(([fieldName], index) => [encodeName(fieldName, `fields.${fieldName}`), encodedValues[index]]);
    const reply = await sendCommand(context, "hset", [client.keyspace.toServerKey(args.key), ...pairs], true);
    return { key: args.key, added: toInteger(reply) };
  },
});

const hgetall = defineOperation({
  name: "hgetall",
  title: "Get all hash fields",
  description: "Read a hash as an object (at most 1000 fields, read with HSCAN; larger hashes come back partially with `truncated: true`). Field names that are not UTF-8 appear as \"base64:<…>\".",
  properties: { key: KEY_PROPERTY, encoding: ENCODING_PROPERTY },
  required: ["key"],
  execute: async (context) => {
    const { args, client } = context;
    const serverKey = client.keyspace.toServerKey(args.key);
    const fieldCount = toInteger(await sendCommand(context, "hlen", [serverKey]));
    const fieldsByName = await scanHashFields(context, serverKey);
    const pairs = [...fieldsByName].map(([fieldName, valueBytes]) => [
      decodeName(Buffer.from(fieldName, "latin1"), args.encoding),
      capValue(valueBytes, client.settings.maxValueBytes, args.encoding).value,
    ]);
    const capped = capItems(pairs, client.settings.maxResultBytes);
    return { key: args.key, fields: Object.fromEntries(capped.items), count: capped.items.length, total: fieldCount, truncated: capped.truncated || capped.items.length < fieldCount };
  },
});

const hdel = defineOperation({
  name: "hdel",
  title: "Delete hash fields",
  description: "Delete fields from a hash. Returns how many existed.",
  isWrite: true,
  properties: { key: KEY_PROPERTY, fields: { type: "array", maxItems: MAX_ITEMS, description: "Field names (binary names as {\"base64\": \"…\"} or \"base64:<…>\")" } },
  required: ["key", "fields"],
  execute: async (context) => {
    if (context.args.fields.length === 0) throw invalidInput("`fields` must not be empty");
    const fieldNames = context.args.fields.map((fieldName, index) => encodeName(fieldName, `fields[${index}]`));
    const reply = await sendCommand(context, "hdel", [context.client.keyspace.toServerKey(context.args.key), ...fieldNames], true);
    return { key: context.args.key, deleted: toInteger(reply) };
  },
});

const lpush = definePush("lpush", "Push to list head", "Insert values at the head of a list (the last value ends up first). Returns the new length.");
const rpush = definePush("rpush", "Push to list tail", "Append values to the tail of a list. Returns the new length.");

const lrange = defineOperation({
  name: "lrange",
  title: "List range",
  description: "Read list items from `start` to `stop` (inclusive, negative from the end); at most 1000 items, with next_cursor for the rest.",
  properties: { key: KEY_PROPERTY, start: START_PROPERTY, stop: STOP_PROPERTY, encoding: ENCODING_PROPERTY },
  required: ["key"],
  execute: async (context) => {
    const { args, client } = context;
    const serverKey = client.keyspace.toServerKey(args.key);
    const length = toInteger(await sendCommand(context, "llen", [serverKey]));
    const range = clampRange(args.start, args.stop, length);
    if (range.empty) return { key: args.key, values: [], length, truncated: false, next_start: null };
    const reply = await sendCommand(context, "lrange", [serverKey, range.start, range.stop]);
    const capped = capItems(reply.map((item) => capValue(item, client.settings.maxValueBytes, args.encoding).value), client.settings.maxResultBytes);
    const truncated = range.truncated || capped.truncated;
    return { key: args.key, values: capped.items, start: range.start, length, truncated, next_start: truncated ? range.start + capped.items.length : null };
  },
});

const llen = defineOperation({
  name: "llen",
  title: "List length",
  description: "Number of items in a list (0 when the key does not exist).",
  properties: { key: KEY_PROPERTY },
  required: ["key"],
  execute: async (context) => ({ key: context.args.key, length: toInteger(await sendCommand(context, "llen", [context.client.keyspace.toServerKey(context.args.key)])) }),
});

const sadd = defineOperation({
  name: "sadd",
  title: "Add to set",
  description: "Add members to a set. Returns how many were new.",
  isWrite: true,
  properties: { key: KEY_PROPERTY, members: MEMBERS_PROPERTY, encoding: ENCODING_PROPERTY },
  required: ["key", "members"],
  execute: async (context) => {
    const members = encodeValues(context.args.members, context, "members");
    const reply = await sendCommand(context, "sadd", [context.client.keyspace.toServerKey(context.args.key), ...members], true);
    return { key: context.args.key, added: toInteger(reply) };
  },
});

const smembers = defineOperation({
  name: "smembers",
  title: "Set members",
  description: "List a set's members (at most 1000; of a larger set, 1000 arbitrary members with `truncated: true`).",
  properties: { key: KEY_PROPERTY, encoding: ENCODING_PROPERTY },
  required: ["key"],
  execute: async (context) => {
    const { args, client } = context;
    const serverKey = client.keyspace.toServerKey(args.key);
    const memberCount = toInteger(await sendCommand(context, "scard", [serverKey]));
    const reply = memberCount <= MAX_ITEMS
      ? await sendCommand(context, "smembers", [serverKey])
      : await sendCommand(context, "srandmember", [serverKey, MAX_ITEMS]); // distinct members, at most MAX_ITEMS, whatever the encoding
    const decoded = reply.slice(0, MAX_ITEMS).map((member) => capValue(member, client.settings.maxValueBytes, args.encoding).value);
    const capped = capItems(decoded, client.settings.maxResultBytes);
    return { key: args.key, members: capped.items, count: capped.items.length, total: memberCount, truncated: capped.truncated || capped.items.length < memberCount };
  },
});

const srem = defineOperation({
  name: "srem",
  title: "Remove from set",
  description: "Remove members from a set. Returns how many were there.",
  isWrite: true,
  properties: { key: KEY_PROPERTY, members: MEMBERS_PROPERTY, encoding: ENCODING_PROPERTY },
  required: ["key", "members"],
  execute: async (context) => {
    const members = encodeValues(context.args.members, context, "members");
    const reply = await sendCommand(context, "srem", [context.client.keyspace.toServerKey(context.args.key), ...members], true);
    return { key: context.args.key, removed: toInteger(reply) };
  },
});

const zadd = defineOperation({
  name: "zadd",
  title: "Add to sorted set",
  description: "Add members with scores to a sorted set, e.g. [{\"member\": \"budi\", \"score\": 120}]. Returns how many were new (or changed, with `changed: true`).",
  isWrite: true,
  properties: {
    key: KEY_PROPERTY,
    members: { type: "array", items: { type: "object" }, maxItems: MAX_ITEMS, description: "Items {member, score}" },
    condition: { type: "string", enum: ["NX", "XX"], description: "NX: only add new members; XX: only update existing ones" },
    comparison: { type: "string", enum: ["GT", "LT"], description: "Only update when the new score is greater (GT) or less (LT)" },
    changed: { type: "boolean", default: false, description: "Count changed scores as well as new members" },
    encoding: ENCODING_PROPERTY,
  },
  required: ["key", "members"],
  execute: async (context) => {
    const { args, client } = context;
    if (args.members.length === 0) throw invalidInput("`members` must not be empty");
    const scorePairs = args.members.flatMap((item, index) => [
      formatScore(item?.score, `members[${index}].score`),
      encodeValue(item?.member, { encoding: args.encoding, label: `members[${index}].member`, maxBytes: client.settings.maxValueBytes }),
    ]);
    assertRequestSize(scorePairs.filter(Buffer.isBuffer));
    const flags = [args.condition, args.comparison, args.changed ? "CH" : null].filter(Boolean);
    const reply = await sendCommand(context, "zadd", [client.keyspace.toServerKey(args.key), ...flags, ...scorePairs], true);
    return { key: args.key, [args.changed ? "changed" : "added"]: toInteger(reply) };
  },
});

const zrange = defineOperation({
  name: "zrange",
  title: "Sorted set range",
  description:
    "Read sorted-set members by rank (`start`/`stop`) or, with `by_score`, by score (`min`/`max`, e.g. \"(10\" or \"+inf\"); lowest first unless `reverse`. At most 1000 members.",
  properties: {
    key: KEY_PROPERTY,
    start: START_PROPERTY,
    stop: STOP_PROPERTY,
    by_score: { type: "boolean", default: false, description: "Select by score between `min` and `max` instead of by rank" },
    min: { type: "string", default: "-inf", description: "Lowest score with by_score (\"(5\" excludes 5)" },
    max: { type: "string", default: "+inf", description: "Highest score with by_score" },
    reverse: { type: "boolean", default: false, description: "Highest score first" },
    with_scores: { type: "boolean", default: false, description: "Return {member, score} items instead of members" },
    encoding: ENCODING_PROPERTY,
  },
  required: ["key"],
  execute: async (context) => {
    const { args, client } = context;
    const serverKey = client.keyspace.toServerKey(args.key);
    const { commandArguments, truncatedByRange } = args.by_score ? await buildScoreRange(serverKey, args) : await buildRankRange(context, serverKey);
    if (!commandArguments) return { key: args.key, members: [], count: 0, truncated: false };
    const reply = await sendCommand(context, "zrange", [...commandArguments, ...(args.with_scores ? ["WITHSCORES"] : [])]);
    const members = decodeRangeReply(reply.slice(0, (args.with_scores ? 2 : 1) * MAX_ITEMS), args, client.settings.maxValueBytes);
    const capped = capItems(members, client.settings.maxResultBytes);
    const moreThanLimit = args.by_score && reply.length > (args.with_scores ? 2 : 1) * MAX_ITEMS;
    return { key: args.key, members: capped.items, count: capped.items.length, truncated: truncatedByRange || moreThanLimit || capped.truncated };
  },
});

const zrem = defineOperation({
  name: "zrem",
  title: "Remove from sorted set",
  description: "Remove members from a sorted set. Returns how many were there.",
  isWrite: true,
  properties: { key: KEY_PROPERTY, members: MEMBERS_PROPERTY, encoding: ENCODING_PROPERTY },
  required: ["key", "members"],
  execute: async (context) => {
    const members = encodeValues(context.args.members, context, "members");
    const reply = await sendCommand(context, "zrem", [context.client.keyspace.toServerKey(context.args.key), ...members], true);
    return { key: context.args.key, removed: toInteger(reply) };
  },
});

/**
 * Reads up to MAX_ITEMS hash fields with HSCAN. HGETALL is not used: ioredis turns its reply into an
 * object with string keys, which loses binary field names, and it would load a huge hash whole.
 *
 * @param context - Operation context (object)
 * @param serverKey - Prefixed key (string)
 * @returns Field name (as latin1, i.e. raw bytes) → value bytes (Promise<Map<string, Buffer>>)
 */
async function scanHashFields(context, serverKey) {
  const fieldsByName = new Map();
  let cursor = "0";
  for (let round = 0; round < MAX_HASH_SCAN_ROUNDS; round += 1) {
    const [nextCursor, flatReply] = await sendCommand(context, "hscan", [serverKey, cursor, "COUNT", MAX_ITEMS]);
    for (let index = 0; index + 1 < flatReply.length && fieldsByName.size < MAX_ITEMS; index += 2) {
      fieldsByName.set(flatReply[index].toString("latin1"), flatReply[index + 1]);
    }
    cursor = toText(nextCursor);
    if (cursor === "0" || fieldsByName.size >= MAX_ITEMS) break;
  }
  return fieldsByName;
}

function definePush(commandName, title, description) {
  return defineOperation({
    name: commandName,
    title,
    description: `${description} At most 1000 values per call.`,
    isWrite: true,
    properties: { key: KEY_PROPERTY, values: VALUES_PROPERTY, encoding: ENCODING_PROPERTY },
    required: ["key", "values"],
    execute: async (context) => {
      const values = encodeValues(context.args.values, context, "values");
      const reply = await sendCommand(context, commandName, [context.client.keyspace.toServerKey(context.args.key), ...values], true);
      return { key: context.args.key, length: toInteger(reply) };
    },
  });
}

async function buildRankRange(context, serverKey) {
  const length = toInteger(await sendCommand(context, "zcard", [serverKey]));
  const range = clampRange(context.args.start, context.args.stop, length);
  if (range.empty) return { commandArguments: null, truncatedByRange: false };
  const reverseFlag = context.args.reverse ? ["REV"] : [];
  return { commandArguments: [serverKey, range.start, range.stop, ...reverseFlag], truncatedByRange: range.truncated };
}

// ZRANGE … BYSCORE REV takes max before min. One extra member shows whether there are more.
async function buildScoreRange(serverKey, args) {
  const bounds = args.reverse ? [validateScoreBound(args.max, "max"), validateScoreBound(args.min, "min")] : [validateScoreBound(args.min, "min"), validateScoreBound(args.max, "max")];
  const reverseFlag = args.reverse ? ["REV"] : [];
  return { commandArguments: [serverKey, ...bounds, "BYSCORE", ...reverseFlag, "LIMIT", 0, MAX_ITEMS + 1], truncatedByRange: false };
}

function decodeRangeReply(reply, args, maxValueBytes) {
  if (!args.with_scores) return reply.map((member) => capValue(member, maxValueBytes, args.encoding).value);
  const items = [];
  for (let index = 0; index + 1 < reply.length; index += 2) {
    items.push({ member: capValue(reply[index], maxValueBytes, args.encoding).value, score: parseScore(toText(reply[index + 1])) });
  }
  return items;
}

function formatScore(score, label) {
  const numericScore = typeof score === "string" ? Number(score) : score;
  if (typeof numericScore !== "number" || Number.isNaN(numericScore)) throw invalidInput(`\`${label}\` must be a number`);
  if (numericScore === Infinity) return "+inf";
  if (numericScore === -Infinity) return "-inf";
  return String(numericScore);
}

function validateScoreBound(bound, label) {
  if (!/^\(?(?:[+-]?inf|[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(String(bound))) {
    throw invalidInput(`\`${label}\` must be a number, "-inf", "+inf", or "(" followed by a number for an exclusive bound`);
  }
  return String(bound);
}

function parseScore(scoreText) {
  if (scoreText === "inf" || scoreText === "+inf") return "+inf";
  if (scoreText === "-inf") return "-inf";
  return Number(scoreText);
}

// Values above REDIS_MAX_VALUE_BYTES are cut (replies here cannot be read partially).
function capValue(bytes, maxValueBytes, encoding) {
  if (bytes === null || bytes === undefined) return { value: null, truncated: false };
  const truncated = Buffer.isBuffer(bytes) && bytes.length > maxValueBytes;
  return { value: decodeValue(truncated ? bytes.subarray(0, maxValueBytes) : bytes, encoding), truncated };
}

export const collectionOperations = [hget, hset, hgetall, hdel, lpush, rpush, lrange, llen, sadd, smembers, srem, zadd, zrange, zrem];
