/**
 * Parses key combos such as `cmd+shift+k`, `enter` or `cmd+a delete` into
 * validated steps for System Events. Letters, digits and punctuation are sent as
 * characters (so they follow the keyboard layout); named keys use macOS virtual
 * key codes (Carbon `kVK_*` values, Events.h).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const MODIFIERS = new Map([
  ["cmd", "command down"],
  ["command", "command down"],
  ["shift", "shift down"],
  ["ctrl", "control down"],
  ["control", "control down"],
  ["opt", "option down"],
  ["option", "option down"],
  ["alt", "option down"],
]);

const NAMED_KEY_CODES = new Map([
  ["enter", 36], ["return", 36], ["tab", 48], ["space", 49],
  ["delete", 51], ["backspace", 51], ["forward_delete", 117],
  ["escape", 53], ["esc", 53],
  ["left", 123], ["right", 124], ["down", 125], ["up", 126],
  ["home", 115], ["end", 119], ["pageup", 116], ["pagedown", 121],
  ["f1", 122], ["f2", 120], ["f3", 99], ["f4", 118], ["f5", 96], ["f6", 97],
  ["f7", 98], ["f8", 100], ["f9", 101], ["f10", 109], ["f11", 103], ["f12", 111],
]);

const CHARACTER_KEY_NAMES = new Map([
  ["minus", "-"], ["equal", "="], ["comma", ","], ["period", "."], ["slash", "/"],
  ["backslash", "\\"], ["semicolon", ";"], ["quote", "'"], ["grave", "`"],
  ["leftbracket", "["], ["rightbracket", "]"],
]);

const SINGLE_CHARACTER_KEY = /^[a-z0-9\-=,./\\;'`[\]]$/;
const MAX_STEPS = 20;

const TAB_KEY = { key_code: 48 };
const SPACE_KEY = { key_code: 49 };
const ESCAPE_KEY = { key_code: 53 };
const ARROW_KEYS = [123, 124, 125, 126].map((keyCode) => ({ key_code: keyCode }));
const characterKeys = (characters) => [...characters].map((character) => ({ character }));

// Shortcuts that act outside the target app: they would let input escape the allowlist (switch app,
// Spotlight, Spaces), lock the screen, take screenshots, or hide/quit/minimise. A combo is refused when
// it holds at least these modifiers with this key, so cmd+opt+h is caught by the cmd+h rule.
const SYSTEM_WIDE_COMBOS = [
  { modifiers: ["command down"], keys: [TAB_KEY, ...characterKeys("`")], effect: "switches apps or windows" },
  { modifiers: ["command down"], keys: [SPACE_KEY], effect: "opens Spotlight" },
  { modifiers: ["control down"], keys: [SPACE_KEY], effect: "switches the input source" },
  { modifiers: ["control down"], keys: ARROW_KEYS, effect: "switches Spaces or opens Mission Control" },
  { modifiers: ["command down", "option down"], keys: [ESCAPE_KEY], effect: "opens Force Quit" },
  { modifiers: ["control down", "command down"], keys: characterKeys("q"), effect: "locks the screen" },
  { modifiers: ["command down", "shift down"], keys: characterKeys("345"), effect: "takes a screenshot" },
  { modifiers: ["command down"], keys: characterKeys("h"), effect: "hides apps" },
  { modifiers: ["command down"], keys: characterKeys("q"), effect: "quits the app (use the quit_app node instead)" },
  { modifiers: ["command down"], keys: characterKeys("m"), effect: "minimises the window" },
];

/**
 * Parses a whitespace-separated sequence of key combos.
 *
 * @param keysText - e.g. "cmd+f", "cmd+shift+n", "cmd+a delete" (string)
 * @returns Steps `{label, modifiers, character?|key_code?}` (Array<object>)
 * @throws PluginError kind `invalid_input` - empty input, unknown key/modifier, or too many steps;
 *   `permission_denied` - a system-wide shortcut such as cmd+tab, cmd+space or cmd+q
 *
 * @example
 * parseKeySequence("cmd+shift+k");
 * // [{ label: "cmd+shift+k", modifiers: ["command down", "shift down"], character: "k" }]
 */
export function parseKeySequence(keysText) {
  const comboTexts = String(keysText ?? "").trim().split(/\s+/).filter(Boolean);
  if (comboTexts.length === 0) throw invalidKeys("`keys` is empty; pass e.g. \"cmd+f\" or \"enter\"");
  if (comboTexts.length > MAX_STEPS) throw invalidKeys(`\`keys\` has ${comboTexts.length} combos; at most ${MAX_STEPS} per call`);
  return comboTexts.map(parseKeyCombo);
}

/**
 * Parses one combo like `cmd+shift+k`.
 *
 * @param comboText - One combo (string)
 * @returns Step `{label, modifiers, character?|key_code?}` (object)
 * @throws PluginError kind `invalid_input` - Malformed combo; `permission_denied` - System-wide shortcut (see SYSTEM_WIDE_COMBOS)
 */
export function parseKeyCombo(comboText) {
  const parts = comboText.toLowerCase().split("+");
  const keyName = parts.pop();
  if (!keyName) throw invalidKeys(`"${comboText}" has no key after the last "+"`);
  const modifiers = parts.map((modifierName) => {
    if (!MODIFIERS.has(modifierName)) throw invalidKeys(`Unknown modifier "${modifierName}" in "${comboText}"; use cmd, shift, ctrl or opt`);
    return MODIFIERS.get(modifierName);
  });
  const step = { label: comboText.toLowerCase(), modifiers: [...new Set(modifiers)], ...resolveKey(keyName, comboText) };
  rejectSystemWideCombo(step);
  return step;
}

function rejectSystemWideCombo(step) {
  const matchingCombo = SYSTEM_WIDE_COMBOS.find(
    (combo) => combo.modifiers.every((modifier) => step.modifiers.includes(modifier)) && combo.keys.some((key) => isSameKey(key, step)),
  );
  if (!matchingCombo) return;
  throw new PluginError(`"${step.label}" is a system-wide shortcut that ${matchingCombo.effect}; press_keys only sends keys meant for the target app`, {
    kind: "permission_denied",
  });
}

function isSameKey(key, step) {
  return key.key_code !== undefined ? key.key_code === step.key_code : key.character === step.character;
}

function resolveKey(keyName, comboText) {
  if (NAMED_KEY_CODES.has(keyName)) return { key_code: NAMED_KEY_CODES.get(keyName) };
  if (CHARACTER_KEY_NAMES.has(keyName)) return { character: CHARACTER_KEY_NAMES.get(keyName) };
  if (SINGLE_CHARACTER_KEY.test(keyName)) return { character: keyName };
  throw invalidKeys(`Unknown key "${keyName}" in "${comboText}". Use a letter, digit, punctuation or one of: ${listNamedKeys()}`);
}

function listNamedKeys() {
  return [...NAMED_KEY_CODES.keys(), ...CHARACTER_KEY_NAMES.keys()].join(", ");
}

function invalidKeys(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
