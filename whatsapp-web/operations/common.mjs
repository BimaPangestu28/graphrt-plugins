/**
 * Parameter schemas and helpers shared by the whatsapp-web operations.
 */
import { invalidInput } from "../lib/errors.mjs";
import { normalizePhoneNumber } from "../lib/parse.mjs";

/** Tool calls get no cancel signal from the SDK; stop before the manifest's 300 s timeout. */
export const TOOL_DEADLINE_MS = 290000;

export const CHAT_TARGET_PROPERTIES = {
  phone: {
    type: "string",
    description: "Phone number with country code, e.g. \"+62 812 3456 789\". Works for numbers not in the chat list. Pass this or chat_name.",
  },
  chat_name: {
    type: "string",
    description: "Exact chat name as shown in WhatsApp (saved contact name or group name). Pass this or phone.",
  },
};

/**
 * Picks the chat to open from `phone` or `chat_name` (exactly one).
 *
 * @param args - Validated operation arguments (object)
 * @returns `{phone: digits}` or `{name}` (object)
 * @throws PluginError kind `invalid_input` - When neither or both are given
 */
export function resolveChatTarget(args) {
  const chatName = args.chat_name?.trim();
  if (args.phone && chatName) throw invalidInput("Pass either `phone` or `chat_name`, not both");
  if (args.phone) return { phone: normalizePhoneNumber(args.phone) };
  if (chatName) return { name: chatName };
  throw invalidInput("Pass `phone` (with country code) or `chat_name` (exact name as shown in WhatsApp)");
}

/**
 * Describes a chat target for logs and results.
 *
 * @param target - From resolveChatTarget (object)
 * @returns e.g. "+628123456789" or "chat \"Ibu\"" (string)
 */
export function describeChatTarget(target) {
  return target.phone ? `+${target.phone}` : `chat ${JSON.stringify(target.name)}`;
}

/**
 * Returns the node's cancel signal, or a deadline signal for tool calls (which have none).
 *
 * @param signal - Signal from the runner (AbortSignal | undefined)
 * @returns A signal that always fires eventually (AbortSignal)
 */
export function withDeadline(signal) {
  return signal ?? AbortSignal.timeout(TOOL_DEADLINE_MS);
}
