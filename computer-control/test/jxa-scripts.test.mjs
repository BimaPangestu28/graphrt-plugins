// Behaviour of the JXA scripts themselves, run in a vm sandbox with every side effect faked
// (see jxa-harness.mjs). Nothing here touches the real keyboard, mouse, clipboard or apps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadJxaSandbox, runExpectingScriptFailure } from "./jxa-harness.mjs";

const TARGET_PID = 42;
const OTHER_PID = 99;

function createFakeRunningApp({ name, bundleId = null, pid = TARGET_PID, activationPolicy = 0 }) {
  const objcText = (text) => (text === null ? { isNil: () => true } : { isNil: () => false, js: text });
  return { localizedName: objcText(name), bundleIdentifier: objcText(bundleId), processIdentifier: pid, activationPolicy };
}

/** Fakes for the app lookup and activation every input script starts with. */
function targetAppHelpers(events, { frontmostPids = [] } = {}) {
  const remainingFrontmostPids = [...frontmostPids];
  return {
    findRunningApp: () => createFakeRunningApp({ name: "WhatsApp" }),
    appElementFor: () => "app-element",
    activateApp: () => events.push("activate"),
    frontmostProcessIdentifier: () => {
      const pid = remainingFrontmostPids.length ? remainingFrontmostPids.shift() : TARGET_PID;
      events.push(`frontmost ${pid}`);
      return pid;
    },
  };
}

// ---------- item 1: input scripts stop when focus leaves the app ----------

test("press_keys checks the frontmost app before every step and aborts when focus leaves the app", () => {
  const events = [];
  const sandbox = loadJxaSandbox("press_keys", {
    ...targetAppHelpers(events, { frontmostPids: [TARGET_PID, TARGET_PID, OTHER_PID] }),
    pressKeyStep: (step) => events.push(`press ${step.label}`),
  });
  const steps = ["a", "b", "c"].map((character) => ({ label: character, character, modifiers: [] }));
  const failure = runExpectingScriptFailure(sandbox, { app: "WhatsApp", steps });
  assert.equal(failure.kind, "permission_denied");
  assert.match(failure.message, /focus left WhatsApp/);
  assert.deepEqual(events, ["activate", "frontmost 42", "press a", "frontmost 42", "press b", "frontmost 99"]);
});

test("press_keys with require_focus checks the focused element before pressing", () => {
  const events = [];
  const sandbox = loadJxaSandbox("press_keys", {
    ...targetAppHelpers(events),
    focusedElementOf: () => "focused-element",
    readElementRecord: () => ({ role: "AXTextField", position: [10, 10], size: [100, 20] }),
    pressKeyStep: (step) => events.push(`press ${step.label}`),
  });
  const failure = runExpectingScriptFailure(sandbox, {
    app: "WhatsApp",
    steps: [{ label: "enter", key_code: 36, modifiers: [] }],
    require_focus: { role: "AXTextArea", left: 300, bottom: 740 },
  });
  assert.equal(failure.kind, "action_failed");
  assert.match(failure.message, /focus moved/);
  assert.ok(!events.some((event) => event.startsWith("press")));
});

test("assertFrontmost is the one prelude helper every input script calls", async () => {
  const { loadJxaSource } = await import("../lib/jxa-runner.mjs");
  for (const scriptName of ["press_keys", "type_text", "click_at", "click_element"]) {
    const scriptOnly = loadJxaSource(scriptName).split("\n// ---------- end of prelude ----------\n")[1];
    assert.ok(scriptOnly, `${scriptName}: prelude end marker missing`);
    assert.match(scriptOnly, /assertFrontmost\(|assertPointBelongsTo\(/, scriptName);
  }
});

// ---------- items 3 and 6: type_text ----------

function typeTextSandbox(events, overrides = {}) {
  return loadJxaSandbox("type_text", {
    ...targetAppHelpers(events, overrides),
    keystrokeText: (text) => events.push(`keystroke ${text.length}`),
    pressKeyStep: (step) => events.push(`press ${step.modifiers.join("+")} ${step.character}`),
    waitUntil: (predicate) => predicate(),
    ...overrides.helpers,
  });
}

test("type_text keystroke mode types in 200-character chunks with a frontmost check before each", () => {
  const events = [];
  const sandbox = typeTextSandbox(events);
  const result = sandbox.main({ app: "WhatsApp", text: "x".repeat(450), method: "keystroke" });
  assert.equal(result.method, "keystroke");
  assert.deepEqual(events.filter((event) => event !== "activate"), ["frontmost 42", "keystroke 200", "frontmost 42", "keystroke 200", "frontmost 42", "keystroke 50"]);
});

test("type_text keystroke mode stops between chunks when focus leaves the app", () => {
  const events = [];
  const sandbox = typeTextSandbox(events, { frontmostPids: [TARGET_PID, OTHER_PID] });
  const failure = runExpectingScriptFailure(sandbox, { app: "WhatsApp", text: "y".repeat(450), method: "keystroke" });
  assert.equal(failure.kind, "permission_denied");
  assert.deepEqual(events.filter((event) => event.startsWith("keystroke")), ["keystroke 200"]);
});

test("type_text keystroke chunks never split a surrogate pair", () => {
  const sandbox = loadJxaSandbox("type_text");
  const chunks = sandbox.splitIntoChunks("a😀b😀", 2);
  assert.deepEqual(Array.from(chunks), ["a😀", "b😀"]);
});

function fakeTextField(initialValue, { settable = true } = {}) {
  const field = { value: initialValue, settable, sets: [] };
  return {
    field,
    helpers: {
      focusedElementOf: () => field,
      isAttributeSettable: (element, attributeName) => element.settable && attributeName === "AXSelectedText",
      setAttributeValue: (element, attributeName, value) => {
        element.sets.push([attributeName, value]);
        element.value += value;
        return 0;
      },
      readFullText: (element) => element.value,
    },
  };
}

test("type_text insert mode inserts through AXSelectedText and confirms the text arrived, without the clipboard", () => {
  const events = [];
  const { field, helpers } = fakeTextField("");
  const sandbox = typeTextSandbox(events, {
    helpers: { ...helpers, writeClipboardText: () => events.push("clipboard write"), snapshotPasteboard: () => events.push("clipboard read") },
  });
  const result = sandbox.main({ app: "WhatsApp", text: "Hi\nthere", method: "insert" });
  assert.equal(result.method, "insert");
  assert.deepEqual(field.sets, [["AXSelectedText", "Hi\nthere"]]);
  assert.ok(!events.some((event) => event.startsWith("clipboard") || event.startsWith("keystroke") || event.startsWith("press")));
});

test("type_text insert mode fails without typing when the focused element cannot take inserted text", () => {
  const { field, helpers } = fakeTextField("", { settable: false });
  const failure = runExpectingScriptFailure(typeTextSandbox([], { helpers }), { app: "WhatsApp", text: "hi", method: "insert" });
  assert.equal(failure.kind, "action_failed");
  assert.deepEqual(field.sets, []);
});

test("type_text insert mode fails when the text does not show up in the element", () => {
  const { helpers } = fakeTextField("");
  const failure = runExpectingScriptFailure(typeTextSandbox([], { helpers: { ...helpers, readFullText: () => "" } }), { app: "WhatsApp", text: "hi", method: "insert" });
  assert.equal(failure.kind, "action_failed");
  assert.match(failure.message, /did not appear/);
});

function pasteHelpers(events, field, { clipboardAccepts = true } = {}) {
  let clipboardText = "user secret";
  return {
    focusedElementOf: () => field,
    readFullText: () => {
      events.push("read back");
      return field.value;
    },
    snapshotPasteboard: () => {
      events.push("snapshot");
      return [[{ type: "public.html", data: "<b>user</b>" }, { type: "public.utf8-plain-text", data: "user secret" }]];
    },
    restorePasteboard: (snapshot) => events.push(`restore ${snapshot[0].length} types`),
    writeClipboardText: (text) => {
      if (clipboardAccepts) clipboardText = text;
      events.push("write clipboard");
    },
    readClipboardText: () => clipboardText,
    pressKeyStep: (step) => {
      events.push(`press cmd+${step.character}`);
      if (clipboardText !== "user secret") field.value += clipboardText;
    },
  };
}

test("type_text paste mode confirms the pasted text before restoring every pasteboard type", () => {
  const events = [];
  const field = { value: "" };
  const sandbox = typeTextSandbox(events, { helpers: pasteHelpers(events, field) });
  sandbox.main({ app: "WhatsApp", text: "héllo", method: "paste" });
  assert.equal(field.value, "héllo");
  const relevantEvents = events.filter((event) => !event.startsWith("frontmost") && event !== "activate");
  assert.deepEqual(relevantEvents, ["read back", "snapshot", "write clipboard", "press cmd+v", "read back", "restore 2 types"]);
  assert.ok(events.indexOf("frontmost 42") < events.indexOf("press cmd+v"));
});

test("type_text paste mode never presses Cmd+V when the clipboard did not take the text", () => {
  const events = [];
  const field = { value: "" };
  const failure = runExpectingScriptFailure(typeTextSandbox(events, { helpers: pasteHelpers(events, field, { clipboardAccepts: false }) }), {
    app: "WhatsApp",
    text: "hello",
    method: "paste",
  });
  assert.equal(failure.kind, "action_failed");
  assert.ok(!events.includes("press cmd+v"));
  assert.equal(events.at(-1), "restore 2 types");
});

test("type_text paste mode fails, after restoring the clipboard, when the paste cannot be confirmed", () => {
  const events = [];
  const field = { value: "" };
  const helpers = { ...pasteHelpers(events, field), readFullText: () => (events.push("read back"), "") };
  const failure = runExpectingScriptFailure(typeTextSandbox(events, { helpers }), { app: "WhatsApp", text: "hello", method: "paste" });
  assert.equal(failure.kind, "action_failed");
  assert.match(failure.message, /Could not confirm/);
  assert.equal(events.at(-1), "restore 2 types");
});

// ---------- item 4: refs carry a fingerprint ----------

test("element records get a ref with a fingerprint of role and title/description", () => {
  const sandbox = loadJxaSandbox("read_ui");
  const sendButton = sandbox.buildElementRecord("w1/3/2", 2, ["AXButton", null, "Send", null, null, null, true, false, [1, 2], [3, 4]]);
  assert.match(sendButton.ref, /^w1\/3\/2#[0-9a-z]{7}$/);
  const cancelButton = sandbox.buildElementRecord("w1/3/2", 2, ["AXButton", null, "Cancel", null, null, null, true, false, [1, 2], [3, 4]]);
  assert.notEqual(sendButton.ref, cancelButton.ref);
  const sameButtonFocused = sandbox.buildElementRecord("w1/3/2", 2, ["AXButton", null, "Send", null, null, null, true, true, [9, 9], [3, 4]]);
  assert.equal(sendButton.ref, sameButtonFocused.ref, "focus and position are not part of the fingerprint");
});

function refSandbox(scriptName, currentRecord, extraHelpers = {}) {
  return loadJxaSandbox(scriptName, {
    findRunningApp: () => createFakeRunningApp({ name: "Finder" }),
    appElementFor: () => "app-element",
    resolveRefPath: () => ({ element: "element", window: "window", windowIndex: 1 }),
    readElementRecord: () => currentRecord,
    ...extraHelpers,
  });
}

test("acting on a ref whose element changed fails with not_found (stale_ref) and does nothing", () => {
  const events = [];
  const expected = loadJxaSandbox("click_element").buildElementRecord("w1/3/2", 0, ["AXButton", null, "Send", null, null, null, true, false, null, null]);
  const sandbox = refSandbox("click_element", { role: "AXButton", title: "Delete chat" }, { performElementAction: () => (events.push("press"), 0) });
  const failure = runExpectingScriptFailure(sandbox, { app: "Finder", ref: expected.ref, fallback_click: true });
  assert.equal(failure.kind, "stale_ref");
  assert.match(failure.message, /read_ui again/);
  assert.deepEqual(events, []);
});

test("a ref whose fingerprint still matches is pressed", () => {
  const current = { role: "AXButton", title: "Send" };
  const sandbox = refSandbox("click_element", current, { performElementAction: () => 0 });
  const ref = `w1/3/2#${sandbox.elementFingerprint(current)}`;
  assert.equal(sandbox.main({ app: "Finder", ref, fallback_click: true }).method, "AXPress");
});

// ---------- item 5: clicks are hit-tested ----------

function clickAtSandbox(events, pidAtPoint) {
  return loadJxaSandbox("click_at", {
    ...targetAppHelpers(events),
    isInsideAnyWindow: () => true,
    processIdentifierAtPoint: () => pidAtPoint,
    postMouseClick: (x, y) => events.push(`click ${x},${y}`),
  });
}

test("click_at refuses a point covered by another app's window", () => {
  const events = [];
  const failure = runExpectingScriptFailure(clickAtSandbox(events, OTHER_PID), { app: "WhatsApp", x: 10, y: 20, button: "left", click_count: 1 });
  assert.equal(failure.kind, "permission_denied");
  assert.match(failure.message, /another app/);
  assert.ok(!events.some((event) => event.startsWith("click")));
});

test("click_at clicks when the hit-test returns the target app", () => {
  const events = [];
  clickAtSandbox(events, TARGET_PID).main({ app: "WhatsApp", x: 10, y: 20, button: "left", click_count: 1 });
  assert.ok(events.includes("click 10,20"));
});

function clickElementFallbackSandbox(events, { pidAtPoint = TARGET_PID, windowFrame }) {
  const record = { role: "AXStaticText", value: "Mom", position: [100, 100], size: [40, 20] };
  return loadJxaSandbox("click_element", {
    ...targetAppHelpers(events),
    resolveRefPath: () => ({ element: "element", window: "window", windowIndex: 1 }),
    readElementRecord: () => record,
    readWindowFrame: () => windowFrame,
    performElementAction: () => -25205,
    processIdentifierAtPoint: () => pidAtPoint,
    postMouseClick: (x, y) => events.push(`click ${x},${y}`),
  });
}

test("click_element's centre-click fallback is bounds-checked against the element's window", () => {
  const events = [];
  const sandbox = clickElementFallbackSandbox(events, { windowFrame: { position: [500, 500], size: [300, 300] } });
  const failure = runExpectingScriptFailure(sandbox, { app: "WhatsApp", ref: "w1/2", fallback_click: true });
  assert.equal(failure.kind, "invalid_input");
  assert.ok(!events.some((event) => event.startsWith("click")));
});

test("click_element's centre-click fallback is hit-tested", () => {
  const events = [];
  const blocked = clickElementFallbackSandbox(events, { pidAtPoint: OTHER_PID, windowFrame: { position: [0, 0], size: [800, 600] } });
  assert.equal(runExpectingScriptFailure(blocked, { app: "WhatsApp", ref: "w1/2", fallback_click: true }).kind, "permission_denied");
  assert.ok(!events.some((event) => event.startsWith("click")));
  const allowed = clickElementFallbackSandbox(events, { windowFrame: { position: [0, 0], size: [800, 600] } });
  assert.equal(allowed.main({ app: "WhatsApp", ref: "w1/2", fallback_click: true }).method, "click");
  assert.ok(events.includes("click 120,110"));
});

// ---------- item 9: app lookup ----------

function appLookupSandbox(runningApps) {
  return loadJxaSandbox("focus_app", { listRunningApps: () => runningApps });
}

test("findRunningApp fails invalid_input when two regular apps share the name", () => {
  const sandbox = appLookupSandbox([
    createFakeRunningApp({ name: "WhatsApp", bundleId: "net.whatsapp.WhatsApp", pid: 1 }),
    createFakeRunningApp({ name: "WhatsApp", bundleId: "com.example.impostor", pid: 2 }),
  ]);
  assert.throws(() => sandbox.findRunningApp("WhatsApp"), (error) => error.kind === "invalid_input" && /net\.whatsapp\.WhatsApp/.test(error.message));
  assert.equal(sandbox.findRunningApp("net.whatsapp.whatsapp").processIdentifier, 1);
});

test("findRunningApp only considers regular (Dock) apps", () => {
  const sandbox = appLookupSandbox([
    createFakeRunningApp({ name: "WhatsApp", pid: 1, activationPolicy: 2 }),
    createFakeRunningApp({ name: "WhatsApp", pid: 2 }),
  ]);
  assert.equal(sandbox.findRunningApp("whatsapp").processIdentifier, 2);
});

test("findRunningApp compares NFC-normalised names with ASCII-only case folding", () => {
  const sandbox = appLookupSandbox([createFakeRunningApp({ name: "\u212Aeynote", pid: 1 }), createFakeRunningApp({ name: "Caf\u00e9", pid: 2 })]);
  assert.throws(() => sandbox.findRunningApp("Keynote"), (error) => error.kind === "not_found");
  assert.equal(sandbox.findRunningApp("CAFe\u0301").processIdentifier, 2);
});

// ---------- item 8: window screenshots by window id ----------

test("find_window_id picks the on-screen, normal-layer window of the app pid whose bounds match the frame", () => {
  const frame = { position: [10, 20], size: [300, 200] };
  const sandbox = loadJxaSandbox("find_window_id", {
    listOnScreenWindows: () => [
      { kCGWindowOwnerPID: OTHER_PID, kCGWindowLayer: 0, kCGWindowNumber: 1, kCGWindowBounds: { X: 10, Y: 20, Width: 300, Height: 200 } },
      { kCGWindowOwnerPID: TARGET_PID, kCGWindowLayer: 25, kCGWindowNumber: 2, kCGWindowBounds: { X: 10, Y: 20, Width: 300, Height: 200 } },
      { kCGWindowOwnerPID: TARGET_PID, kCGWindowLayer: 0, kCGWindowNumber: 3, kCGWindowBounds: { X: 400, Y: 20, Width: 300, Height: 200 } },
      { kCGWindowOwnerPID: TARGET_PID, kCGWindowLayer: 0, kCGWindowNumber: 4, kCGWindowBounds: { X: 10, Y: 21, Width: 300, Height: 200 } },
    ],
  });
  assert.equal(sandbox.findWindowNumber(TARGET_PID, frame), 4);
  assert.equal(sandbox.findWindowNumber(7, frame), null);
});
