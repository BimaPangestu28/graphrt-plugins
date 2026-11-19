/**
 * Keyspace scan, pub/sub publish and stream operations.
 *
 * `scan` is the only way to list keys (KEYS is never sent). Stream reads
 * never block: XREADGROUP is sent without BLOCK, so a pooled connection is
 * never held waiting.
 */
import { invalidInput } from "../lib/errors.mjs";
import { decodeName, decodeValue, encodeValue, capItems } from "../lib/values.mjs";
import { ENCODING_PROPERTY, KEY_PROPERTY, MAX_ITEMS, assertRequestSize, defineOperation, sendCommand, toInteger, toText } from "./common.mjs";

const SCAN_TYPES = ["string", "list", "set", "zset", "hash", "stream"];
const STREAM_ID = /^(?:\d{1,20}(?:-(?:\d{1,20}|\*))?|\*)$/;
const RANGE_ID = /^(?:[-+]|\(?\d{1,20}(?:-\d{1,20})?)$/;
const NAME = /^[^\s\u0000-\u001f]{1,200}$/;

const scan = defineOperation({
  name: "scan",
  title: "Scan keys",
  description:
    "List keys in pages with SCAN (never KEYS): pass `match` (glob, e.g. \"cart:*\"), `count` as a hint and the returned next_cursor to continue. Keys are returned without REDIS_KEY_PREFIX.",
  properties: {
    cursor: { type: "string", default: "0", description: "`next_cursor` from the previous page; \"0\" starts" },
    match: { type: "string", description: "Glob pattern within the prefix, e.g. \"order:*\"" },
    count: { type: "integer", minimum: 1, maximum: MAX_ITEMS, default: 100, description: "How much work SCAN does per page (a hint; a page may hold more or fewer keys)" },
    type: { type: "string", enum: SCAN_TYPES, description: "Only keys of this type" },
    encoding: ENCODING_PROPERTY,
  },
  execute: async (context) => {
    const { args, client } = context;
    if (!/^\d{1,20}$/.test(args.cursor)) throw invalidInput("`cursor` must be a next_cursor from an earlier scan");
    const commandArguments = [args.cursor, "MATCH", client.keyspace.scanPattern(args.match), "COUNT", args.count, ...(args.type ? ["TYPE", args.type] : [])];
    const [nextCursorReply, keyReplies] = await sendCommand(context, "scan", commandArguments);
    const keys = keyReplies.map((serverKey) => client.keyspace.fromServerKey(serverKey)).filter(Boolean).map((key) => decodeValue(key, args.encoding));
    const nextCursor = toText(nextCursorReply);
    // The whole page is returned: dropping keys while advancing the cursor would skip them for good.
    return { keys, count: keys.length, next_cursor: nextCursor === "0" ? null : nextCursor };
  },
});

const publish = defineOperation({
  name: "publish",
  title: "Publish message",
  description: "Publish a message on a pub/sub channel (REDIS_KEY_PREFIX is added to the channel). Returns how many subscribers received it.",
  isWrite: true,
  properties: {
    channel: { type: "string", description: "Channel name" },
    message: { type: "string", description: "Message (text, or base64 with encoding: base64)" },
    encoding: ENCODING_PROPERTY,
  },
  required: ["channel", "message"],
  execute: async (context) => {
    const { args, client } = context;
    const message = encodeValue(args.message, { encoding: args.encoding, label: "message", maxBytes: client.settings.maxValueBytes });
    const reply = await sendCommand(context, "publish", [client.keyspace.toServerKey(args.channel, "channel"), message], true);
    return { channel: args.channel, receivers: toInteger(reply) };
  },
});

const xadd = defineOperation({
  name: "xadd",
  title: "Add stream entry",
  description: "Append an entry {field: value} to a stream, optionally trimming it to about `max_length` entries. Returns the new entry id.",
  isWrite: true,
  properties: {
    key: KEY_PROPERTY,
    fields: { type: "object", description: "Entry fields, e.g. {\"order\": \"A-12\", \"status\": \"paid\"} (at most 1000)" },
    id: { type: "string", default: "*", description: "Entry id; \"*\" lets Redis choose" },
    max_length: { type: "integer", minimum: 1, maximum: 1_000_000_000, description: "Trim the stream to about this many entries (MAXLEN ~)" },
    no_create: { type: "boolean", default: false, description: "Do not create the stream when it does not exist" },
    encoding: ENCODING_PROPERTY,
  },
  required: ["key", "fields"],
  execute: async (context) => {
    const { args, client } = context;
    if (!STREAM_ID.test(args.id)) throw invalidInput("`id` must be \"*\" or an id like \"1700000000000-0\"");
    const entries = Object.entries(args.fields);
    if (entries.length === 0 || entries.length > MAX_ITEMS) throw invalidInput(`\`fields\` must have 1 to ${MAX_ITEMS} entries`);
    const values = entries.map(([fieldName, fieldValue]) => encodeValue(fieldValue, { encoding: args.encoding, label: `fields.${fieldName}`, maxBytes: client.settings.maxValueBytes }));
    assertRequestSize(values);
    const options = [...(args.no_create ? ["NOMKSTREAM"] : []), ...(args.max_length ? ["MAXLEN", "~", args.max_length] : [])];
    const pairs = entries.flatMap(([fieldName], index) => [fieldName, values[index]]);
    const reply = await sendCommand(context, "xadd", [client.keyspace.toServerKey(args.key), ...options, args.id, ...pairs], true);
    return { key: args.key, id: toText(reply), created: reply !== null };
  },
});

const xrange = defineOperation({
  name: "xrange",
  title: "Read stream range",
  description: "Read stream entries between `start` and `end` ids (\"-\" and \"+\" for the ends), oldest first unless `reverse`. Pass next_cursor back as `start` (or `end` when reversed) for the next page.",
  properties: {
    key: KEY_PROPERTY,
    start: { type: "string", default: "-", description: "First id (\"-\" for the oldest; \"(id\" excludes it)" },
    end: { type: "string", default: "+", description: "Last id (\"+\" for the newest)" },
    count: { type: "integer", minimum: 1, maximum: MAX_ITEMS, default: 100, description: "Entries to return" },
    reverse: { type: "boolean", default: false, description: "Newest first (XREVRANGE)" },
    encoding: ENCODING_PROPERTY,
  },
  required: ["key"],
  execute: async (context) => {
    const { args, client } = context;
    for (const [label, id] of [["start", args.start], ["end", args.end]]) {
      if (!RANGE_ID.test(id)) throw invalidInput(`\`${label}\` must be "-", "+" or a stream id`);
    }
    const serverKey = client.keyspace.toServerKey(args.key);
    const commandArguments = args.reverse ? [serverKey, args.end, args.start, "COUNT", args.count] : [serverKey, args.start, args.end, "COUNT", args.count];
    const reply = await sendCommand(context, args.reverse ? "xrevrange" : "xrange", commandArguments);
    const capped = capItems(decodeEntries(reply, args.encoding), client.settings.maxResultBytes);
    const lastId = capped.items.at(-1)?.id;
    const hasMore = (capped.truncated || reply.length === args.count) && lastId;
    return { key: args.key, entries: capped.items, count: capped.items.length, truncated: capped.truncated, next_cursor: hasMore ? `(${lastId}` : null };
  },
});

const xreadgroup = defineOperation({
  name: "xreadgroup",
  title: "Read stream as consumer",
  description:
    "Read entries for a consumer of a consumer group (never blocks). `id` \">\" gets new entries (and records them as pending for this consumer); \"0\" re-reads this consumer's pending entries. Counts as a write because it changes the group's state.",
  isWrite: true,
  properties: {
    key: KEY_PROPERTY,
    group: { type: "string", description: "Consumer group" },
    consumer: { type: "string", description: "Consumer name (created on first use)" },
    id: { type: "string", default: ">", description: "\">\" for new entries, or an id to read pending entries after it" },
    count: { type: "integer", minimum: 1, maximum: MAX_ITEMS, default: 10, description: "Entries to return" },
    no_ack: {
      type: "boolean",
      default: false,
      description: "Acknowledge the returned entries right away (no xack needed). Entries the size cap leaves out stay pending and are listed in `pending_ids`.",
    },
    encoding: ENCODING_PROPERTY,
  },
  required: ["key", "group", "consumer"],
  execute: async (context) => {
    const { args, client } = context;
    assertName(args.group, "group");
    assertName(args.consumer, "consumer");
    if (args.id !== ">" && !STREAM_ID.test(args.id)) throw invalidInput("`id` must be \">\" or a stream id");
    const serverKey = client.keyspace.toServerKey(args.key);
    // Never NOACK: entries the result cap leaves out must stay pending, or they would be lost.
    const commandArguments = ["GROUP", args.group, args.consumer, "COUNT", args.count, "STREAMS", serverKey, args.id];
    const reply = await sendCommand(context, "xreadgroup", commandArguments, true);
    const entries = reply === null ? [] : decodeEntries(reply[0]?.[1] ?? [], args.encoding);
    const capped = capItems(entries, client.settings.maxResultBytes);
    if (args.no_ack && capped.items.length > 0) {
      await sendCommand(context, "xack", [serverKey, args.group, ...capped.items.map((entry) => entry.id)], true);
    }
    const result = { key: args.key, group: args.group, consumer: args.consumer, entries: capped.items, count: capped.items.length, truncated: capped.truncated };
    return capped.truncated ? { ...result, ...describeLeftPending(entries.slice(capped.items.length), args.no_ack) } : result;
  },
});

const xgroupCreate = defineOperation({
  name: "xgroup_create",
  title: "Create consumer group",
  description: "Create a consumer group on a stream, starting at `id` (\"$\" for only new entries, \"0\" for the whole stream). Creates the stream when missing unless `create_stream` is false.",
  isWrite: true,
  properties: {
    key: KEY_PROPERTY,
    group: { type: "string", description: "Consumer group" },
    id: { type: "string", default: "$", description: "\"$\" (new entries only), \"0\" (everything) or an entry id" },
    create_stream: { type: "boolean", default: true, description: "Create an empty stream when the key does not exist (MKSTREAM)" },
  },
  required: ["key", "group"],
  execute: async (context) => {
    const { args, client } = context;
    assertName(args.group, "group");
    if (args.id !== "$" && !STREAM_ID.test(args.id)) throw invalidInput("`id` must be \"$\", \"0\" or a stream id");
    const commandArguments = ["CREATE", client.keyspace.toServerKey(args.key), args.group, args.id, ...(args.create_stream ? ["MKSTREAM"] : [])];
    await sendCommand(context, "xgroup", commandArguments, true);
    return { key: args.key, group: args.group, created: true };
  },
});

const xack = defineOperation({
  name: "xack",
  title: "Acknowledge stream entries",
  description: "Acknowledge entries a consumer group has processed, so they leave the pending list. Returns how many were pending.",
  isWrite: true,
  properties: {
    key: KEY_PROPERTY,
    group: { type: "string", description: "Consumer group" },
    ids: { type: "array", items: { type: "string" }, maxItems: MAX_ITEMS, description: "Entry ids" },
  },
  required: ["key", "group", "ids"],
  execute: async (context) => {
    const { args, client } = context;
    assertName(args.group, "group");
    if (args.ids.length === 0 || args.ids.some((id) => !STREAM_ID.test(id) || id.includes("*"))) throw invalidInput("`ids` must be stream entry ids");
    const reply = await sendCommand(context, "xack", [client.keyspace.toServerKey(args.key), args.group, ...args.ids], true);
    return { key: args.key, acknowledged: toInteger(reply) };
  },
});

function decodeEntries(entries, encoding) {
  return (entries ?? []).map(([idReply, fieldReplies]) => {
    const fields = {};
    for (let index = 0; index + 1 < (fieldReplies ?? []).length; index += 2) {
      fields[decodeName(fieldReplies[index], encoding)] = decodeValue(fieldReplies[index + 1], encoding);
    }
    return { id: toText(idReply), fields };
  });
}

// Entries read but not returned (size cap): they are pending for this consumer, so nothing is lost.
function describeLeftPending(leftOutEntries, acknowledgedReturned) {
  const returnedPart = acknowledgedReturned ? "The returned entries were acknowledged." : "xack the returned entries first.";
  return {
    pending_ids: leftOutEntries.map((entry) => entry.id),
    hint: `REDIS_MAX_RESULT_BYTES cut the reply; the entries in pending_ids are still pending for this consumer. ${returnedPart} Then call xreadgroup again with id "0" (and a smaller count) to read them.`,
  };
}

function assertName(name, label) {
  if (!NAME.test(name)) throw invalidInput(`\`${label}\` must be 1-200 characters without spaces or control characters`);
}

export const streamOperations = [scan, publish, xadd, xrange, xreadgroup, xgroupCreate, xack];
