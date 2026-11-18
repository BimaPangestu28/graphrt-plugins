import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildSecretVariants, createRedactor } from "../lib/errors.mjs";
import { IMAP_TIMEOUTS, buildImapOptions, classifyImapError, withImapConnection, withMailbox } from "../lib/imap.mjs";
import { SMTP_TIMEOUTS, buildSmtpTransportOptions, classifySmtpError, createAbortableSocketProvider, sendSmtpMessage, verifySmtpConnection } from "../lib/smtp.mjs";
import { TEST_PASSWORD, TEST_USER, createFakeImapClient, createFakeSmtpFactory } from "./helpers.mjs";

const SMTP_SETTINGS = { host: "smtp.example.com", port: 465, secure: true, user: TEST_USER };
const IMAP_SETTINGS = { host: "imap.example.com", port: 993, secure: true, user: TEST_USER };
const redact = createRedactor(buildSecretVariants({ user: TEST_USER, password: TEST_PASSWORD }));

function smtpError(code, extra = {}) {
  return Object.assign(new Error(extra.message ?? `${code} failure`), { code, ...extra });
}

test("SMTP options: no logging, no file/URL access, bounded timeouts, STARTTLS required without implicit TLS", () => {
  const secureOptions = buildSmtpTransportOptions(SMTP_SETTINGS, TEST_PASSWORD);
  assert.equal(secureOptions.logger, false);
  assert.equal(secureOptions.debug, false);
  assert.equal(secureOptions.disableFileAccess, true);
  assert.equal(secureOptions.disableUrlAccess, true);
  assert.equal(secureOptions.requireTLS, false);
  assert.deepEqual(secureOptions.auth, { user: TEST_USER, pass: TEST_PASSWORD });
  for (const [name, value] of Object.entries(SMTP_TIMEOUTS)) assert.equal(secureOptions[name], value);
  assert.equal(buildSmtpTransportOptions({ ...SMTP_SETTINGS, port: 587, secure: false }, TEST_PASSWORD).requireTLS, true);
});

const SMTP_ERROR_CASES = [
  // [error, phase, kind, retryable, message pattern]
  [smtpError("EAUTH", { responseCode: 535, response: "535-5.7.8 Username and Password not accepted" }), "verify", "auth_error", false, /login failed/],
  [smtpError("ECONNECTION"), "verify", "network_error", true, /Could not talk/],
  [smtpError("ETIMEDOUT"), "send", "network_error", false, /may or may not have been sent/],
  [smtpError("EAUTH", { response: "535 bad" }), "send", "auth_error", false, /Nothing was sent/],
  [smtpError("EENVELOPE", { response: "550 5.1.1 no such user", responseCode: 550 }), "send", "invalid_input", false, /Nothing was sent/],
  [smtpError("EPROTOCOL", { response: "421 4.7.0 Try again later", responseCode: 421 }), "send", "rate_limited", false, /may or may not/],
  [smtpError("EMESSAGE", { response: "552 5.3.4 Message size exceeds", responseCode: 552 }), "send", "invalid_input", false, /refused the message/],
  [smtpError("EPROTOCOL", { response: "500 weird" }), "verify", "api_error", false, /SMTP verify failed/],
];

for (const [error, phase, expectedKind, expectedRetryable, messagePattern] of SMTP_ERROR_CASES) {
  test(`classifySmtpError ${error.code} during ${phase} → ${expectedKind}`, () => {
    const pluginError = classifySmtpError(error, { phase, smtpSettings: SMTP_SETTINGS, redact });
    assert.equal(pluginError.kind, expectedKind);
    assert.equal(pluginError.retryable, expectedRetryable);
    assert.match(pluginError.message, messagePattern);
  });
}

test("SMTP errors quoting the password or the AUTH PLAIN token are redacted", () => {
  const plainToken = Buffer.from(`\u0000${TEST_USER}\u0000${TEST_PASSWORD}`).toString("base64");
  const pluginError = classifySmtpError(smtpError("EAUTH", { response: `535 AUTH PLAIN ${plainToken} rejected for ${TEST_PASSWORD}` }), { phase: "verify", smtpSettings: SMTP_SETTINGS, redact });
  assert.ok(!pluginError.message.includes(TEST_PASSWORD));
  assert.ok(!pluginError.message.includes(plainToken));
});

test("verifySmtpConnection closes the transport, success and failure", async () => {
  const factory = createFakeSmtpFactory();
  assert.equal((await verifySmtpConnection({ createTransport: factory, smtpSettings: SMTP_SETTINGS, password: TEST_PASSWORD, redact })).ok, true);
  const failingFactory = createFakeSmtpFactory({ verify: () => Promise.reject(smtpError("EAUTH", { response: "535 no" })) });
  await assert.rejects(verifySmtpConnection({ createTransport: failingFactory, smtpSettings: SMTP_SETTINGS, password: TEST_PASSWORD, redact }), { kind: "auth_error" });
  assert.ok(factory.transports[0].closed && failingFactory.transports[0].closed);
});

test("sendSmtpMessage: an aborted signal before sending sends nothing; an abort mid-send says the outcome is unknown", async () => {
  const factory = createFakeSmtpFactory();
  await assert.rejects(
    sendSmtpMessage({ createTransport: factory, smtpSettings: SMTP_SETTINGS, password: TEST_PASSWORD, message: {}, signal: AbortSignal.abort(), redact }),
    { kind: "cancelled", message: /nothing was sent/ },
  );
  assert.equal(factory.transports.length, 0);
  const controller = new AbortController();
  const hangingFactory = createFakeSmtpFactory({ sendMail: () => new Promise(() => {}) });
  const sending = sendSmtpMessage({ createTransport: hangingFactory, smtpSettings: SMTP_SETTINGS, password: TEST_PASSWORD, message: {}, signal: controller.signal, redact });
  setImmediate(() => controller.abort());
  await assert.rejects(sending, { kind: "cancelled", retryable: false, message: /may or may not have been sent/ });
});

// A socket stand-in: `connect` is emitted on the next tick unless `failWith` is set; destroy() emits close.
function createFakeConnect({ failWith } = {}) {
  const fakeConnect = (connectOptions) => {
    const socket = Object.assign(new EventEmitter(), { connectOptions, destroyed: false });
    socket.destroy = () => {
      if (socket.destroyed) return;
      socket.destroyed = true;
      setImmediate(() => socket.emit("close"));
    };
    // Like a real socket, a destroyed one never connects.
    setImmediate(() => socket.destroyed || (failWith ? socket.emit("error", failWith) : socket.emit("connect")));
    fakeConnect.sockets.push(socket);
    return socket;
  };
  fakeConnect.sockets = [];
  return fakeConnect;
}

// Asks the transport for its connection the way nodemailer's SMTP transport does, then hangs like a stuck DATA phase.
function requestConnectionAndHang(transport, onSettled) {
  transport.options.getSocket({ ...transport.options }, (socketError, socketOptions) => onSettled(socketError, socketOptions));
  return new Promise(() => {});
}

test("cancelling a send in flight destroys the SMTP connection handed to nodemailer", async () => {
  const controller = new AbortController();
  const fakeConnect = createFakeConnect();
  let handedOver;
  const hangingFactory = createFakeSmtpFactory({ sendMail: (message, transport) => requestConnectionAndHang(transport, (socketError, socketOptions) => (handedOver = socketOptions)) });
  const sending = sendSmtpMessage({ createTransport: hangingFactory, smtpSettings: SMTP_SETTINGS, password: TEST_PASSWORD, message: {}, signal: controller.signal, redact, connectSocket: fakeConnect });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  const [socket] = fakeConnect.sockets;
  assert.deepEqual(socket.connectOptions, { host: SMTP_SETTINGS.host, port: SMTP_SETTINGS.port });
  assert.equal(handedOver.connection, socket, "nodemailer only honours `connection` from getSocket");
  assert.equal(socket.destroyed, false);
  controller.abort();
  await assert.rejects(sending, { kind: "cancelled", message: /may or may not have been sent/ });
  assert.equal(socket.destroyed, true);
});

test("the socket hook reports connect failures with nodemailer-style codes and an abort during connect", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const provideRefused = createAbortableSocketProvider(undefined, createFakeConnect({ failWith: refused }));
  const refusedError = await new Promise((resolvePromise) => provideRefused({ host: "h", port: 1 }, resolvePromise));
  assert.equal(refusedError, refused);
  const controller = new AbortController();
  const fakeConnect = createFakeConnect();
  const provideAbortable = createAbortableSocketProvider(controller.signal, fakeConnect);
  const settled = new Promise((resolvePromise) => provideAbortable({ host: "h", port: 1 }, resolvePromise));
  controller.abort();
  assert.equal((await settled).code, "ECONNECTION");
  assert.equal(fakeConnect.sockets[0].destroyed, true);
});

test("an abort while the SMTP transport is being created sends nothing", async () => {
  const controller = new AbortController();
  const factory = createFakeSmtpFactory();
  const abortingFactory = async (transportOptions) => {
    controller.abort();
    return factory(transportOptions);
  };
  await assert.rejects(
    sendSmtpMessage({ createTransport: abortingFactory, smtpSettings: SMTP_SETTINGS, password: TEST_PASSWORD, message: {}, signal: controller.signal, redact }),
    { kind: "cancelled", message: /nothing was sent/ },
  );
  assert.equal(factory.transports[0].sentMessages.length, 0);
  assert.equal(factory.transports[0].closed, true);
  await assert.rejects(
    verifySmtpConnection({ createTransport: abortingFactory, smtpSettings: SMTP_SETTINGS, password: TEST_PASSWORD, signal: controller.signal, redact }),
    { kind: "cancelled" },
  );
});

test("an abort while the IMAP client is being created never connects and closes the client", async () => {
  const controller = new AbortController();
  const imapClient = createFakeImapClient();
  const abortingCreate = async () => {
    controller.abort();
    return imapClient;
  };
  const connecting = withImapConnection({ ...connectionOptions(imapClient), createImapClient: abortingCreate, signal: controller.signal }, async () => "worked");
  await assert.rejects(connecting, { kind: "cancelled" });
  assert.ok(!imapClient.calls.some((call) => call[0] === "connect"));
  assert.equal(imapClient.closed, true);
});

test("the IMAP error listener stays attached after close and logs redacted", async () => {
  const imapClient = createFakeImapClient();
  await withImapConnection(connectionOptions(imapClient), async () => "done");
  const errorListener = imapClient.listeners.get("error");
  assert.equal(typeof errorListener, "function");
  const originalConsoleError = console.error;
  const loggedLines = [];
  console.error = (line) => loggedLines.push(String(line));
  try {
    errorListener(new Error(`late socket error ${TEST_PASSWORD}`));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(loggedLines.length, 1);
  assert.ok(!loggedLines[0].includes(TEST_PASSWORD));
  assert.match(loggedLines[0], /late socket error \[redacted\]/);
});

test("IMAP options: no logger, no auto-IDLE, bounded timeouts, STARTTLS forced without implicit TLS", () => {
  const imapOptions = buildImapOptions(IMAP_SETTINGS, TEST_PASSWORD);
  assert.equal(imapOptions.logger, false);
  assert.equal(imapOptions.disableAutoIdle, true);
  assert.equal(imapOptions.doSTARTTLS, undefined);
  for (const [name, value] of Object.entries(IMAP_TIMEOUTS)) assert.equal(imapOptions[name], value);
  assert.equal(buildImapOptions({ ...IMAP_SETTINGS, port: 143, secure: false }, TEST_PASSWORD).doSTARTTLS, true);
});

function connectionOptions(imapClient, extra = {}) {
  return { createImapClient: async () => imapClient, imapSettings: IMAP_SETTINGS, password: TEST_PASSWORD, redact, ...extra };
}

test("withImapConnection logs out after the work and after a failing work", async () => {
  const imapClient = createFakeImapClient();
  assert.equal(await withImapConnection(connectionOptions(imapClient), async () => "done"), "done");
  assert.ok(imapClient.loggedOut);
  const failingClient = createFakeImapClient();
  await assert.rejects(withImapConnection(connectionOptions(failingClient), async () => {
    throw Object.assign(new Error("socket gone"), { code: "EConnectionClosed" });
  }), { kind: "network_error", retryable: true });
  assert.ok(failingClient.loggedOut || failingClient.closed);
});

test("withImapConnection closes (no logout) when connecting failed, and maps auth failures with redaction", async () => {
  const imapClient = createFakeImapClient({ connectError: Object.assign(new Error(`Invalid credentials ${TEST_PASSWORD}`), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }) });
  await assert.rejects(withImapConnection(connectionOptions(imapClient), async () => {}), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.ok(!error.message.includes(TEST_PASSWORD));
    return true;
  });
  assert.equal(imapClient.loggedOut, false);
  assert.equal(imapClient.closed, true);
});

test("cancelling closes the socket; writes report an unknown outcome", async () => {
  const imapClient = createFakeImapClient({ hangOnConnect: true });
  const controller = new AbortController();
  const connecting = withImapConnection(connectionOptions(imapClient, { signal: controller.signal, isWrite: true }), async () => {});
  setImmediate(() => controller.abort());
  await assert.rejects(connecting, { kind: "cancelled", retryable: false, message: /may or may not have been applied/ });
  assert.equal(imapClient.closed, true);
});

test("an already aborted signal never connects", async () => {
  const imapClient = createFakeImapClient();
  await assert.rejects(withImapConnection(connectionOptions(imapClient, { signal: AbortSignal.abort() }), async () => {}), { kind: "cancelled" });
  assert.equal(imapClient.calls.length, 0);
});

test("classifyImapError: network errors are not retryable for writes, throttling is rate_limited", () => {
  const networkError = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
  assert.equal(classifyImapError(networkError, { imapSettings: IMAP_SETTINGS, redact }).retryable, true);
  const writeError = classifyImapError(networkError, { imapSettings: IMAP_SETTINGS, redact, isWrite: true });
  assert.equal(writeError.retryable, false);
  assert.match(writeError.message, /may or may not have been applied/);
  const throttled = classifyImapError(Object.assign(new Error("slow down"), { code: "ETHROTTLE", throttleReset: 5000 }), { imapSettings: IMAP_SETTINGS, redact });
  assert.deepEqual([throttled.kind, throttled.retryAfterMs], ["rate_limited", 5000]);
  assert.equal(classifyImapError(Object.assign(new Error("NO what"), { responseStatus: "NO" }), { imapSettings: IMAP_SETTINGS, redact }).kind, "api_error");
});

test("withMailbox maps a missing mailbox to not_found and always releases the lock", async () => {
  const imapClient = createFakeImapClient({ missingMailboxes: ["Nope"] });
  await assert.rejects(withMailbox(imapClient, "Nope", { readOnly: true }, async () => {}), { kind: "not_found" });
  await assert.rejects(withMailbox(imapClient, "INBOX", { readOnly: true }, async () => {
    throw new Error("x");
  }));
  assert.deepEqual(imapClient.calls.at(-1), ["release", "INBOX"]);
});
