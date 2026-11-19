/**
 * Test doubles: a fake ioredis class that records every command and answers
 * from per-command responders, and a runner wired to it. Nothing here opens a
 * socket or needs the ioredis package.
 */
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const TEST_PASSWORD = "r3dis-Secret";
export const TEST_URL = `redis://default:${TEST_PASSWORD}@cache.example.com:6379/0`;

/** Redis-style ReplyError. */
export function replyError(message) {
  return Object.assign(new Error(message), { name: "ReplyError" });
}

const DEFAULT_RESPONDERS = {
  strlen: () => 0,
  get: () => null,
  set: () => "OK",
  del: (args) => args.length,
  exists: () => 0,
  expire: () => 1,
  ttl: () => -2,
  incr: () => 1,
  incrby: (args) => Number(args[1]),
  hget: () => null,
  hstrlen: () => 0,
  hset: (args) => (args.length - 1) / 2,
  hlen: () => 0,
  hscan: () => [Buffer.from("0"), []],
  hdel: (args) => args.length - 1,
  lpush: (args) => args.length - 1,
  rpush: (args) => args.length - 1,
  llen: () => 0,
  lrange: () => [],
  sadd: (args) => args.length - 1,
  srem: (args) => args.length - 1,
  scard: () => 0,
  smembers: () => [],
  zadd: () => 1,
  zcard: () => 0,
  zrange: () => [],
  zrem: (args) => args.length - 1,
  scan: () => [Buffer.from("0"), []],
  publish: () => 0,
  xadd: () => Buffer.from("1700000000000-0"),
  xrange: () => [],
  xrevrange: () => [],
  xreadgroup: () => null,
  xgroup: () => "OK",
  xack: (args) => args.length - 2,
};

/**
 * Creates a fake ioredis class and its inspectable state.
 *
 * @param options - `{responders: {command: (args) => reply}, connectError, delayMs}` (object)
 * @returns `{loadRedis, state}`; `state.commands` lists `[name, ...args as text]` (object)
 */
export function createFakeRedis(options = {}) {
  const state = {
    responders: { ...DEFAULT_RESPONDERS, ...options.responders },
    connectError: options.connectError ?? null,
    delayMs: options.delayMs ?? 0,
    commands: [],
    rawCommands: [],
    connections: [],
    loadCount: 0,
  };
  class FakeRedis {
    constructor(connectionUrl, connectionOptions) {
      this.connectionUrl = connectionUrl;
      this.options = connectionOptions;
      this.status = "wait";
      this.listeners = {};
      state.connections.push(this);
    }

    on(eventName, listener) {
      this.listeners[eventName] = listener;
      return this;
    }

    async connect() {
      if (state.connectError) {
        this.listeners.error?.(state.connectError);
        this.status = "end";
        throw new Error("Connection is closed.");
      }
      this.status = "ready";
    }

    async quit() {
      this.status = "end";
      return "OK";
    }

    disconnect() {
      this.status = "end";
    }

    async callBuffer(commandName, ...commandArguments) {
      state.rawCommands.push([commandName, ...commandArguments]);
      state.commands.push([commandName, ...commandArguments.map((argument) => (Buffer.isBuffer(argument) ? argument.toString("utf8") : String(argument)))]);
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      const responder = state.responders[commandName];
      if (!responder) throw replyError(`ERR unknown command '${commandName}'`);
      const reply = responder(commandArguments.map((argument) => (Buffer.isBuffer(argument) ? argument.toString("utf8") : String(argument))), commandArguments);
      if (reply instanceof Error) throw reply;
      return typeof reply === "string" && reply !== "OK" ? Buffer.from(reply) : reply;
    }
  }
  const loadRedis = async () => {
    state.loadCount += 1;
    return FakeRedis;
  };
  return { loadRedis, state };
}

/**
 * Builds a runner over the fake.
 *
 * @param options - `{environment, timers, loadFinder, responders, connectError, delayMs}` (object)
 * @returns `{runOperation(name, args, {source, signal}), state, definition}` (object)
 */
export function createTestRunner({ environment = {}, timers, loadFinder, ...fakeOptions } = {}) {
  const { loadRedis, state } = createFakeRedis(fakeOptions);
  const definition = createPluginDefinition({ loadRedis, timers, loadFinder });
  const runner = createOperationRunner(definition, { REDIS_URL: TEST_URL, ...environment });
  const runOperation = (operationName, args = {}, { source = "node", signal } = {}) => runner(operationName, args, { source, signal });
  return { runOperation, state, definition };
}
