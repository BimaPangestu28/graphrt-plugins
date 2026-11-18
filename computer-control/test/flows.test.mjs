import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JXA_SCRIPT_NAMES, loadJxaSource } from "../lib/jxa-runner.mjs";
import { runExpectingError, runWithFakes, TEST_ENVIRONMENT } from "./helpers.mjs";

function withScreenshotDirectory(testBody, extraEnvironment = {}) {
  return async () => {
    const screenshotDirectory = mkdtempSync(join(tmpdir(), "computer-control-test-"));
    try {
      await testBody({ ...TEST_ENVIRONMENT, COMPUTER_CONTROL_SCREENSHOT_DIR: screenshotDirectory, ...extraEnvironment }, screenshotDirectory);
    } finally {
      rmSync(screenshotDirectory, { recursive: true, force: true });
    }
  };
}

const FULL_SCREENSHOT_ALLOWED = { COMPUTER_CONTROL_ALLOW_FULL_SCREENSHOT: "1" };

const writePngAtLastArgument = (file, args) => {
  writeFileSync(args.at(-1), "png-bytes");
  return { exitCode: 0, stdout: "", stderr: "" };
};

test("take_screenshot of the whole screen needs COMPUTER_CONTROL_ALLOW_FULL_SCREENSHOT=1", withScreenshotDirectory(async (environment) => {
  const { error, dependencies } = await runExpectingError("take_screenshot", {}, { commandResult: writePngAtLastArgument }, { environment });
  assert.equal(error.kind, "permission_denied");
  assert.match(error.message, /COMPUTER_CONTROL_ALLOW_FULL_SCREENSHOT=1/);
  assert.equal(dependencies.commandCalls.length + dependencies.jxaCalls.length, 0);
}));

test("take_screenshot captures the whole screen silently into the screenshot directory when allowed", withScreenshotDirectory(async (environment, screenshotDirectory) => {
  const { output, dependencies } = await runWithFakes("take_screenshot", {}, { commandResult: writePngAtLastArgument }, { environment });
  const [call] = dependencies.commandCalls;
  assert.equal(call.file, "/usr/sbin/screencapture");
  const expectedPath = join(screenshotDirectory, "screenshot-2026-11-18T10-00-00-000Z.png");
  assert.deepEqual(call.args, ["-x", "-t", "png", expectedPath]);
  assert.deepEqual(output.data, { path: expectedPath, bytes: 9, app: null, window_id: null });
  assert.equal(dependencies.jxaCalls.length, 0);
}, FULL_SCREENSHOT_ALLOWED));

test("take_screenshot of an app window captures that window by its window id, not a screen rectangle", withScreenshotDirectory(async (environment) => {
  const windowTarget = { window_id: 4242, x: 10, y: 20, width: 300, height: 200 };
  const { output, dependencies } = await runWithFakes("take_screenshot", { app: "Finder", window: 2 }, { jxaResults: { find_window_id: windowTarget }, commandResult: writePngAtLastArgument }, { environment });
  assert.equal(dependencies.jxaCalls[0].scriptName, "find_window_id");
  assert.deepEqual(dependencies.jxaCalls[0].input, { app: "Finder", window: 2 });
  assert.deepEqual(dependencies.commandCalls[0].args.slice(0, 6), ["-x", "-t", "png", "-o", "-l", "4242"]);
  assert.ok(!dependencies.commandCalls[0].args.includes("-R"));
  assert.equal(output.data.window_id, 4242);
}));

test("take_screenshot maps a missing image or a capture error to permission_denied (Screen Recording)", withScreenshotDirectory(async (environment) => {
  const noFile = await runExpectingError("take_screenshot", {}, {}, { environment });
  assert.equal(noFile.error.kind, "permission_denied");
  assert.match(noFile.error.message, /Screen & System Audio Recording/);
  const failed = await runExpectingError("take_screenshot", {}, { commandResult: () => ({ exitCode: 1, stdout: "", stderr: "could not create image from display" }) }, { environment });
  assert.equal(failed.error.kind, "permission_denied");
}, FULL_SCREENSHOT_ALLOWED));

// ---------- whatsapp_desktop_send ----------
// A fake WhatsApp window: chat list on the left under the search field, conversation on the right.

const WINDOW = { ref: "w1", position: [0, 0], size: [1200, 800] };
const SEARCH_FIELD = { role: "AXTextField", subrole: "AXSearchField", position: [20, 60], size: [300, 30] };
const CHAT_LIST = { ref: "w1/2/1#aaaaaaa", role: "AXTable", position: [0, 100], size: [350, 700] };
const MESSAGE_LIST = { ref: "w1/3/1#bbbbbbb", role: "AXList", position: [360, 120], size: [840, 600] };
const CHAT_ROW_CELL = { ref: "w1/2/1/4#ddddddd", role: "AXCell", description: "Mom", position: [0, 190], size: [350, 60] };
const CHAT_ROW_TEXT = { ref: "w1/2/1/4/1#ccccccc", role: "AXStaticText", value: "Mom", position: [60, 200], size: [100, 20] };
const OTHER_MOM_ROW = { ref: "w1/2/1/9/1#hhhhhhh", role: "AXStaticText", value: "Mom", position: [60, 500], size: [100, 20] };
const HEADER_TITLE = { ref: "w1/4/1/1#eeeeeee", role: "AXStaticText", value: "Mom", position: [400, 40], size: [100, 20] };
const MESSAGE_BUBBLE = { ref: "w1/3/1/7/1#fffffff", role: "AXStaticText", value: "Mom", position: [500, 400], size: [60, 20] };
const COMPOSER = { ref: "w1/5/2#ggggggg", role: "AXTextArea", position: [380, 740], size: [800, 40] };
const SIDEBAR_TEXT_AREA = { ref: "w1/2/9#iiiiiii", role: "AXTextArea", position: [10, 760], size: [300, 30] };
const OTHER_BUTTON = { role: "AXButton", title: "New chat", position: [300, 20], size: [20, 20] };

function createWhatsAppWorld(options = {}) {
  const state = { focused: null, composerValue: options.composerDraft ?? "", messageInserted: false };
  const headerMatches = () => {
    const header = state.messageInserted && options.headerAfterInsert ? options.headerAfterInsert : options.header ?? [HEADER_TITLE];
    return [{ ...SEARCH_FIELD, ref: "w1/1/1#jjjjjjj", value: "Mom" }, CHAT_ROW_TEXT, ...header, MESSAGE_BUBBLE];
  };
  const findElements = (input) => {
    if (input.roles?.includes("AXTable")) return { elements: options.containers ?? [CHAT_LIST, MESSAGE_LIST] };
    if (input.roles?.includes("AXTextArea")) return { elements: options.textAreas ?? [SIDEBAR_TEXT_AREA, COMPOSER] };
    if (input.root_ref === CHAT_LIST.ref) return { elements: options.chatListMatches ?? [CHAT_ROW_TEXT, CHAT_ROW_CELL] };
    return { elements: headerMatches() };
  };
  return {
    state,
    jxaResults: {
      focus_app: { app: "WhatsApp", frontmost: true },
      list_windows: { app: "WhatsApp", windows: [WINDOW] },
      find_elements: findElements,
      press_keys: (input) => {
        if (input.steps[0].label === "cmd+f") state.focused = options.searchFocus ?? SEARCH_FIELD;
        return { pressed: input.steps.length };
      },
      read_focused_element: () => (state.focused === COMPOSER ? { ...COMPOSER, full_value: state.composerValue } : { ...state.focused, full_value: "" }),
      focus_element: (input) => {
        if (input.ref === COMPOSER.ref && !options.composerIgnoresFocus) state.focused = COMPOSER;
        return { element: {} };
      },
      type_text: (input) => {
        if (state.focused === COMPOSER) {
          state.composerValue += input.text;
          state.messageInserted = true;
        }
        return { method: input.method };
      },
      click_element: { method: "AXPress" },
    },
  };
}

function describeCall(call) {
  const { scriptName, input } = call;
  if (scriptName === "press_keys") return `keys ${input.steps.map((step) => step.label).join(" ")}${input.require_focus ? " (focus checked)" : ""}`;
  if (scriptName === "type_text") return `${input.method} ${input.text}${input.require_focus ? " (focus checked)" : ""}`;
  if (scriptName === "find_elements") return `find ${input.roles ? input.roles.join(",") : input.text}${input.root_ref ? ` in ${input.root_ref}` : ""}`;
  if (scriptName === "click_element" || scriptName === "focus_element") return `${scriptName} ${input.ref}`;
  return scriptName;
}

function runSend(world, args = { chat: " Mom ", text: "Hi\nSee you" }, environment) {
  return runWithFakes("whatsapp_desktop_send", args, { jxaResults: world.jxaResults }, { source: "node", ...(environment ? { environment } : {}) });
}

function runFailingSend(world, args = { chat: "Mom", text: "hello" }) {
  return runExpectingError("whatsapp_desktop_send", args, { jxaResults: world.jxaResults }, { source: "node" });
}

const typedMessage = (dependencies, text = "hello") => dependencies.jxaCalls.some((call) => call.scriptName === "type_text" && call.input.text === text);
const pressedEnter = (dependencies) => dependencies.jxaCalls.some((call) => call.scriptName === "press_keys" && call.input.steps.some((step) => step.label === "enter"));

test("whatsapp_desktop_send verifies search focus, a unique chat-list match, the header and the composer before sending", async () => {
  const world = createWhatsAppWorld();
  const { output, dependencies } = await runSend(world);
  assert.deepEqual(dependencies.jxaCalls.map(describeCall), [
    "focus_app",
    "keys cmd+f",
    "read_focused_element",
    "keys cmd+a delete (focus checked)",
    "insert Mom (focus checked)",
    "list_windows",
    "find AXTable,AXOutline,AXList",
    "find Mom in w1/2/1#aaaaaaa",
    "click_element w1/2/1/4#ddddddd",
    "find Mom",
    "find AXTextArea",
    "focus_element w1/5/2#ggggggg",
    "read_focused_element",
    "insert Hi\nSee you (focus checked)",
    "find Mom",
    "keys enter (focus checked)",
  ]);
  const enterCall = dependencies.jxaCalls.at(-1);
  assert.deepEqual(enterCall.input.require_focus, { role: "AXTextArea", left: 380, bottom: 780 });
  const clearCall = dependencies.jxaCalls[3];
  assert.deepEqual(clearCall.input.require_focus, { role: "AXTextField", left: 20, bottom: 90 });
  assert.ok(dependencies.jxaCalls.filter((call) => call.scriptName === "type_text").every((call) => call.input.method === "insert"), "never pastes");
  assert.ok(dependencies.jxaCalls.every((call) => call.input.app === undefined || call.input.app === "WhatsApp"));
  assert.ok(dependencies.jxaCalls.filter((call) => call.scriptName === "find_elements" && call.input.text).every((call) => call.input.exact === true));
  assert.deepEqual(dependencies.sleeps, [1500, 1000]);
  assert.deepEqual(output.data, { chat: "Mom", sent: true, characters: 10, chat_element: "w1/2/1/4#ddddddd", composer_ref: "w1/5/2#ggggggg", delivery_confirmed: false });
});

test("whatsapp_desktop_send is a workflow node only, never an agent tool", async () => {
  const { error, dependencies } = await runExpectingError("whatsapp_desktop_send", { chat: "Mom", text: "hi" }, { jxaResults: createWhatsAppWorld().jxaResults });
  assert.equal(error.kind, "invalid_input");
  assert.equal(dependencies.jxaCalls.length, 0);
});

test("whatsapp_desktop_send never clears or types when Cmd+F did not focus the search field", async () => {
  const { error, dependencies } = await runFailingSend(createWhatsAppWorld({ searchFocus: OTHER_BUTTON }));
  assert.equal(error.kind, "not_found");
  assert.match(error.message, /search field/);
  assert.deepEqual(dependencies.jxaCalls.map(describeCall), ["focus_app", "keys cmd+f", "read_focused_element"]);
});

test("whatsapp_desktop_send ignores matches outside the chat list (message bubbles, sender labels, header)", async () => {
  const { error, dependencies } = await runFailingSend(createWhatsAppWorld({ chatListMatches: [] }));
  assert.equal(error.kind, "not_found");
  assert.match(error.message, /No WhatsApp chat named "Mom"/);
  assert.ok(!dependencies.jxaCalls.some((call) => call.scriptName === "click_element"));
  assert.ok(!typedMessage(dependencies));
  assert.equal(describeCall(dependencies.jxaCalls.at(-1)), "keys escape");
});

test("whatsapp_desktop_send fails when it cannot find the chat list under the search field", async () => {
  const { error, dependencies } = await runFailingSend(createWhatsAppWorld({ containers: [MESSAGE_LIST] }));
  assert.equal(error.kind, "not_found");
  assert.match(error.message, /chat list/);
  assert.ok(!typedMessage(dependencies));
});

test("whatsapp_desktop_send fails invalid_input when two chats match the name", async () => {
  const { error, dependencies } = await runFailingSend(createWhatsAppWorld({ chatListMatches: [CHAT_ROW_TEXT, CHAT_ROW_CELL, OTHER_MOM_ROW] }));
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /2 chats/);
  assert.ok(!dependencies.jxaCalls.some((call) => call.scriptName === "click_element"));
  assert.ok(!typedMessage(dependencies));
});

test("whatsapp_desktop_send stops before typing when the opened conversation's header is not the chat name", async () => {
  const { error, dependencies } = await runFailingSend(createWhatsAppWorld({ header: [{ ...HEADER_TITLE, value: "Mom Work" }] }));
  assert.equal(error.kind, "not_found");
  assert.match(error.message, /header/);
  assert.ok(!typedMessage(dependencies));
  assert.ok(!pressedEnter(dependencies));
});

test("whatsapp_desktop_send stops before typing when there is no message box", async () => {
  const { error, dependencies } = await runFailingSend(createWhatsAppWorld({ textAreas: [SIDEBAR_TEXT_AREA] }));
  assert.equal(error.kind, "not_found");
  assert.match(error.message, /message box/);
  assert.ok(!typedMessage(dependencies));
});

test("whatsapp_desktop_send stops before typing when the message box does not take focus", async () => {
  const { error, dependencies } = await runFailingSend(createWhatsAppWorld({ composerIgnoresFocus: true }));
  assert.equal(error.kind, "plugin_error");
  assert.match(error.message, /did not take focus/);
  assert.ok(!typedMessage(dependencies));
});

test("whatsapp_desktop_send refuses to send over an unsent draft", async () => {
  const { error, dependencies } = await runFailingSend(createWhatsAppWorld({ composerDraft: "half-written" }));
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /draft/);
  assert.ok(!typedMessage(dependencies));
});

test("whatsapp_desktop_send re-checks the header right before Return and does not press it when the chat changed", async () => {
  const { error, dependencies } = await runFailingSend(createWhatsAppWorld({ headerAfterInsert: [{ ...HEADER_TITLE, value: "Boss" }] }));
  assert.equal(error.kind, "not_found");
  assert.ok(typedMessage(dependencies));
  assert.ok(!pressedEnter(dependencies));
});

test("whatsapp_desktop_send uses the bundle id when only the bundle id is allowed", async () => {
  const { dependencies } = await runSend(createWhatsAppWorld(), { chat: "Mom", text: "hi" }, { COMPUTER_CONTROL_ALLOWED_APPS: "net.whatsapp.WhatsApp" });
  assert.ok(dependencies.jxaCalls.every((call) => call.input.app === undefined || call.input.app === "net.whatsapp.WhatsApp"));
});

test("whatsapp_desktop_send needs WhatsApp in the allowlist", async () => {
  const { error, dependencies } = await runExpectingError("whatsapp_desktop_send", { chat: "Mom", text: "hi" }, {}, { environment: { COMPUTER_CONTROL_ALLOWED_APPS: "Finder" }, source: "node" });
  assert.equal(error.kind, "permission_denied");
  assert.equal(dependencies.jxaCalls.length, 0);
});

test("whatsapp_desktop_send rejects empty text and is never retried", async () => {
  const { error } = await runExpectingError("whatsapp_desktop_send", { chat: "Mom", text: "   " }, {}, { source: "node" });
  assert.equal(error.kind, "invalid_input");
  const failingFocus = await runExpectingError("whatsapp_desktop_send", { chat: "Mom", text: "hi" }, { jxaResults: { focus_app: Object.assign(new Error("not running"), { kind: "not_found" }) } }, { source: "node" });
  assert.equal(failingFocus.dependencies.jxaCalls.length, 1);
});

test("every JXA script compiles with osacompile", { skip: process.platform !== "darwin" }, () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "computer-control-jxa-"));
  try {
    for (const scriptName of JXA_SCRIPT_NAMES) {
      const sourcePath = join(outputDirectory, `${scriptName}.js`);
      writeFileSync(sourcePath, loadJxaSource(scriptName));
      const compile = spawnSync("/usr/bin/osacompile", ["-l", "JavaScript", "-o", join(outputDirectory, `${scriptName}.scpt`), sourcePath], { encoding: "utf8" });
      assert.equal(compile.status, 0, `${scriptName}: ${compile.stderr}`);
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});
