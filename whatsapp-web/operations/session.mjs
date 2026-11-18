/**
 * Session operations: QR login (node only, visible window) and login status.
 */
import { withDeadline } from "./common.mjs";

const STATUS_HINTS = {
  logged_in: "Ready.",
  needs_login: "WhatsApp Web shows the QR code: run the whatsapp-web.login node once and scan it with your phone.",
  loading: "WhatsApp Web did not finish loading within 60 s; try again.",
};

export const sessionOperations = [
  {
    name: "login",
    title: "Log in to WhatsApp Web",
    description:
      "Open a visible browser window with the WhatsApp Web QR code and wait until it is scanned (WhatsApp > Linked devices > Link a device). Later runs reuse the saved session headlessly.",
    nodeOnly: true,
    parameters: {
      type: "object",
      properties: {
        timeout_seconds: { type: "integer", minimum: 30, maximum: 280, default: 180, description: "How long to wait for the scan" },
      },
    },
    run: async ({ client, args, signal }) => ({
      data: await client.driver.login({ timeoutMs: args.timeout_seconds * 1000, signal: withDeadline(signal) }),
    }),
  },
  {
    name: "get_status",
    title: "WhatsApp Web status",
    description: "Report whether WhatsApp Web is logged_in, needs_login (QR code shown) or loading, plus today's send count.",
    parameters: { type: "object", properties: {} },
    run: async ({ client, signal }) => {
      const loginStatus = await client.driver.getStatus({ signal: withDeadline(signal) });
      const usage = await client.sendGuard.getUsage();
      return {
        data: {
          status: loginStatus,
          hint: STATUS_HINTS[loginStatus],
          profile_directory: client.settings.profileDirectory,
          sends_today: usage.sends_today,
          daily_limit: usage.daily_limit,
        },
      };
    },
  },
];
