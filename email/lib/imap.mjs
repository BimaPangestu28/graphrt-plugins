/**
 * IMAP through imapflow: one connection per operation, always logged out (or
 * closed) in `finally`, with bounded connect/greeting/socket timeouts and
 * cancellation that closes the socket.
 *
 * imapflow logging is turned off (its default logger writes to stdout, which
 * carries the plugin protocol) and auto-IDLE is disabled (no connection
 * outlives its operation).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { cancelled, classifyImportError, notFound } from "./errors.mjs";

/** Connect 20 s, greeting 15 s, 60 s of silence: fails well inside the 120 s operation timeout. */
export const IMAP_TIMEOUTS = { connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 60000 };
const LOGOUT_TIMEOUT_MS = 5000;
const NETWORK_ERROR_CODES = new Set([
  "NoConnection", "EConnectionClosed", "ClosedAfterConnectText", "ClosedAfterConnectTLS", "CONNECT_TIMEOUT", "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT", "ETIMEOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT", "EPROXY", "ProxyError",
]);
const MAX_DETAIL_CHARS = 300;

/**
 * Default IMAP client factory: lazily imports imapflow so the plugin loads without it.
 *
 * @param imapOptions - ImapFlow options (object)
 * @returns ImapFlow instance (Promise<object>)
 * @throws PluginError kind `setup_required` - When imapflow is not installed
 */
export async function createImapFlowClient(imapOptions) {
  const imapflowModule = await import("imapflow").catch((importError) => {
    throw classifyImportError("imapflow", importError);
  });
  return new imapflowModule.ImapFlow(imapOptions);
}

/**
 * Builds ImapFlow options for one connection.
 *
 * @param imapSettings - `{host, port, secure, user}` (object)
 * @param password - Account password (string)
 * @returns ImapFlow options (object)
 */
export function buildImapOptions(imapSettings, password) {
  return {
    host: imapSettings.host,
    port: imapSettings.port,
    secure: imapSettings.secure,
    // Without implicit TLS, require STARTTLS so the password never crosses the network in clear text.
    doSTARTTLS: imapSettings.secure ? undefined : true,
    auth: { user: imapSettings.user, pass: password },
    tls: { minVersion: "TLSv1.2", servername: imapSettings.host },
    ...IMAP_TIMEOUTS,
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    clientInfo: { name: "graphrt-email" },
  };
}

/**
 * Opens a connection, runs `work(imapClient)`, then logs out.
 *
 * @param options - Connection options (object)
 * @param options.createImapClient - `(imapOptions) => ImapFlow` (function)
 * @param options.imapSettings - `{host, port, secure, user}` (object)
 * @param options.password - Account password (string)
 * @param options.signal - Cancellation signal; aborting closes the socket (AbortSignal, optional)
 * @param options.redact - From createRedactor (function)
 * @param options.isWrite - true for flag changes and moves: failures are then not retryable (boolean)
 * @param work - `async (imapClient) => result` (function)
 * @returns The result of `work` (Promise<any>)
 * @throws PluginError kinds `auth_error`, `network_error`, `not_found`, `rate_limited`, `api_error`, `cancelled`
 */
export async function withImapConnection({ createImapClient, imapSettings, password, signal, redact, isWrite = false }, work) {
  if (signal?.aborted) throw cancelled();
  const imapClient = await createImapClient(buildImapOptions(imapSettings, password));
  // ImapFlow can emit 'error' events even after close; without a listener Node would crash the plugin,
  // so the listener is never removed.
  imapClient.on?.("error", (clientError) => console.error(`[email] IMAP connection error: ${redact(clientError?.message ?? clientError)}`));
  const onAbort = () => imapClient.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // The abort listener did not exist while the client was being created.
    if (signal?.aborted) throw cancelled();
    await imapClient.connect();
    return await work(imapClient);
  } catch (imapError) {
    if (signal?.aborted) throw cancelled(isWrite ? "the change may or may not have been applied" : "");
    throw classifyImapError(imapError, { imapSettings, redact, isWrite });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await closeConnection(imapClient);
  }
}

/**
 * Locks (selects) a mailbox for `work` and releases it afterwards.
 *
 * @param imapClient - Connected ImapFlow (object)
 * @param mailboxPath - e.g. "INBOX" (string)
 * @param options.readOnly - EXAMINE instead of SELECT, so nothing (not even \Seen) changes (boolean)
 * @param work - `async (mailbox) => result`; `mailbox` is ImapFlow's MailboxObject (function)
 * @returns The result of `work` (Promise<any>)
 * @throws PluginError kind `not_found` - When the mailbox does not exist
 */
export async function withMailbox(imapClient, mailboxPath, { readOnly }, work) {
  let mailboxLock;
  try {
    mailboxLock = await imapClient.getMailboxLock(mailboxPath, { readOnly });
  } catch (lockError) {
    if (lockError?.mailboxMissing || /NONEXISTENT|doesn't exist|does not exist|Unknown Mailbox|not found/i.test(`${lockError?.serverResponseCode ?? ""} ${lockError?.responseText ?? ""}`)) {
      throw notFound(`Mailbox ${JSON.stringify(mailboxPath)} does not exist (list_mailboxes shows the available ones)`);
    }
    throw lockError;
  }
  try {
    return await work(imapClient.mailbox);
  } finally {
    mailboxLock.release();
  }
}

/**
 * imapflow returns `false` instead of throwing when the server refuses a STORE
 * (or the command fails); this turns that into an error with an unknown outcome.
 *
 * @param writeResult - Return value of messageFlagsAdd/messageFlagsRemove (boolean)
 * @param description - What was attempted (string)
 * @throws PluginError kind `api_error`, not retryable - When `writeResult` is false
 *
 * @example
 * assertWriteReported(await imapClient.messageFlagsAdd("12", ["\\Seen"], { uid: true }), "Setting \\Seen on UID 12");
 */
export function assertWriteReported(writeResult, description) {
  if (writeResult !== false) return;
  throw writeOutcomeUnknown(`${description}: the change may or may not have been applied. Check the mailbox before trying again.`);
}

/**
 * Builds the error for a write whose outcome is unknown.
 *
 * @param message - What was attempted and what to check (string)
 * @returns PluginError kind `api_error`, not retryable (PluginError)
 */
export function writeOutcomeUnknown(message) {
  return new PluginError(message, { kind: "api_error", retryable: false });
}

/**
 * Maps an imapflow error to a PluginError with a redacted message.
 *
 * @param imapError - Error from imapflow (Error)
 * @param context - `{imapSettings, redact, isWrite}` (object)
 * @returns PluginError (PluginError)
 */
export function classifyImapError(imapError, { imapSettings, redact, isWrite = false }) {
  if (imapError instanceof PluginError) return imapError;
  const where = `${imapSettings.host}:${imapSettings.port}`;
  const detail = describeImapFailure(imapError, redact);
  if (imapError?.authenticationFailed || imapError?.serverResponseCode === "AUTHENTICATIONFAILED") {
    return new PluginError(
      `IMAP login failed for ${imapSettings.user} at ${where}: ${detail}. Check the IMAP user and EMAIL_PASSWORD (Gmail needs an app password with 2-Step Verification, and IMAP enabled for Outlook.com).`,
      { kind: "auth_error" },
    );
  }
  if (imapError?.code === "ETHROTTLE") {
    return new PluginError(`The IMAP server ${where} is throttling requests: ${detail}`, { kind: "rate_limited", retryable: !isWrite, retryAfterMs: imapError.throttleReset });
  }
  if (NETWORK_ERROR_CODES.has(imapError?.code) || imapError?.tlsFailed) {
    const outcome = isWrite ? " The change may or may not have been applied: check the mailbox before trying again." : "";
    return new PluginError(`Could not talk to the IMAP server ${where}: ${detail}.${outcome}`, { kind: "network_error", retryable: !isWrite });
  }
  return new PluginError(`IMAP request failed at ${where}: ${detail}`, { kind: "api_error" });
}

async function closeConnection(imapClient) {
  if (!imapClient.usable) {
    imapClient.close?.();
    return;
  }
  let logoutTimer;
  const logoutDeadline = new Promise((resolvePromise) => {
    logoutTimer = setTimeout(resolvePromise, LOGOUT_TIMEOUT_MS);
  });
  try {
    await Promise.race([imapClient.logout().catch(() => {}), logoutDeadline]);
  } finally {
    clearTimeout(logoutTimer);
    imapClient.close?.();
  }
}

function describeImapFailure(imapError, redact) {
  const parts = [imapError?.code, imapError?.serverResponseCode, imapError?.responseText || imapError?.message].filter(Boolean);
  const text = redact(parts.join(" ")).replace(/\s+/g, " ").trim();
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text || "unknown error";
}
