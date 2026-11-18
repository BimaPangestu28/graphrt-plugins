/**
 * App and window operations: list, open, focus, quit, list windows.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { isAppAllowed, isBundleId } from "../lib/allowlist.mjs";
import { APP_PROPERTY } from "./common.mjs";

const OPEN_PATH = "/usr/bin/open";
const OPEN_TIMEOUT_MS = 30000;
const APP_ONLY_PARAMETERS = { type: "object", properties: { app: APP_PROPERTY }, required: ["app"] };

function describeAppLine(app) {
  const flags = [app.active ? "frontmost" : null, app.hidden ? "hidden" : null, app.allowed ? "allowed" : "not allowed"].filter(Boolean);
  return `${app.name}${app.bundle_id ? ` (${app.bundle_id})` : ""} [${flags.join(", ")}]`;
}

function describeWindowLine(window) {
  const frame = window.position && window.size ? ` @${window.position.join(",")} ${window.size.join("x")}` : "";
  const flags = [window.main ? "main" : null, window.focused ? "focused" : null, window.minimized ? "minimized" : null].filter(Boolean);
  return `${window.ref} ${JSON.stringify(window.title ?? "")}${frame}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

function isAppEntryAllowed(app, allowedApps) {
  return isAppAllowed(app.name, allowedApps) || (Boolean(app.bundle_id) && isAppAllowed(app.bundle_id, allowedApps));
}

// `open -b` takes a bundle id, `open -a` an app name.
async function openApp({ client, args, signal }) {
  const appName = client.requireApp(args.app);
  const openFlag = isBundleId(appName) ? "-b" : "-a";
  const { exitCode, stderr } = await client.runCommand(OPEN_PATH, [openFlag, appName], { signal, timeoutMs: OPEN_TIMEOUT_MS });
  if (exitCode === 0) return { data: { app: appName, opened: true } };
  if (/unable to find application/i.test(stderr)) throw new PluginError(`App "${appName}" is not installed`, { kind: "not_found" });
  throw new PluginError(`open ${openFlag} "${appName}" failed: ${stderr.trim().slice(0, 300)}`, { kind: "plugin_error" });
}

export const appOperations = [
  {
    name: "list_apps",
    title: "List running apps",
    description: "List running apps that have a Dock icon, with which one is frontmost and whether COMPUTER_CONTROL_ALLOWED_APPS allows it. data.text is a readable summary.",
    parameters: { type: "object", properties: {} },
    run: async ({ client, signal }) => {
      const apps = (await client.runJxa("list_apps", {}, { signal })).map((app) => ({ ...app, allowed: isAppEntryAllowed(app, client.allowedApps) }));
      return { data: { apps, text: apps.map(describeAppLine).join("\n") } };
    },
  },
  {
    name: "open_app",
    title: "Open app",
    description: "Launch an app (or bring it to the front if it is already running), like `open -a` (or `open -b` for a bundle id such as net.whatsapp.WhatsApp).",
    parameters: APP_ONLY_PARAMETERS,
    run: openApp,
  },
  {
    name: "focus_app",
    title: "Focus app",
    description: "Bring a running app to the front so it receives keyboard input.",
    parameters: APP_ONLY_PARAMETERS,
    run: async ({ client, args, signal }) => ({ data: await client.runJxa("focus_app", { app: client.requireApp(args.app) }, { signal }) }),
  },
  {
    name: "quit_app",
    title: "Quit app",
    description: "Ask a running app to quit, like Cmd+Q (it may still ask to save documents). Workflow node only, never an agent tool.",
    nodeOnly: true,
    parameters: APP_ONLY_PARAMETERS,
    run: async ({ client, args, signal }) => ({ data: await client.runJxa("quit_app", { app: client.requireApp(args.app) }, { signal }) }),
  },
  {
    name: "list_windows",
    title: "List windows",
    description: "List an app's windows (ref w1 = frontmost) with title, position and size. data.text is a readable summary.",
    parameters: APP_ONLY_PARAMETERS,
    run: async ({ client, args, signal }) => {
      const result = await client.runJxa("list_windows", { app: client.requireApp(args.app) }, { signal });
      const header = `${result.app}: ${result.windows.length} window(s)`;
      return { data: { ...result, text: [header, ...result.windows.map(describeWindowLine)].join("\n") } };
    },
  },
];
