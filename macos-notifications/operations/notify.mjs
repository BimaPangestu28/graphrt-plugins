/**
 * notify: posts a local macOS notification with /usr/bin/osascript.
 */
import { buildOsascriptArguments, NOTIFICATION_SCRIPT_LINES } from "../lib/notification-script.mjs";
import { invalidInput, operationFailed, setupRequired } from "../lib/errors.mjs";

export const OSASCRIPT_PATH = "/usr/bin/osascript";
const RUN_TIMEOUT_MS = 15000;
const TEXT_LIMITS = { title: 120, subtitle: 120, message: 1000 };
const SYSTEM_SOUNDS = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"];

// C0 and C1 controls (NEL among them), the Unicode line and paragraph separators, and the bidi embedding,
// override, isolate and mark characters, which can make a notification read differently from its text.
const INVISIBLE_OR_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu;

/**
 * Replaces control, line-separator and bidi characters with spaces, collapses spaces and cuts a value to its limit.
 *
 * @param value - Text from the call (string, optional)
 * @param maxCharacters - Limit (number)
 * @returns Clean text (string)
 */
export function cleanNotificationText(value, maxCharacters) {
  const cleaned = String(value ?? "").replace(INVISIBLE_OR_CONTROL_PATTERN, " ").replace(/ {2,}/g, " ").trim();
  const characters = [...cleaned];
  return characters.length <= maxCharacters ? cleaned : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function buildNotification(args) {
  if (args.sound !== undefined && !SYSTEM_SOUNDS.includes(args.sound)) throw invalidInput(`\`sound\` must be one of ${SYSTEM_SOUNDS.join(", ")}`);
  const notification = {
    title: cleanNotificationText(args.notification_title, TEXT_LIMITS.title) || "graphrt",
    subtitle: cleanNotificationText(args.subtitle, TEXT_LIMITS.subtitle),
    message: cleanNotificationText(args.message, TEXT_LIMITS.message),
    sound: args.sound ?? "",
  };
  if (!notification.message) throw invalidInput("`message` must contain visible text");
  return notification;
}

export const notifyOperation = {
  name: "notify",
  title: "Post a notification",
  description: "Shows a local macOS notification (title, optional subtitle, message, optional system sound) on this Mac; agent calls are rate limited",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: `Notification text (control characters removed, at most ${TEXT_LIMITS.message} characters)` },
      notification_title: { type: "string", description: `Title (default "graphrt", at most ${TEXT_LIMITS.title} characters)` },
      subtitle: { type: "string", description: `Subtitle (at most ${TEXT_LIMITS.subtitle} characters)` },
      sound: { type: "string", enum: SYSTEM_SOUNDS, description: "macOS system sound to play" },
    },
    required: ["message"],
  },
  run: async ({ client, args, signal, source }) => {
    if (client.platform !== "darwin") throw setupRequired("macos-notifications only works on macOS (it runs /usr/bin/osascript)");
    const notification = buildNotification(args);
    if (source !== "node") client.rateLimiter.take(client.settings.toolRateLimit);
    const values = [notification.message, notification.title, notification.subtitle, notification.sound];
    const result = await client.runProcess({ command: OSASCRIPT_PATH, args: buildOsascriptArguments(NOTIFICATION_SCRIPT_LINES, values), timeoutMs: RUN_TIMEOUT_MS, signal, maxStdoutBytes: 4096, displayName: "osascript", setupHint: "osascript ships with macOS at /usr/bin/osascript." });
    if (result.exitCode !== 0) throw operationFailed(`osascript could not post the notification (exit ${result.exitCode ?? result.signalCode}): ${result.stderr || "no message"}`);
    return { data: { posted: true, title: notification.title, subtitle: notification.subtitle, message: notification.message, sound: notification.sound || null } };
  },
};
