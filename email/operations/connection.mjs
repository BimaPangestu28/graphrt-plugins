/**
 * verify_connection: logs in to SMTP and/or IMAP and logs out again,
 * without sending or changing anything.
 */
import { setupRequired } from "../lib/errors.mjs";

export const connectionOperations = [
  {
    name: "verify_connection",
    title: "Verify email connection",
    description: "Check that the SMTP and/or IMAP settings and password work: connects, logs in and disconnects. Sends nothing and changes nothing.",
    parameters: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          enum: ["smtp", "imap", "both"],
          default: "both",
          description: "Which server to check; \"both\" checks every server that is configured",
        },
      },
    },
    run: async ({ client, args, signal }) => {
      const checkSmtp = args.protocol === "smtp" || (args.protocol === "both" && Boolean(client.settings.smtp.host));
      const checkImap = args.protocol === "imap" || (args.protocol === "both" && Boolean(client.settings.imap.host));
      if (!checkSmtp && !checkImap) throw setupRequired("Neither EMAIL_SMTP_HOST nor EMAIL_IMAP_HOST is set");
      const smtpResult = checkSmtp ? await client.verifySmtp(signal) : { skipped: "EMAIL_SMTP_HOST is not set" };
      const imapResult = checkImap ? await verifyImap(client, signal) : { skipped: "EMAIL_IMAP_HOST is not set" };
      return { data: { ok: true, smtp: smtpResult, imap: imapResult } };
    },
  },
];

async function verifyImap(client, signal) {
  const { host, port, secure, user } = client.settings.imap;
  await client.withImap(async () => {}, { signal });
  return { ok: true, host, port, secure, user };
}
