/**
 * Builds the per-operation "client" handed to operations: validated settings,
 * the password redactor, SMTP/IMAP entry points and the send guard.
 *
 * The shared runner calls `createClient` for every operation; connections are
 * opened per call (none is kept), while send guards are cached per state file
 * so reservations stay serialised within the process.
 */
import { join } from "node:path";
import { buildSecretVariants, createRedactor } from "./errors.mjs";
import { withImapConnection, createImapFlowClient } from "./imap.mjs";
import { createSendGuard } from "./send-guard.mjs";
import { requireImapSettings, requireSmtpSettings, resolveSettings } from "./settings.mjs";
import { createNodemailerTransport, sendSmtpMessage, verifySmtpConnection } from "./smtp.mjs";

/**
 * Creates a client factory with injectable side effects.
 *
 * @param dependencies - Overrides for tests (object, all optional)
 * @param dependencies.createSmtpTransport - `async (nodemailerOptions) => transporter` (function)
 * @param dependencies.createImapClient - `async (imapflowOptions) => ImapFlow-like client` (function)
 * @param dependencies.fetchImpl - fetch used to download attachment URLs (function)
 * @param dependencies.resolveHostAddresses - `async (hostname) => string[]` used to vet attachment hosts; DNS when omitted (function)
 * @param dependencies.clock - `{now()}` for the send guard (object)
 * @returns `{createClient({accessToken, environment, fetchImpl})}` (object)
 */
export function createClientFactory(dependencies = {}) {
  const sendGuardsByFile = new Map();
  const createTransport = dependencies.createSmtpTransport ?? createNodemailerTransport;
  const createImapClient = dependencies.createImapClient ?? createImapFlowClient;
  const getSendGuard = (settings) => {
    const stateFilePath = join(settings.stateDirectory, `send-state-${slugifyAccount(settings.smtp.user, settings.smtp.host)}.json`);
    if (!sendGuardsByFile.has(stateFilePath)) {
      sendGuardsByFile.set(stateFilePath, createSendGuard({ stateFilePath, dailyLimit: settings.dailySendLimit, clock: dependencies.clock }));
    }
    return sendGuardsByFile.get(stateFilePath);
  };
  return {
    createClient({ accessToken, environment, fetchImpl }) {
      const settings = resolveSettings(environment);
      const password = accessToken;
      const redact = createRedactor([
        ...buildSecretVariants({ user: settings.smtp.user ?? "", password }),
        ...buildSecretVariants({ user: settings.imap.user ?? "", password }),
      ]);
      const smtpCall = (signal) => ({ createTransport, smtpSettings: requireSmtpSettings(settings), password, signal, redact });
      return {
        settings,
        redact,
        fetchImpl: dependencies.fetchImpl ?? fetchImpl ?? fetch,
        resolveHostAddresses: dependencies.resolveHostAddresses,
        getSendGuard: () => getSendGuard(settings),
        verifySmtp: (signal) => verifySmtpConnection(smtpCall(signal)),
        sendMessage: (message, signal) => sendSmtpMessage({ ...smtpCall(signal), message }),
        withImap: (work, { signal, isWrite = false } = {}) =>
          withImapConnection({ createImapClient, imapSettings: requireImapSettings(settings), password, signal, redact, isWrite }, work),
      };
    },
  };
}

function slugifyAccount(user, host) {
  return `${user ?? "unknown"}@${host ?? "unknown"}`.toLowerCase().replace(/[^a-z0-9@._-]/g, "_").slice(0, 200);
}
