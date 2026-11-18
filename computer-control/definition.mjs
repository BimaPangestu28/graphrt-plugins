/**
 * computer-control plugin definition: macOS desktop control through the
 * Accessibility API (JXA via osascript), keyboard/mouse events and screencapture.
 *
 * There is no token: `resolveAccessToken` returns "local" and `createClient`
 * builds the osascript-backed client. COMPUTER_CONTROL_ALLOWED_APPS is listed as
 * `tokenEnv` so it appears in the manifest's env permissions. `localOnly` makes
 * the manifest ask for no network and no secrets, and drops the node `access_token`.
 */
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import {
  ALLOW_CLIPBOARD_READ_ENV,
  ALLOW_FULL_SCREENSHOT_ENV,
  createComputerControlClient,
  createDefaultDependencies,
  SCREENSHOT_DIR_ENV,
} from "./lib/client.mjs";
import { ALLOWED_APPS_ENV } from "./lib/allowlist.mjs";
import { appOperations } from "./operations/apps.mjs";
import { clipboardOperations } from "./operations/clipboard.mjs";
import { inputOperations } from "./operations/input.mjs";
import { screenOperations } from "./operations/screen.mjs";
import { uiOperations } from "./operations/ui.mjs";
import { whatsappOperations } from "./operations/whatsapp.mjs";

const REDACTED_ARGUMENT_NAMES = new Set(["text", "value"]);

/**
 * Builds the plugin definition with injectable side effects.
 *
 * @param dependencyOverrides - Replaces parts of createDefaultDependencies(), e.g. `{runJxa, runCommand, platform}` in tests (object)
 * @returns Plugin definition for the shared runner (object)
 *
 * @example
 * const definition = createComputerControlDefinition({ runJxa: fakeRunJxa, platform: "darwin" });
 */
export function createComputerControlDefinition(dependencyOverrides = {}) {
  const dependencies = { ...createDefaultDependencies(), ...dependencyOverrides };
  const runExclusively = createSerialQueue();
  const operations = [...appOperations, ...uiOperations, ...inputOperations, ...clipboardOperations, ...screenOperations, ...whatsappOperations];
  return {
    name: "computer-control",
    version: "0.1.0",
    description: "Control macOS desktop apps through the Accessibility tree: read UI as text, click, type, press keys, clipboard, screenshots",
    tokenEnv: ALLOWED_APPS_ENV,
    extraEnv: [SCREENSHOT_DIR_ENV, ALLOW_CLIPBOARD_READ_ENV, ALLOW_FULL_SCREENSHOT_ENV],
    localOnly: true,
    limits: { timeout_ms: 120000, max_concurrency: 1 },
    resolveAccessToken: () => "local",
    createClient: ({ environment }) => createComputerControlClient(environment, dependencies),
    operations: operations.map((operation) => ({ ...operation, run: (context) => runExclusively(() => runLogged(operation, context)) })),
  };
}

// A call that waited in the queue past its deadline (or was cancelled) must not start acting.
function runLogged(operation, context) {
  if (context.signal?.aborted) throw new PluginError(`${operation.name} was cancelled before it started`, { kind: "cancelled" });
  context.client.logAction(operation.name, summarizeArguments(context.args));
  return operation.run(context);
}

// Typed text and values are logged as their length only.
function summarizeArguments(args) {
  return Object.fromEntries(
    Object.entries(args ?? {}).map(([name, value]) => [name, REDACTED_ARGUMENT_NAMES.has(name) && typeof value === "string" ? `<${value.length} chars>` : value]),
  );
}

// UI automation shares one keyboard, mouse and focus: operations never interleave.
function createSerialQueue() {
  let queueTail = Promise.resolve();
  return (task) => {
    const result = queueTail.then(task);
    queueTail = result.catch(() => {});
    return result;
  };
}

export const pluginDefinition = createComputerControlDefinition();
