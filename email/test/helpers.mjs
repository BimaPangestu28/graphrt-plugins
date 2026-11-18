/**
 * Test doubles: a fake nodemailer transport factory, a fake ImapFlow client
 * and a runner wired to them. Nothing here opens a socket.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const TEST_PASSWORD = "abcd efgh ijkl mnop";
export const TEST_USER = "budi@example.com";

/**
 * Fake `createSmtpTransport`: records options and messages; `sendMail`/`verify` behaviour can be overridden.
 *
 * @param overrides - `{sendMail(message, transport), verify()}` (object, optional)
 * @returns Factory function with `.transports` (function)
 */
export function createFakeSmtpFactory(overrides = {}) {
  const factory = async (transportOptions) => {
    const transport = {
      options: transportOptions,
      sentMessages: [],
      closed: false,
      async verify() {
        if (overrides.verify) return overrides.verify();
        return true;
      },
      async sendMail(message) {
        transport.sentMessages.push(message);
        if (overrides.sendMail) return overrides.sendMail(message, transport);
        return {
          messageId: "<new-1@example.com>",
          accepted: [...message.to, ...message.cc, ...message.bcc].map((entry) => entry.address),
          rejected: [],
          response: "250 2.0.0 OK queued",
        };
      },
      close() {
        transport.closed = true;
      },
    };
    factory.transports.push(transport);
    return transport;
  };
  factory.transports = [];
  return factory;
}

// A `UID SEARCH UID <set>`: with `existingUids` (or `messages`) only those exist, otherwise every requested UID does.
function findExistingUids(state, uidSet) {
  const requestedUids = uidSet.split(",").map(Number);
  const knownUids = state.existingUids ?? (state.messages ? Object.keys(state.messages).map(Number) : null);
  return knownUids ? requestedUids.filter((uid) => knownUids.includes(uid)) : requestedUids;
}

/**
 * Fake ImapFlow. `messages` maps uid → `{envelope, flags, bodyStructure, internalDate, size, headers, parts: {partId: text}}`.
 * Other state: `capabilities` (default IMAP4rev1, MOVE, UIDPLUS), `existingUids`, `flagResult`, `moveResult`, `flagError`.
 *
 * @param state - Initial fake server state (object, optional)
 * @returns Client with `.calls`, `.loggedOut`, `.closed` (object)
 */
export function createFakeImapClient(state = {}) {
  const messages = state.messages ?? {};
  const imapClient = {
    options: null,
    calls: [],
    usable: false,
    loggedOut: false,
    closed: false,
    mailbox: false,
    capabilities: new Map((state.capabilities ?? ["IMAP4rev1", "MOVE", "UIDPLUS"]).map((capability) => [capability, true])),
    listeners: new Map(),
    on(eventName, listener) {
      imapClient.listeners.set(eventName, listener);
    },
    off(eventName) {
      imapClient.listeners.delete(eventName);
    },
    async connect() {
      imapClient.calls.push(["connect"]);
      if (state.connectError) throw state.connectError;
      // Like imapflow: a pending connect() rejects once the socket is closed.
      if (state.hangOnConnect) return new Promise((resolvePromise, rejectPromise) => (imapClient.rejectPendingConnect = rejectPromise));
      imapClient.usable = true;
    },
    async logout() {
      imapClient.calls.push(["logout"]);
      imapClient.loggedOut = true;
      imapClient.usable = false;
    },
    close() {
      imapClient.closed = true;
      imapClient.usable = false;
      imapClient.rejectPendingConnect?.(Object.assign(new Error("Connection closed"), { code: "NoConnection" }));
    },
    async getMailboxLock(path, options) {
      imapClient.calls.push(["lock", path, options]);
      if (state.missingMailboxes?.includes(path)) throw Object.assign(new Error("Mailbox doesn't exist"), { mailboxMissing: true });
      imapClient.mailbox = { path, uidValidity: state.uidValidity ?? 777n };
      return { path, release: () => imapClient.calls.push(["release", path]) };
    },
    async search(query, options) {
      imapClient.calls.push(["search", query, options]);
      if (query?.uid !== undefined) return findExistingUids(state, String(query.uid));
      return state.searchResult ?? Object.keys(messages).map(Number);
    },
    async fetchAll(range, query, options) {
      imapClient.calls.push(["fetchAll", range, query, options]);
      return String(range).split(",").map(Number).filter((uid) => messages[uid]).map((uid) => toFetchObject(uid, messages[uid]));
    },
    async fetchOne(uid, query, options) {
      imapClient.calls.push(["fetchOne", uid, query, options]);
      return messages[uid] ? toFetchObject(Number(uid), messages[uid]) : false;
    },
    async download(uid, part, options) {
      imapClient.calls.push(["download", uid, part, options]);
      const partText = messages[uid]?.parts?.[part];
      if (partText === undefined) return {};
      return { meta: {}, content: Readable.from([Buffer.from(partText).subarray(0, options.maxBytes)]) };
    },
    async messageFlagsAdd(range, flags, options) {
      imapClient.calls.push(["flagsAdd", range, flags, options]);
      if (state.flagError) throw state.flagError;
      return state.flagResult ?? true;
    },
    async messageFlagsRemove(range, flags, options) {
      imapClient.calls.push(["flagsRemove", range, flags, options]);
      return state.flagResult ?? true;
    },
    async messageMove(range, destination, options) {
      imapClient.calls.push(["move", range, destination, options]);
      if (state.moveResult !== undefined) return state.moveResult;
      return { path: imapClient.mailbox.path, destination, uidMap: new Map(String(range).split(",").map((uid, index) => [Number(uid), 500 + index])) };
    },
    async list(options) {
      imapClient.calls.push(["list", options]);
      return state.mailboxes ?? [];
    },
  };
  return imapClient;
}

function toFetchObject(uid, message) {
  return {
    uid,
    seq: uid,
    envelope: message.envelope ?? {},
    flags: new Set(message.flags ?? []),
    bodyStructure: message.bodyStructure,
    internalDate: message.internalDate,
    size: message.size ?? 1000,
    headers: message.headers,
  };
}

/** Fake `createImapClient` returning the given client (or a fresh one each call) and recording options. */
export function createFakeImapFactory(state = {}) {
  const factory = async (imapOptions) => {
    const imapClient = createFakeImapClient(state);
    imapClient.options = imapOptions;
    factory.clients.push(imapClient);
    return imapClient;
  };
  factory.clients = [];
  return factory;
}

/**
 * Creates a runner over a temporary state directory with fake transports.
 *
 * @returns `{runOperation, smtpFactory, imapFactory, stateDirectory, environment, cleanup}`
 */
export async function createTestRunner({ environment = {}, smtpOverrides, imapState, fetchImpl, resolveHostAddresses, clock } = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "email-test-"));
  const smtpFactory = createFakeSmtpFactory(smtpOverrides);
  const imapFactory = createFakeImapFactory(imapState);
  const testEnvironment = {
    EMAIL_SMTP_HOST: "smtp.example.com",
    EMAIL_SMTP_USER: TEST_USER,
    EMAIL_IMAP_HOST: "imap.example.com",
    EMAIL_PASSWORD: TEST_PASSWORD,
    EMAIL_STATE_DIR: stateDirectory,
    ...environment,
  };
  const definition = createPluginDefinition({ createSmtpTransport: smtpFactory, createImapClient: imapFactory, fetchImpl, resolveHostAddresses, clock });
  const runOperation = createOperationRunner(definition, testEnvironment);
  return {
    runOperation: (operationName, args, { source = "tool", signal } = {}) => runOperation(operationName, args, { source, signal }),
    smtpFactory,
    imapFactory,
    definition,
    stateDirectory,
    environment: testEnvironment,
    cleanup: () => rm(stateDirectory, { recursive: true, force: true }),
  };
}

/**
 * Runs `testBody` with a fresh runner and removes its temp directory afterwards.
 *
 * @param runnerOptions - See createTestRunner (object)
 * @param testBody - `async (runner) => void` (function)
 */
export async function withRunner(runnerOptions, testBody) {
  const runner = await createTestRunner(runnerOptions);
  try {
    await testBody(runner);
  } finally {
    await runner.cleanup();
  }
}
