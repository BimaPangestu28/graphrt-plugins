import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeyCombo, parseKeySequence } from "../lib/key-combos.mjs";
import { isAppAllowed, parseAllowedApps, requireAllowedApp } from "../lib/allowlist.mjs";
import { buildOutlineOutput, formatElementLine, normalizeRole, renderElementOutline, stripRefFingerprint, validateElementRef } from "../lib/ui-tree.mjs";

const KEY_CASES = [
  ["cmd+f", { modifiers: ["command down"], character: "f" }],
  ["CMD+Shift+K", { modifiers: ["command down", "shift down"], character: "k" }],
  ["cmd+shift+n", { modifiers: ["command down", "shift down"], character: "n" }],
  ["ctrl+a", { modifiers: ["control down"], character: "a" }],
  ["cmd+left", { modifiers: ["command down"], key_code: 123 }],
  ["enter", { modifiers: [], key_code: 36 }],
  ["return", { modifiers: [], key_code: 36 }],
  ["shift+enter", { modifiers: ["shift down"], key_code: 36 }],
  ["ctrl+opt+delete", { modifiers: ["control down", "option down"], key_code: 51 }],
  ["alt+left", { modifiers: ["option down"], key_code: 123 }],
  ["esc", { modifiers: [], key_code: 53 }],
  ["f12", { modifiers: [], key_code: 111 }],
  ["cmd+comma", { modifiers: ["command down"], character: "," }],
  ["cmd+,", { modifiers: ["command down"], character: "," }],
  ["cmd+cmd+a", { modifiers: ["command down"], character: "a" }],
];

for (const [comboText, expected] of KEY_CASES) {
  test(`parseKeyCombo("${comboText}")`, () => {
    const { label, ...step } = parseKeyCombo(comboText);
    assert.equal(label, comboText.toLowerCase());
    assert.deepEqual(step, expected);
  });
}

test("parseKeySequence splits on whitespace", () => {
  assert.deepEqual(parseKeySequence("cmd+a  delete").map((step) => step.label), ["cmd+a", "delete"]);
});

const INVALID_KEY_CASES = [["", /empty/], ["cmd+", /no key/], ["hyper+a", /Unknown modifier/], ["cmd+launchpad", /Unknown key/], ["ab", /Unknown key/], [Array(21).fill("a").join(" "), /at most 20/]];
for (const [keysText, expectedMessage] of INVALID_KEY_CASES) {
  test(`parseKeySequence rejects ${JSON.stringify(keysText).slice(0, 30)}`, () => {
    assert.throws(() => parseKeySequence(keysText), (error) => error.kind === "invalid_input" && expectedMessage.test(error.message));
  });
}

// System-wide shortcuts act outside the target app (switch apps, lock, screenshot, hide, quit), so they are refused.
const SYSTEM_COMBOS = [
  "cmd+tab", "cmd+shift+tab", "cmd+`", "cmd+grave", "cmd+space", "ctrl+space", "ctrl+opt+space",
  "ctrl+left", "ctrl+right", "ctrl+up", "ctrl+down", "ctrl+shift+left", "cmd+opt+esc", "cmd+alt+escape", "ctrl+cmd+q",
  "cmd+shift+3", "cmd+shift+4", "cmd+shift+5", "cmd+ctrl+shift+4", "cmd+h", "cmd+opt+h", "cmd+q", "cmd+opt+q", "cmd+m",
];
for (const comboText of SYSTEM_COMBOS) {
  test(`parseKeySequence refuses the system-wide combo ${comboText}`, () => {
    assert.throws(() => parseKeySequence(`a ${comboText}`), (error) => error.kind === "permission_denied" && /system-wide/.test(error.message));
  });
}

test("cmd+q is refused with a pointer to quit_app", () => {
  assert.throws(() => parseKeySequence("cmd+q"), (error) => /quit_app/.test(error.message));
});

test("allowlist is case-insensitive and trims entries", () => {
  const allowedApps = parseAllowedApps(" Finder ,whatsapp,, ");
  assert.equal(isAppAllowed("finder", allowedApps), true);
  assert.equal(isAppAllowed("WhatsApp", allowedApps), true);
  assert.equal(isAppAllowed("Terminal", allowedApps), false);
  assert.equal(requireAllowedApp("  FINDER ", allowedApps), "FINDER");
});

test("allowlist accepts bundle ids", () => {
  const allowedApps = parseAllowedApps("net.whatsapp.WhatsApp");
  assert.equal(isAppAllowed("NET.WHATSAPP.whatsapp", allowedApps), true);
  assert.equal(isAppAllowed("WhatsApp", allowedApps), false);
  assert.equal(requireAllowedApp("net.whatsapp.WhatsApp", allowedApps), "net.whatsapp.WhatsApp");
});

test("allowlist matching is NFC-normalised with ASCII-only case folding (no Kelvin-sign folding)", () => {
  assert.equal(isAppAllowed("\u212Aeynote", parseAllowedApps("Keynote")), false);
  assert.throws(() => parseAllowedApps("Finder,\u212Aeynote"), (error) => error.kind === "permission_denied" && /look-alike/.test(error.message));
  assert.equal(isAppAllowed("Cafe\u0301", parseAllowedApps("CAF\u00e9")), true);
});

test("allowlist * allows all; empty or unset is permission_denied", () => {
  assert.equal(isAppAllowed("Anything", parseAllowedApps("Finder,*")), true);
  for (const rawValue of [undefined, "", " , "]) {
    assert.throws(() => parseAllowedApps(rawValue), (error) => error.kind === "permission_denied");
  }
});

test("element refs are validated", () => {
  for (const validRef of ["w1", "w1/3/2", " w12/1 ", "w1/3/2#0a1b2c3"]) assert.equal(validateElementRef(validRef), validRef.trim());
  for (const invalidRef of ["", "1/2", "w0", "w1/0", "w1/", "w1//2", "w1/a", "w1/2/../3", "w1/2#", "w1/2#ABCDEFG", "w1/2#abc"]) {
    assert.throws(() => validateElementRef(invalidRef), (error) => error.kind === "invalid_input");
  }
});

test("acting on an element requires the fingerprinted ref from read_ui or find_elements", () => {
  assert.equal(validateElementRef("w1/3#0a1b2c3", { requireFingerprint: true }), "w1/3#0a1b2c3");
  assert.throws(() => validateElementRef("w1/3", { requireFingerprint: true }), (error) => error.kind === "invalid_input" && /exactly as read_ui/.test(error.message));
  assert.equal(stripRefFingerprint("w1/3/2#0a1b2c3"), "w1/3/2");
  assert.equal(stripRefFingerprint("w1/3"), "w1/3");
});

test("roles are normalised to the AX form", () => {
  assert.equal(normalizeRole("button"), "AXButton");
  assert.equal(normalizeRole("AXTextField"), "AXTextField");
  assert.equal(normalizeRole("axTextArea"), "AXTextArea");
  assert.equal(normalizeRole("staticText"), "AXStaticText");
  assert.equal(normalizeRole(undefined), undefined);
});

test("formatElementLine shows only the useful fields, quoted and shortened", () => {
  const element = {
    ref: "w1/2/1",
    role: "AXTextField",
    subrole: "AXSearchField",
    title: null,
    value: "line one\nline two",
    description: "Search",
    placeholder: "Search chats",
    enabled: true,
    focused: true,
    position: [10, 20],
    size: [200, 30],
  };
  assert.equal(formatElementLine(element), 'w1/2/1 TextField(SearchField) value="line one line two" desc="Search" placeholder="Search chats" [focused] @10,20 200x30');
  assert.match(formatElementLine({ ref: "w1", role: "AXStaticText", value: "x".repeat(120) }), /value="x{80}…"$/);
  assert.equal(formatElementLine({ ref: "w1", role: "AXButton", title: "OK", description: "OK" }), 'w1 Button "OK"');
});

test("renderElementOutline indents relative to the shallowest element and notes depth limits", () => {
  const text = renderElementOutline("App w1/2", {
    elements: [
      { ref: "w1/2", depth: 3, role: "AXGroup" },
      { ref: "w1/2/1", depth: 4, role: "AXButton", title: "Go" },
    ],
    truncated: false,
    depth_limited: true,
  });
  assert.equal(text, 'App w1/2 — 2 element(s)\nw1/2 Group\n  w1/2/1 Button "Go"\n… some branches are deeper than max_depth: pass a deeper ref as root_ref to read them');
});

test("buildOutlineOutput caps elements plus text to a character budget and says so", () => {
  const elements = Array.from({ length: 100 }, (_, index) => ({ ref: `w1/${index + 1}#0a1b2c3`, depth: 1, role: "AXStaticText", value: "v".repeat(60) }));
  const output = buildOutlineOutput("App w1", { elements, truncated: false, depth_limited: false }, { maxCharacters: 3000 });
  assert.ok(output.elements.length > 0 && output.elements.length < 100);
  assert.equal(output.output_truncated, true);
  assert.match(output.text, /output cut at 3000 characters/);
  assert.ok(output.text.length + JSON.stringify(output.elements).length <= 3300);
  const small = buildOutlineOutput("App w1", { elements: elements.slice(0, 2), truncated: false, depth_limited: false });
  assert.equal(small.output_truncated, false);
  assert.equal(small.elements.length, 2);
});

test("script failures action_failed and screen_locked map to their own error kinds", async () => {
  const { mapScriptFailure } = await import("../lib/osascript-errors.mjs");
  assert.equal(mapScriptFailure({ kind: "action_failed", message: "Could not bring X to the front" }).kind, "action_failed");
  const locked = mapScriptFailure({ kind: "screen_locked", message: "The screen is locked" });
  assert.equal(locked.kind, "screen_locked");
  assert.equal(locked.retryable, false);
  assert.match(locked.message, /unlock/i);
});
