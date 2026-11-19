/**
 * `command`: a node-only escape hatch for Redis commands without a dedicated
 * operation (e.g. HINCRBY, LPOP, ZSCORE, GETDEL, OBJECT ENCODING).
 *
 * It is never offered to agents. Even for nodes it refuses commands that can
 * wipe or reconfigure the server, run scripts, change the pooled
 * connection's state, block it, or list the whole keyspace (DENIED_COMMANDS).
 * In `base64` encoding every argument is base64. With REDIS_KEY_PREFIX, key arguments are found with the ioredis command
 * table and prefixed; commands it does not know, and keyspace-wide commands,
 * are refused so the prefix cannot be bypassed.
 */
import { classifyImportError, invalidInput, permissionDenied } from "../lib/errors.mjs";
import { decodeReply, encodeValue, measureJsonBytes } from "../lib/values.mjs";
import { ENCODING_PROPERTY, defineOperation, sendCommand } from "./common.mjs";

export const DENIED_COMMANDS = new Set([
  // Wipe, persist or reconfigure the server.
  "flushall", "flushdb", "config", "shutdown", "debug", "save", "bgsave", "bgrewriteaof", "swapdb", "module", "acl",
  "replicaof", "slaveof", "failover", "cluster", "sync", "psync", "replconf", "migrate", "restore", "restore-asking",
  // Server-side scripts and functions.
  "script", "eval", "evalsha", "eval_ro", "evalsha_ro", "function", "fcall", "fcall_ro",
  // Connection state of the shared connection.
  "select", "move", "auth", "hello", "client", "reset", "quit", "multi", "exec", "discard", "watch", "unwatch", "readonly", "readwrite",
  "subscribe", "psubscribe", "ssubscribe", "unsubscribe", "punsubscribe", "sunsubscribe", "monitor",
  // Blocking commands.
  "blpop", "brpop", "brpoplpush", "blmove", "blmpop", "bzpopmin", "bzpopmax", "bzmpop", "wait", "waitaof",
  // Whole-keyspace listing (use the `scan` operation).
  "keys",
]);
// Commands that read, report on or reset server-wide state: they would escape REDIS_KEY_PREFIX.
// PUBLISH is included because channels are prefixed by the `publish` operation, not by the key table.
// SLOWLOG shows other clients' commands and keys, INFO the key counts of every database, LATENCY RESET
// clears server-wide data.
const KEYSPACE_COMMANDS = new Set(["scan", "randomkey", "dbsize", "publish", "spublish", "pubsub", "slowlog", "info", "latency"]);
const COMMAND_NAME = /^[a-z][a-z0-9_.|-]{0,63}$/i;
const MAX_ARGUMENTS = 1000;

/**
 * Loads the ioredis command table's key finder lazily.
 *
 * @returns `(commandName, args) => keyIndexes | null` (null for an unknown command) (Promise<function>)
 */
export async function loadKeyIndexFinder() {
  const commandTable = await import("@ioredis/commands").catch((importError) => {
    throw classifyImportError("@ioredis/commands", importError);
  });
  return (commandName, commandArguments) => (commandTable.exists(commandName) ? commandTable.getKeyIndexes(commandName, commandArguments) : null);
}

/**
 * Builds the `command` operation.
 *
 * @param dependencies - Overrides for tests (object, optional)
 * @param dependencies.loadFinder - Async loader of the key finder (function, default loadKeyIndexFinder)
 * @returns Operation definition (object)
 */
export function createCommandOperation({ loadFinder = loadKeyIndexFinder } = {}) {
  return defineOperation({
    name: "command",
    title: "Run Redis command",
    description:
      "Workflow nodes only: run one Redis command given as name + argument array, e.g. {\"command\": \"HINCRBY\", \"args\": [\"stats\", \"views\", 1]}. Dangerous, scripting, blocking and connection-state commands are refused.",
    nodeOnly: true,
    isWrite: true,
    properties: {
      command: { type: "string", description: "Command name, e.g. \"ZSCORE\" or \"OBJECT\"" },
      args: { type: "array", maxItems: MAX_ARGUMENTS, description: "Arguments (strings or numbers), never a joined string" },
      encoding: ENCODING_PROPERTY,
    },
    required: ["command"],
    execute: async (context) => {
      const { args, client } = context;
      const commandName = validateCommandName(args.command);
      const commandArguments = (args.args ?? []).map((argument, index) => normaliseArgument(argument, index, context));
      assertNotBlocking(commandName, commandArguments);
      const finalArguments = client.keyspace.prefix
        ? applyPrefix(commandName, commandArguments, client.keyspace, await loadFinder())
        : commandArguments;
      const reply = decodeReply(await sendCommand(context, commandName, finalArguments, true), args.encoding);
      if (measureJsonBytes(reply) > client.settings.maxResultBytes) {
        throw invalidInput(`The reply is larger than REDIS_MAX_RESULT_BYTES (${client.settings.maxResultBytes}); ask for less`);
      }
      return { command: commandName.toUpperCase(), reply };
    },
  });
}

function validateCommandName(rawName) {
  const commandName = String(rawName ?? "").trim().toLowerCase();
  if (!COMMAND_NAME.test(commandName)) throw invalidInput("`command` must be a single Redis command name");
  if (DENIED_COMMANDS.has(commandName)) throw permissionDenied(`${commandName.toUpperCase()} is not allowed through the command operation`);
  return commandName;
}

function normaliseArgument(argument, index, { args, client }) {
  if (typeof argument === "number" && Number.isFinite(argument)) return String(argument);
  if (typeof argument !== "string") throw invalidInput(`\`args[${index}]\` must be a string or a number`);
  return encodeValue(argument, { encoding: args.encoding, label: `args[${index}]`, maxBytes: client.settings.maxValueBytes });
}

// XREAD/XREADGROUP with BLOCK would hold the shared connection.
function assertNotBlocking(commandName, commandArguments) {
  if (!["xread", "xreadgroup"].includes(commandName)) return;
  if (commandArguments.some((argument) => String(argument).toUpperCase() === "BLOCK")) {
    throw permissionDenied(`${commandName.toUpperCase()} with BLOCK is not allowed; poll without BLOCK instead`);
  }
}

function applyPrefix(commandName, commandArguments, keyspace, findKeyIndexes) {
  if (KEYSPACE_COMMANDS.has(commandName)) {
    throw permissionDenied(`${commandName.toUpperCase()} works across the keyspace and is not allowed with REDIS_KEY_PREFIX; use the dedicated operations`);
  }
  // COPY … DB n writes into another database, outside this prefix's database.
  if (commandName === "copy" && commandArguments.some((argument) => String(argument).toUpperCase() === "DB")) {
    throw permissionDenied("COPY with DB writes into another database and is not allowed with REDIS_KEY_PREFIX");
  }
  const keyIndexes = findKeyIndexes(commandName, commandArguments);
  if (keyIndexes === null) throw permissionDenied(`${commandName.toUpperCase()} is unknown to the key table, so REDIS_KEY_PREFIX cannot be applied`);
  const prefixBuffer = Buffer.from(keyspace.prefix, "utf8");
  return commandArguments.map((argument, index) =>
    keyIndexes.includes(index) ? Buffer.concat([prefixBuffer, Buffer.isBuffer(argument) ? argument : Buffer.from(String(argument), "utf8")]) : argument,
  );
}
