/**
 * Keyboard and pointer operations. Each one brings the target app to the front
 * first, so it takes focus away from whatever the user is doing. The scripts
 * check that the app is still frontmost before every key step, text chunk and
 * click, and stop (`permission_denied`) as soon as focus moves to another app.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { parseKeySequence } from "../lib/key-combos.mjs";
import { APP_PROPERTY, MAX_KEYSTROKE_TEXT_LENGTH, normalizeLineEndings, requireTextWithinLimit } from "./common.mjs";

const SCREEN_COORDINATE = { type: "number", minimum: -100000, maximum: 100000 };
const TYPE_TEXT_METHODS = ["keystroke", "insert", "paste"];
const TYPE_TEXT_TIMEOUT_MS = 60000;

/**
 * Validates and normalises type_text's text for the chosen method.
 *
 * @param text - Text to type (string)
 * @param method - One of TYPE_TEXT_METHODS (string)
 * @returns Text with "\n" line endings (string)
 * @throws PluginError kind `invalid_input` - Too long overall, or too long to send key by key
 */
function prepareTypedText(text, method) {
  const normalizedText = normalizeLineEndings(requireTextWithinLimit("text", text));
  if (method === "keystroke" && normalizedText.length > MAX_KEYSTROKE_TEXT_LENGTH) {
    throw new PluginError(`\`text\` is longer than ${MAX_KEYSTROKE_TEXT_LENGTH} characters for method keystroke; use method insert or paste`, {
      kind: "invalid_input",
    });
  }
  return normalizedText;
}

async function typeText({ client, args, signal }) {
  const input = { app: client.requireApp(args.app), text: prepareTypedText(args.text, args.method), method: args.method };
  return { data: await client.runJxa("type_text", input, { signal, timeoutMs: TYPE_TEXT_TIMEOUT_MS }) };
}

export const inputOperations = [
  {
    name: "type_text",
    title: "Type text",
    description:
      "Bring an app to the front and type text into its focused element. method keystroke (default, at most 1000 characters) types key by key in chunks, and \"\\n\" presses Return; insert puts the text into the focused text field through Accessibility (no keys, no clipboard; \"\\n\" is a line break) and checks it arrived; paste uses the clipboard, checks the text arrived, then restores the clipboard. Typing stops if another app takes focus.",
    parameters: {
      type: "object",
      properties: {
        app: APP_PROPERTY,
        text: { type: "string", description: "Text to type" },
        method: { type: "string", enum: TYPE_TEXT_METHODS, default: "keystroke", description: "keystroke, insert (Accessibility) or paste (clipboard)" },
      },
      required: ["app", "text"],
    },
    run: typeText,
  },
  {
    name: "press_keys",
    title: "Press keys",
    description:
      "Bring an app to the front and press key combos, e.g. \"cmd+f\", \"enter\", \"cmd+shift+n\" or a space-separated sequence \"cmd+a delete\". Modifiers: cmd, shift, ctrl, opt. Keys: letters, digits, punctuation, enter, tab, space, delete, escape, arrows (up/down/left/right), home, end, pageup, pagedown, f1-f12. System-wide shortcuts (cmd+tab, cmd+space, ctrl+arrows, cmd+q, cmd+h, cmd+m, screenshots, lock screen, force quit) are refused.",
    parameters: {
      type: "object",
      properties: { app: APP_PROPERTY, keys: { type: "string", description: "Key combos separated by spaces, e.g. \"cmd+f\"" } },
      required: ["app", "keys"],
    },
    run: async ({ client, args, signal }) => {
      const steps = parseKeySequence(args.keys);
      const result = await client.runJxa("press_keys", { app: client.requireApp(args.app), steps }, { signal });
      return { data: { ...result, keys: steps.map((step) => step.label) } };
    },
  },
  {
    name: "click_at",
    title: "Click at point",
    description:
      "Bring an app to the front and click at screen coordinates (points, as in read_ui positions). The point must be inside one of that app's windows and not covered by another app's window.",
    parameters: {
      type: "object",
      properties: {
        app: APP_PROPERTY,
        x: SCREEN_COORDINATE,
        y: SCREEN_COORDINATE,
        button: { type: "string", enum: ["left", "right"], default: "left" },
        double: { type: "boolean", default: false, description: "Double-click" },
      },
      required: ["app", "x", "y"],
    },
    run: async ({ client, args, signal }) => ({
      data: await client.runJxa(
        "click_at",
        { app: client.requireApp(args.app), x: args.x, y: args.y, button: args.button, click_count: args.double ? 2 : 1 },
        { signal },
      ),
    }),
  },
];
