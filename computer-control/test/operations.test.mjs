import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDescriptors, createOperationRunner } from "../lib/shared/operations.mjs";
import { createComputerControlDefinition, pluginDefinition } from "../definition.mjs";
import { createFakeDependencies, runExpectingError, runWithFakes, TEST_ENVIRONMENT } from "./helpers.mjs";

// Each case: operation + args → the single JXA script it runs and a subset of the JSON input it sends.
const SCRIPT_CASES = [
  ["list_apps", {}, "list_apps", {}],
  ["focus_app", { app: "finder" }, "focus_app", { app: "finder" }],
  ["list_windows", { app: "Finder" }, "list_windows", { app: "Finder" }],
  ["read_ui", { app: "Finder" }, "read_ui", { app: "Finder", window: 1, root_ref: null, max_depth: 8, max_elements: 300, text_only: false }],
  ["read_ui", { app: "Finder", window: 2, root_ref: "w2/1", max_depth: 3, max_elements: 10, text_only: true }, "read_ui", { window: 2, root_ref: "w2/1", max_depth: 3, max_elements: 10, text_only: true }],
  ["read_ui", { app: "Finder", root_ref: "w1/2#0a1b2c3" }, "read_ui", { root_ref: "w1/2#0a1b2c3" }],
  ["find_elements", { app: "Finder", role: "button" }, "find_elements", { roles: ["AXButton"], text: null, exact: false, max_results: 20 }],
  ["find_elements", { app: "Finder", text: "Downloads", exact: true }, "find_elements", { roles: null, text: "Downloads", exact: true }],
  ["click_element", { app: "Finder", ref: "w1/3/2#0a1b2c3" }, "click_element", { ref: "w1/3/2#0a1b2c3", fallback_click: true }],
  ["click_element", { app: "Finder", ref: "w1/3#0a1b2c3", fallback_click: false }, "click_element", { fallback_click: false }],
  ["set_value", { app: "Finder", ref: "w1/2#0a1b2c3", value: "hello" }, "set_value", { ref: "w1/2#0a1b2c3", value: "hello" }],
  ["focus_element", { app: "Finder", ref: "w1/2#0a1b2c3" }, "focus_element", { ref: "w1/2#0a1b2c3" }],
  ["type_text", { app: "Finder", text: "hi there" }, "type_text", { text: "hi there", method: "keystroke" }],
  ["type_text", { app: "Finder", text: "😀", method: "paste" }, "type_text", { method: "paste" }],
  ["type_text", { app: "Finder", text: "a\r\nb\rc", method: "insert" }, "type_text", { text: "a\nb\nc", method: "insert" }],
  ["press_keys", { app: "Finder", keys: "cmd+shift+n" }, "press_keys", { steps: [{ label: "cmd+shift+n", modifiers: ["command down", "shift down"], character: "n" }] }],
  ["click_at", { app: "Finder", x: 100, y: "200" }, "click_at", { x: 100, y: 200, button: "left", click_count: 1 }],
  ["click_at", { app: "Finder", x: 1, y: 2, button: "right", double: true }, "click_at", { button: "right", click_count: 2 }],
  ["set_clipboard", { text: "copied" }, "set_clipboard", { text: "copied" }],
];

for (const [operationName, args, expectedScript, expectedInput] of SCRIPT_CASES) {
  test(`${operationName} ${JSON.stringify(args)} runs ${expectedScript}`, async () => {
    const { dependencies } = await runWithFakes(operationName, args, { jxaResults: { list_apps: [], list_windows: { app: "Finder", windows: [] }, read_ui: { elements: [] }, find_elements: { elements: [] } } });
    assert.equal(dependencies.jxaCalls.length, 1);
    const [call] = dependencies.jxaCalls;
    assert.equal(call.scriptName, expectedScript);
    for (const [key, expectedValue] of Object.entries(expectedInput)) assert.deepEqual(call.input[key], expectedValue, key);
  });
}

test("quit_app and whatsapp_desktop_send are node-only; every other operation is also a tool", () => {
  const { nodes, tools } = buildDescriptors(pluginDefinition);
  assert.equal(nodes.length, pluginDefinition.operations.length);
  assert.ok(nodes.some((node) => node.kind === "computer-control.quit_app"));
  assert.ok(nodes.some((node) => node.kind === "computer-control.whatsapp_desktop_send"));
  assert.ok(!tools.some((tool) => tool.name === "quit_app"));
  // A tool call cannot be cancelled: a timed-out send that still pressed Return would send twice.
  assert.ok(!tools.some((tool) => tool.name === "whatsapp_desktop_send"));
  assert.equal(tools.length, nodes.length - 2);
  assert.ok(!tools.some((tool) => tool.name === "api_request"), "no arbitrary script or API passthrough");
});

test("the manifest is local-only: no network, no secrets, no node access_token, and lists the opt-in env vars", async () => {
  const { buildManifest } = await import("../lib/shared/operations.mjs");
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  assert.ok(manifest.nodes.every((node) => !("access_token" in node.config_schema.properties)));
  for (const environmentName of ["COMPUTER_CONTROL_ALLOWED_APPS", "COMPUTER_CONTROL_ALLOW_CLIPBOARD_READ", "COMPUTER_CONTROL_ALLOW_FULL_SCREENSHOT"]) {
    assert.ok(manifest.permissions.env.includes(environmentName), environmentName);
  }
});

test("quit_app runs as a node and is rejected as a tool", async () => {
  const { dependencies } = await runWithFakes("quit_app", { app: "Finder" }, {}, { source: "node" });
  assert.equal(dependencies.jxaCalls[0].scriptName, "quit_app");
  const { error } = await runExpectingError("quit_app", { app: "Finder" });
  assert.equal(error.kind, "invalid_input");
});

const APP_OPERATIONS = [
  ["focus_app", {}], ["list_windows", {}], ["read_ui", {}], ["find_elements", { role: "button" }],
  ["click_element", { ref: "w1/1#0a1b2c3" }], ["set_value", { ref: "w1/1#0a1b2c3", value: "x" }], ["focus_element", { ref: "w1/1#0a1b2c3" }],
  ["type_text", { text: "x" }], ["press_keys", { keys: "enter" }], ["click_at", { x: 1, y: 1 }], ["take_screenshot", {}], ["open_app", {}],
];

for (const [operationName, extraArgs] of APP_OPERATIONS) {
  test(`${operationName} rejects an app outside the allowlist before running anything`, async () => {
    const { error, dependencies } = await runExpectingError(operationName, { app: "Terminal", ...extraArgs });
    assert.equal(error.kind, "permission_denied");
    assert.match(error.message, /Terminal.*COMPUTER_CONTROL_ALLOWED_APPS/);
    assert.equal(dependencies.jxaCalls.length + dependencies.commandCalls.length, 0);
  });
}

test("a missing COMPUTER_CONTROL_ALLOWED_APPS fails every operation with permission_denied", async () => {
  const { error, dependencies } = await runExpectingError("list_apps", {}, {}, { environment: {} });
  assert.equal(error.kind, "permission_denied");
  assert.match(error.message, /COMPUTER_CONTROL_ALLOWED_APPS is not set/);
  assert.equal(dependencies.jxaCalls.length, 0);
});

test("on platforms other than macOS every operation fails with invalid_input", async () => {
  const { error, dependencies } = await runExpectingError("list_apps", {}, { platform: "linux" });
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /macOS only/);
  assert.equal(dependencies.jxaCalls.length, 0);
});

test("* allows every app", async () => {
  const { dependencies } = await runWithFakes("focus_app", { app: "Terminal" }, {}, { environment: { COMPUTER_CONTROL_ALLOWED_APPS: "*" } });
  assert.equal(dependencies.jxaCalls[0].input.app, "Terminal");
});

const VALIDATION_CASES = [
  ["read_ui", { app: "Finder", root_ref: "x1/2" }, /`ref` must look like/],
  ["click_element", { app: "Finder", ref: "w0/1" }, /`ref` must look like/],
  ["click_element", { app: "Finder", ref: "w1/../2" }, /`ref` must look like/],
  ["click_element", { app: "Finder", ref: "w1/3" }, /exactly as read_ui or find_elements returned it/],
  ["set_value", { app: "Finder", ref: "w1/3", value: "x" }, /exactly as read_ui/],
  ["focus_element", { app: "Finder", ref: "w1/3" }, /exactly as read_ui/],
  ["find_elements", { app: "Finder" }, /Pass `role`, `text` or both/],
  ["press_keys", { app: "Finder", keys: "cmd+hyper+k" }, /Unknown modifier "hyper"/],
  ["press_keys", { app: "Finder", keys: "cmd+launchpad" }, /Unknown key "launchpad"/],
  ["type_text", { app: "Finder", text: "x".repeat(10001), method: "insert" }, /longer than 10000/],
  ["type_text", { app: "Finder", text: "x".repeat(1001) }, /longer than 1000 characters for method keystroke/],
  ["type_text", { app: "Finder", text: "x", method: "clipboard" }, /method` must be one of/],
  ["read_ui", { app: "Finder", max_elements: 5000 }, /max_elements` must be <= 2000/],
  ["focus_app", { app: "/Applications/Finder.app" }, /must be an app name/],
  ["focus_app", { app: "-a" }, /must be an app name/],
  ["click_at", { app: "Finder", x: 1, y: 2, button: "middle" }, /button` must be one of/],
];

for (const [operationName, args, expectedMessage] of VALIDATION_CASES) {
  test(`${operationName} ${JSON.stringify(args).slice(0, 60)} is invalid_input`, async () => {
    const { error, dependencies } = await runExpectingError(operationName, args);
    assert.equal(error.kind, "invalid_input");
    assert.match(error.message, expectedMessage);
    assert.equal(dependencies.jxaCalls.length, 0);
  });
}

test("list_apps marks allowed apps and renders data.text", async () => {
  const apps = [
    { name: "Finder", bundle_id: "com.apple.finder", pid: 1, active: true, hidden: false },
    { name: "Terminal", bundle_id: "com.apple.Terminal", pid: 2, active: false, hidden: true },
  ];
  const { output } = await runWithFakes("list_apps", {}, { jxaResults: { list_apps: apps } });
  assert.deepEqual(output.data.apps.map((app) => app.allowed), [true, false]);
  assert.equal(output.data.text, "Finder (com.apple.finder) [frontmost, allowed]\nTerminal (com.apple.Terminal) [hidden, not allowed]");
});

test("list_apps and app operations accept bundle ids from the allowlist", async () => {
  const environment = { COMPUTER_CONTROL_ALLOWED_APPS: "net.whatsapp.WhatsApp" };
  const apps = [{ name: "WhatsApp", bundle_id: "net.whatsapp.WhatsApp", pid: 1, active: false, hidden: false }];
  const { output } = await runWithFakes("list_apps", {}, { jxaResults: { list_apps: apps } }, { environment });
  assert.equal(output.data.apps[0].allowed, true);
  const { dependencies } = await runWithFakes("focus_app", { app: "net.whatsapp.WhatsApp" }, {}, { environment });
  assert.equal(dependencies.jxaCalls[0].input.app, "net.whatsapp.WhatsApp");
  const denied = await runExpectingError("focus_app", { app: "WhatsApp" }, {}, { environment });
  assert.equal(denied.error.kind, "permission_denied");
});

test("open_app opens a bundle id with `open -b`", async () => {
  const { dependencies } = await runWithFakes("open_app", { app: "net.whatsapp.WhatsApp" }, {}, { environment: { COMPUTER_CONTROL_ALLOWED_APPS: "net.whatsapp.WhatsApp" } });
  assert.deepEqual(dependencies.commandCalls[0].args, ["-b", "net.whatsapp.WhatsApp"]);
});

test("press_keys refuses system-wide shortcuts before running any script", async () => {
  const { error, dependencies } = await runExpectingError("press_keys", { app: "Finder", keys: "cmd+a cmd+tab" });
  assert.equal(error.kind, "permission_denied");
  assert.equal(dependencies.jxaCalls.length, 0);
});

test("get_clipboard needs COMPUTER_CONTROL_ALLOW_CLIPBOARD_READ=1", async () => {
  const { error, dependencies } = await runExpectingError("get_clipboard", {});
  assert.equal(error.kind, "permission_denied");
  assert.match(error.message, /COMPUTER_CONTROL_ALLOW_CLIPBOARD_READ=1/);
  assert.equal(dependencies.jxaCalls.length, 0);
  const allowed = await runWithFakes("get_clipboard", {}, { jxaResults: { get_clipboard: { text: "x" } } }, { environment: { ...TEST_ENVIRONMENT, COMPUTER_CONTROL_ALLOW_CLIPBOARD_READ: "1" } });
  assert.deepEqual(allowed.output.data, { text: "x" });
});

test("read_ui output caps elements plus text and says when it cut them", async () => {
  const elements = Array.from({ length: 2000 }, (_, index) => ({ ref: `w1/${index + 1}#0a1b2c3`, depth: 1, role: "AXStaticText", value: "v".repeat(70) }));
  const { output } = await runWithFakes("read_ui", { app: "Finder" }, { jxaResults: { read_ui: { app: "Finder", root_ref: "w1", elements, truncated: false } } });
  assert.equal(output.data.output_truncated, true);
  assert.ok(output.data.elements.length < 2000);
  assert.match(output.data.text, /output cut at 60000 characters/);
  assert.ok(JSON.stringify(output).length < 65000);
});

test("read_ui returns the structured elements plus a text outline", async () => {
  const snapshot = {
    app: "Finder",
    root_ref: "w1",
    elements: [
      { ref: "w1", depth: 0, role: "AXWindow", title: "Downloads", position: [0, 0], size: [800, 600] },
      { ref: "w1/1", depth: 1, role: "AXButton", title: "Back", enabled: false },
    ],
    truncated: true,
    depth_limited: false,
  };
  const { output } = await runWithFakes("read_ui", { app: "Finder" }, { jxaResults: { read_ui: snapshot } });
  assert.equal(output.data.elements.length, 2);
  assert.equal(
    output.data.text,
    'Finder w1 — 2 element(s)\nw1 Window "Downloads" @0,0 800x600\n  w1/1 Button "Back" [disabled]\n… truncated: raise max_elements/max_results, or pass root_ref to read one sub-tree',
  );
});

test("open_app runs `open -a` without a shell and maps a missing app to not_found", async () => {
  const { dependencies } = await runWithFakes("open_app", { app: "Finder" });
  assert.deepEqual(dependencies.commandCalls[0].args, ["-a", "Finder"]);
  assert.equal(dependencies.commandCalls[0].file, "/usr/bin/open");
  const { error } = await runExpectingError("open_app", { app: "WhatsApp" }, {
    commandResult: () => ({ exitCode: 1, stdout: "", stderr: "Unable to find application named 'WhatsApp'" }),
  });
  assert.equal(error.kind, "not_found");
});

test("every operation is logged to stderr with typed text redacted to its length", async () => {
  const { dependencies } = await runWithFakes("type_text", { app: "Finder", text: "secret" });
  assert.deepEqual(dependencies.logs[0], { operationName: "type_text", details: { app: "Finder", text: "<6 chars>", method: "keystroke" } });
});

test("an operation whose signal is already aborted (e.g. a tool call past its deadline in the queue) does nothing", async () => {
  const fakes = createFakeDependencies();
  const runOperation = createOperationRunner(createComputerControlDefinition(fakes), TEST_ENVIRONMENT);
  await assert.rejects(runOperation("focus_app", { app: "Finder" }, { source: "tool", signal: AbortSignal.abort() }), (error) => error.kind === "cancelled");
  assert.equal(fakes.jxaCalls.length, 0);
});

test("operations run one at a time", async () => {
  const executionOrder = [];
  const fakes = createFakeDependencies();
  fakes.runJxa = async (scriptName) => {
    executionOrder.push(`start ${scriptName}`);
    await new Promise((resolve) => setTimeout(resolve, scriptName === "focus_app" ? 20 : 0));
    executionOrder.push(`end ${scriptName}`);
    return [];
  };
  const runOperation = createOperationRunner(createComputerControlDefinition(fakes), TEST_ENVIRONMENT);
  await Promise.all([runOperation("focus_app", { app: "Finder" }, { source: "tool" }), runOperation("list_apps", {}, { source: "tool" })]);
  assert.deepEqual(executionOrder, ["start focus_app", "end focus_app", "start list_apps", "end list_apps"]);
});
