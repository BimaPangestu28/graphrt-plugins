/**
 * notify: a fixed AppleScript run by /usr/bin/osascript with the values as separate arguments (never inside the
 * script), cleaned and capped, with a tool rate limit. No notification is posted here (fake process runner).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { createPluginDefinition, pluginDefinition } from "../definition.mjs";
import { NOTIFICATION_SCRIPT_LINES } from "../lib/notification-script.mjs";

const AS_TOOL = { source: "tool" };
const AS_NODE = { source: "node" };
const INJECTION_PAYLOADS = [
  `" & (do shell script "touch /tmp/graphrt-pwned") & "`,
  `\\" & quit & \\"`,
  `-e`,
  `--`,
  `end run\ndo shell script "id"`,
  `«data utxt0041»`,
];

function createRunner({ environment = {}, exitCode = 0, stderr = "", platform = "darwin", clock } = {}) {
  const requests = [];
  const runProcess = async (request) => {
    requests.push(request);
    return { exitCode, signalCode: null, stdout: Buffer.alloc(0), stdoutTruncated: false, stderr };
  };
  const definition = createPluginDefinition({ runProcess, platform, now: clock ?? (() => 0) });
  return { runOperation: createOperationRunner(definition, environment), requests };
}

test("notify runs /usr/bin/osascript with the fixed script and the values after --", async () => {
  const { runOperation, requests } = createRunner();
  const { data } = await runOperation("notify", { notification_title: "Build", message: "Done", subtitle: "main", sound: "Glass" }, AS_TOOL);
  assert.deepEqual(data, { posted: true, title: "Build", subtitle: "main", message: "Done", sound: "Glass" });
  const [request] = requests;
  assert.equal(request.command, "/usr/bin/osascript");
  const scriptArguments = NOTIFICATION_SCRIPT_LINES.flatMap((line) => ["-e", line]);
  assert.deepEqual(request.args, [...scriptArguments, "--", "Done", "Build", "main", "Glass"]);
  assert.ok(request.timeoutMs <= 15000);
});

test("injection payloads only ever appear as arguments after --, never in the script", async () => {
  for (const payload of INJECTION_PAYLOADS) {
    const { runOperation, requests } = createRunner();
    await runOperation("notify", { notification_title: payload, message: payload, subtitle: payload }, AS_NODE);
    const { args } = requests[0];
    const separator = args.indexOf("--");
    assert.deepEqual(args.slice(0, separator), NOTIFICATION_SCRIPT_LINES.flatMap((line) => ["-e", line]), payload);
    assert.equal(args.length, separator + 5);
    for (const value of args.slice(separator + 1, separator + 4)) assert.equal(value, payload.replace(/[\u0000-\u001f\u007f]+/g, " ").trim());
  }
});

test("the script text has no placeholders: it reads argv only", () => {
  const scriptText = NOTIFICATION_SCRIPT_LINES.join("\n");
  assert.match(scriptText, /^on run argv/);
  assert.doesNotMatch(scriptText, /do shell script|\$\{|%s/);
});

test("Unicode line separators, NEL, C1 controls and bidi overrides are removed too", async () => {
  const { runOperation, requests } = createRunner();
  const tricky = "safe\u2028line\u2029para\u0085nel\u009bcsi\u202Eevil\u2066iso\u2069\u200Fmark";
  const { data } = await runOperation("notify", { message: tricky, notification_title: "t\u202Dx", subtitle: "s\u2067y" }, AS_NODE);
  for (const value of [...requests[0].args.slice(-4, -1), data.message, data.title, data.subtitle]) {
    assert.doesNotMatch(value, /[\u0080-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u, JSON.stringify(value));
  }
  assert.equal(data.message, "safe line para nel csi evil iso mark");
});

test("control characters are removed and long values are cut", async () => {
  const { runOperation, requests } = createRunner();
  const { data } = await runOperation("notify", { message: `a\u0000b\u0007c\n${"x".repeat(5000)}` }, AS_NODE);
  assert.ok(!/[\u0000-\u001f]/.test(requests[0].args.at(-4)));
  assert.ok(data.message.length <= 1000);
  assert.equal(data.title, "graphrt");
});

test("sound must be a macOS system sound", async () => {
  const { runOperation } = createRunner();
  await assert.rejects(runOperation("notify", { message: "x", sound: "../../evil" }, AS_TOOL), { kind: "invalid_input" });
});

test("tool calls are rate limited per minute; nodes are not", async () => {
  let nowMs = 0;
  const { runOperation } = createRunner({ environment: { MACOS_NOTIFICATIONS_TOOL_RATE_LIMIT: "2" }, clock: () => nowMs });
  await runOperation("notify", { message: "1" }, AS_TOOL);
  await runOperation("notify", { message: "2" }, AS_TOOL);
  await assert.rejects(runOperation("notify", { message: "3" }, AS_TOOL), (error) => error.kind === "rate_limited" && error.retryable === true && error.retryAfterMs > 0);
  await runOperation("notify", { message: "node" }, AS_NODE);
  nowMs = 61000;
  await runOperation("notify", { message: "4" }, AS_TOOL);
});

test("not macOS: setup_required without running anything", async () => {
  const { runOperation, requests } = createRunner({ platform: "linux" });
  await assert.rejects(runOperation("notify", { message: "x" }, AS_TOOL), { kind: "setup_required" });
  assert.equal(requests.length, 0);
});

test("an osascript failure is plugin_error with its message", async () => {
  const { runOperation } = createRunner({ exitCode: 1, stderr: "execution error: Not authorised (-1743)" });
  await assert.rejects(runOperation("notify", { message: "x" }, AS_TOOL), { kind: "plugin_error", message: /-1743/ });
});

test("manifest: local only, one tool", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["notify"]);
});
