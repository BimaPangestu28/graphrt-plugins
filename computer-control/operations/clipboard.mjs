/**
 * Clipboard operations (plain text only). The clipboard is shared by every app,
 * so reading it is outside the app allowlist: get_clipboard needs the explicit
 * COMPUTER_CONTROL_ALLOW_CLIPBOARD_READ=1 opt-in.
 */
import { ALLOW_CLIPBOARD_READ_ENV } from "../lib/client.mjs";
import { requireTextWithinLimit } from "./common.mjs";

export const clipboardOperations = [
  {
    name: "get_clipboard",
    title: "Get clipboard",
    description: "Read the clipboard as plain text (null when it holds no text). Needs COMPUTER_CONTROL_ALLOW_CLIPBOARD_READ=1, because the clipboard may hold anything copied in any app.",
    parameters: { type: "object", properties: {} },
    run: async ({ client, signal }) => {
      client.requireOptIn(ALLOW_CLIPBOARD_READ_ENV, "Reading the clipboard");
      return { data: await client.runJxa("get_clipboard", {}, { signal }) };
    },
  },
  {
    name: "set_clipboard",
    title: "Set clipboard",
    description: "Replace the clipboard with plain text.",
    parameters: { type: "object", properties: { text: { type: "string", description: "Text to put on the clipboard" } }, required: ["text"] },
    run: async ({ client, args, signal }) => ({
      data: await client.runJxa("set_clipboard", { text: requireTextWithinLimit("text", args.text) }, { signal }),
    }),
  },
];
