/**
 * email plugin definition: send mail over SMTP (nodemailer) and read
 * mailboxes over IMAP (imapflow) with an app password.
 *
 * The runner's "token" is the password: EMAIL_PASSWORD, or a node's
 * `access_token` (from a secret). Every operation's errors pass through a
 * redactor built from that password before they leave the plugin.
 */
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { createClientFactory } from "./lib/client.mjs";
import { redactError } from "./lib/errors.mjs";
import { connectionOperations } from "./operations/connection.mjs";
import { organizingOperations } from "./operations/organizing.mjs";
import { readingOperations } from "./operations/reading.mjs";
import { sendingOperations } from "./operations/sending.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - See createClientFactory: `{createSmtpTransport, createImapClient, fetchImpl, resolveHostAddresses, clock}` (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  const { createClient } = createClientFactory(dependencies);
  const operations = [...connectionOperations, ...sendingOperations, ...readingOperations, ...organizingOperations];
  return {
    name: "email",
    version: "0.1.0",
    description: "Send email over SMTP and read, flag and move messages over IMAP (Gmail, Outlook or any provider) with an app password",
    tokenEnv: "EMAIL_PASSWORD",
    extraEnv: [
      "EMAIL_SMTP_HOST",
      "EMAIL_SMTP_PORT",
      "EMAIL_SMTP_SECURE",
      "EMAIL_SMTP_USER",
      "EMAIL_IMAP_HOST",
      "EMAIL_IMAP_PORT",
      "EMAIL_IMAP_SECURE",
      "EMAIL_IMAP_USER",
      "EMAIL_FROM",
      "EMAIL_DAILY_SEND_LIMIT",
      "EMAIL_ALLOWED_FILE_DIRS",
      "EMAIL_TOOL_ALLOWED_RECIPIENTS",
      "EMAIL_STATE_DIR",
    ],
    limits: { timeout_ms: 120000, max_concurrency: 4 },
    resolveAccessToken: resolvePassword,
    createClient,
    operations: operations.map(withRedactedErrors),
  };
}

function resolvePassword({ environment, nodeToken }) {
  const password = nodeToken || environment?.EMAIL_PASSWORD;
  if (!password) {
    throw new PluginError("No email password: set EMAIL_PASSWORD (an app password; allow it in permissions.env) or pass `access_token` on the node", {
      kind: "auth_error",
    });
  }
  return password;
}

// Library messages can quote server responses or the AUTH exchange, so nothing leaves unredacted.
function withRedactedErrors(operation) {
  return {
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        throw redactError(operationError, context.client.redact);
      }
    },
  };
}

export const pluginDefinition = createPluginDefinition();
