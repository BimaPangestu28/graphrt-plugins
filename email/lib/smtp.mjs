/**
 * SMTP through nodemailer: connection checks and sending, with bounded
 * timeouts, cancellation and error mapping.
 *
 * One transport (one connection) per call. Sends are never retried: every
 * send failure is `retryable: false` and says whether the message could
 * already have gone out. nodemailer's file and URL access is disabled, so a
 * message can only carry content this plugin loaded itself.
 */
import { connect } from "node:net";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { cancelled, classifyImportError } from "./errors.mjs";

/** Connect 20 s, greeting 15 s, 45 s of silence: a stuck server fails well inside the 120 s operation timeout. */
export const SMTP_TIMEOUTS = { connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 45000, dnsTimeout: 10000 };
const CONNECTION_ERROR_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ETLS", "EPROXY", "EREQUIRETLS", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"]);
// Failures that prove the message was not handed over (login, DNS, refused envelope or content).
// Connection errors are not in the list: nodemailer reports a drop during DATA the same way as one before it.
const NOT_SENT_ERROR_CODES = new Set(["EAUTH", "ENOAUTH", "EDNS", "EENVELOPE", "EMESSAGE", "EMAXLIMIT", "EREQUIRETLS"]);
const MAX_RESPONSE_CHARS = 300;

/**
 * Default transport factory: lazily imports nodemailer so the plugin loads without it.
 *
 * @param transportOptions - nodemailer SMTP options (object)
 * @returns nodemailer transporter (Promise<object>)
 * @throws PluginError kind `setup_required` - When nodemailer is not installed
 */
export async function createNodemailerTransport(transportOptions) {
  const nodemailerModule = await import("nodemailer").catch((importError) => {
    throw classifyImportError("nodemailer", importError);
  });
  return (nodemailerModule.default ?? nodemailerModule).createTransport(transportOptions);
}

/**
 * Builds nodemailer SMTP options for one connection.
 *
 * @param smtpSettings - `{host, port, secure, user}` (object)
 * @param password - Account password (string)
 * @returns nodemailer options (object)
 */
export function buildSmtpTransportOptions(smtpSettings, password) {
  return {
    host: smtpSettings.host,
    port: smtpSettings.port,
    secure: smtpSettings.secure,
    // Without implicit TLS, insist on STARTTLS so the password never crosses the network in clear text.
    requireTLS: !smtpSettings.secure,
    auth: { user: smtpSettings.user, pass: password },
    tls: { minVersion: "TLSv1.2", servername: smtpSettings.host },
    ...SMTP_TIMEOUTS,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/**
 * Connects and authenticates without sending anything.
 *
 * @param options - `{createTransport, smtpSettings, password, signal, redact, connectSocket?}` (object);
 *   `connectSocket` is the TCP connect used by the abortable socket hook (tests inject a fake)
 * @returns `{ok: true, host, port, secure, user}` (Promise<object>)
 * @throws PluginError kinds `auth_error`, `network_error` (retryable), `rate_limited`, `api_error`, `cancelled`
 */
export async function verifySmtpConnection({ createTransport, smtpSettings, password, signal, redact, connectSocket }) {
  if (signal?.aborted) throw cancelled();
  const transport = await createAbortableTransport({ createTransport, smtpSettings, password, signal, connectSocket });
  try {
    if (signal?.aborted) throw cancelled();
    await raceWithSignal(transport.verify(), signal);
    return { ok: true, host: smtpSettings.host, port: smtpSettings.port, secure: smtpSettings.secure, user: smtpSettings.user };
  } catch (verifyError) {
    throw signal?.aborted ? cancelled() : classifySmtpError(verifyError, { phase: "verify", smtpSettings, redact });
  } finally {
    transport.close?.();
  }
}

/**
 * Sends one message. Never retried.
 *
 * Cancelling destroys the connection, even during DATA; the message may still have been accepted by then,
 * so a cancel after the transport exists reports an unknown outcome.
 *
 * @param options - `{createTransport, smtpSettings, password, message, signal, redact, connectSocket?}` (object)
 * @param options.message - nodemailer message (`from`, `to`, `subject`, ...) (object)
 * @param options.connectSocket - TCP connect for the abortable socket hook; tests inject a fake (function, optional)
 * @returns nodemailer info `{messageId, accepted, rejected, response}` (Promise<object>)
 * @throws PluginError (never retryable) kinds `auth_error`, `invalid_input` (recipients refused), `network_error`,
 *   `rate_limited`, `api_error`, `cancelled`
 */
export async function sendSmtpMessage({ createTransport, smtpSettings, password, message, signal, redact, connectSocket }) {
  if (signal?.aborted) throw cancelled("nothing was sent");
  const transport = await createAbortableTransport({ createTransport, smtpSettings, password, signal, connectSocket });
  if (signal?.aborted) {
    transport.close?.();
    throw cancelled("nothing was sent");
  }
  try {
    return await raceWithSignal(transport.sendMail(message), signal);
  } catch (sendError) {
    if (signal?.aborted) {
      throw cancelled("the connection was closed, but the message may or may not have been sent (the server may already have accepted it); check your Sent mailbox or ask the recipient before sending again");
    }
    throw classifySmtpError(sendError, { phase: "send", smtpSettings, redact });
  } finally {
    transport.close?.();
  }
}

/**
 * nodemailer `getSocket` hook: opens the TCP connection itself (bounded by
 * `connectionTimeout`), hands it to nodemailer as `{connection}` (nodemailer
 * then does implicit TLS or STARTTLS on it as configured) and keeps a handle
 * on it, so an abort destroys the connection even in the middle of a send.
 *
 * @param signal - Cancellation signal (AbortSignal, optional)
 * @param connectSocket - `({host, port}) => net.Socket`, injectable for tests (function, optional)
 * @returns `(socketOptions, callback) => void` for nodemailer's `getSocket` option (function)
 *
 * @example
 * createTransport({ ...buildSmtpTransportOptions(settings, password), getSocket: createAbortableSocketProvider(signal) });
 */
export function createAbortableSocketProvider(signal, connectSocket = connect) {
  return (socketOptions, callback) => {
    if (signal?.aborted) {
      setImmediate(() => callback(cancelled("nothing was sent")));
      return;
    }
    const socket = connectSocket({ host: socketOptions.host, port: socketOptions.port });
    // destroy() without an error: nodemailer (or settleWhenConnected) reports the closed connection.
    const destroySocket = () => socket.destroy();
    signal?.addEventListener("abort", destroySocket, { once: true });
    socket.once("close", () => signal?.removeEventListener("abort", destroySocket));
    settleWhenConnected(socket, socketOptions.connectionTimeout ?? SMTP_TIMEOUTS.connectionTimeout, callback);
  };
}

// Calls back once: with `{connection}` on connect, or with an error coded like nodemailer's own connection errors.
function settleWhenConnected(socket, timeoutMs, callback) {
  const finish = (connectError) => {
    clearTimeout(connectTimer);
    socket.off("connect", onConnect);
    socket.off("error", finish);
    socket.off("close", onClose);
    if (!connectError) return callback(null, { connection: socket });
    socket.destroy();
    return callback(connectError);
  };
  const onConnect = () => finish(null);
  const onClose = () => finish(Object.assign(new Error("Connection closed before it was established"), { code: "ECONNECTION" }));
  const connectTimer = setTimeout(() => finish(Object.assign(new Error(`Connection timeout after ${timeoutMs} ms`), { code: "ETIMEDOUT" })), timeoutMs);
  socket.once("connect", onConnect);
  socket.once("error", finish);
  socket.once("close", onClose);
}

function createAbortableTransport({ createTransport, smtpSettings, password, signal, connectSocket }) {
  const getSocket = createAbortableSocketProvider(signal, connectSocket);
  return createTransport({ ...buildSmtpTransportOptions(smtpSettings, password), getSocket });
}

/**
 * Maps a nodemailer error to a PluginError with a redacted message.
 *
 * @param smtpError - Error from nodemailer (Error)
 * @param context - `{phase: "verify"|"send", smtpSettings, redact}` (object)
 * @returns PluginError; `retryable` only for connection failures during "verify" (PluginError)
 */
export function classifySmtpError(smtpError, { phase, smtpSettings, redact }) {
  if (smtpError instanceof PluginError) return smtpError;
  const isSend = phase === "send";
  const detail = describeSmtpFailure(smtpError, redact);
  const where = `${smtpSettings.host}:${smtpSettings.port}`;
  const outcome = isSend ? ` ${describeSendOutcome(smtpError)}` : "";
  const code = smtpError?.code;
  if (code === "EAUTH" || code === "ENOAUTH" || smtpError?.responseCode === 535 || smtpError?.responseCode === 534) {
    return new PluginError(
      `SMTP login failed for ${smtpSettings.user} at ${where}: ${detail}. Check EMAIL_SMTP_USER and EMAIL_PASSWORD (Gmail needs an app password with 2-Step Verification).${outcome}`,
      { kind: "auth_error" },
    );
  }
  if (code === "EENVELOPE") return new PluginError(`The SMTP server refused the recipients or sender: ${detail}.${outcome}`, { kind: "invalid_input" });
  if (CONNECTION_ERROR_CODES.has(code)) {
    return new PluginError(`Could not talk to the SMTP server ${where}: ${detail}.${outcome}`, { kind: "network_error", retryable: !isSend });
  }
  if (isTemporaryRejection(smtpError)) {
    return new PluginError(`The SMTP server ${where} temporarily refused: ${detail}.${outcome}`, { kind: "rate_limited", retryable: !isSend });
  }
  if (code === "EMESSAGE" || code === "EMAXLIMIT") return new PluginError(`The SMTP server refused the message: ${detail}.${outcome}`, { kind: "invalid_input" });
  return new PluginError(`SMTP ${phase} failed at ${where}: ${detail}.${outcome}`, { kind: "api_error" });
}

function describeSendOutcome(smtpError) {
  if (NOT_SENT_ERROR_CODES.has(smtpError?.code)) {
    return "Nothing was sent. Sends are not retried automatically.";
  }
  return "The message may or may not have been sent: check your Sent mailbox or ask the recipient before sending again.";
}

function isTemporaryRejection(smtpError) {
  const responseCode = Number(smtpError?.responseCode);
  return responseCode >= 400 && responseCode < 500;
}

function describeSmtpFailure(smtpError, redact) {
  const parts = [smtpError?.code, smtpError?.responseCode, smtpError?.response ?? smtpError?.message].filter((part) => part !== undefined && part !== null && part !== "");
  const text = redact(parts.join(" ")).replace(/\s+/g, " ").trim();
  return text.length > MAX_RESPONSE_CHARS ? `${text.slice(0, MAX_RESPONSE_CHARS)}…` : text || "unknown error";
}

function raceWithSignal(workPromise, signal) {
  if (!signal) return workPromise;
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(signal.reason ?? new Error("aborted"));
    // An abort that happened before the listener exists would otherwise never fire.
    if (signal.aborted) {
      workPromise.catch(() => {});
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    workPromise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
