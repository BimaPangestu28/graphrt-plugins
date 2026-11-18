/**
 * Accessibility-tree operations: read, find, and act on elements by ref.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { buildOutlineOutput, normalizeRole, validateElementRef } from "../lib/ui-tree.mjs";
import {
  APP_PROPERTY,
  MAX_VISITED_ELEMENTS,
  normalizeLineEndings,
  REF_PROPERTY,
  requireTextWithinLimit,
  ROOT_REF_PROPERTY,
  TREE_SCRIPT_TIMEOUT_MS,
  WINDOW_PROPERTY,
} from "./common.mjs";

const ELEMENT_ACTION_PARAMETERS = { type: "object", properties: { app: APP_PROPERTY, ref: REF_PROPERTY }, required: ["app", "ref"] };

function optionalRootRef(rootRef) {
  return rootRef ? validateElementRef(rootRef) : null;
}

// Tool output carries data as JSON: elements and text together are capped (see buildOutlineOutput).
function withOutline(snapshot, header, options) {
  const { text, elements, output_truncated: outputTruncated } = buildOutlineOutput(header, snapshot, options);
  return { data: { ...snapshot, elements, output_truncated: outputTruncated, text } };
}

/**
 * Reads a window (or sub-tree) and returns the structured elements plus data.text.
 */
async function readUi({ client, args, signal }) {
  const appName = client.requireApp(args.app);
  const snapshot = await client.runJxa(
    "read_ui",
    {
      app: appName,
      window: args.window,
      root_ref: optionalRootRef(args.root_ref),
      max_depth: args.max_depth,
      max_elements: args.max_elements,
      text_only: args.text_only,
      max_visited: MAX_VISITED_ELEMENTS,
    },
    { signal, timeoutMs: TREE_SCRIPT_TIMEOUT_MS },
  );
  return withOutline(snapshot, `${snapshot.app} ${snapshot.root_ref}`);
}

async function findElements({ client, args, signal }) {
  const appName = client.requireApp(args.app);
  if (!args.role && !args.text) throw new PluginError("Pass `role`, `text` or both", { kind: "invalid_input" });
  const result = await client.runJxa(
    "find_elements",
    {
      app: appName,
      window: args.window,
      root_ref: optionalRootRef(args.root_ref),
      roles: args.role ? [normalizeRole(args.role)] : null,
      text: args.text ?? null,
      exact: args.exact,
      max_depth: args.max_depth,
      max_results: args.max_results,
      max_visited: MAX_VISITED_ELEMENTS,
    },
    { signal, timeoutMs: TREE_SCRIPT_TIMEOUT_MS },
  );
  return withOutline(result, `${result.app} ${result.root_ref} matches`, { indent: false });
}

// Acting on an element needs the fingerprinted ref, so a UI that shifted fails instead of hitting another element.
function runElementAction(scriptName, extraInput = () => ({})) {
  return async ({ client, args, signal }) => {
    const ref = validateElementRef(args.ref, { requireFingerprint: true });
    return { data: await client.runJxa(scriptName, { app: client.requireApp(args.app), ref, ...extraInput(args) }, { signal }) };
  };
}

export const uiOperations = [
  {
    name: "read_ui",
    title: "Read app UI",
    description:
      "Read a window's Accessibility tree as elements {ref, role, title, value, description, enabled, focused, position, size}. data.text is a compact indented outline; pass the refs exactly as shown (e.g. w1/3/2#0a1b2c3) to click_element, set_value and focus_element. A ref fails with not_found once that element changed: read_ui again. Long output is cut (data.output_truncated).",
    parameters: {
      type: "object",
      properties: {
        app: APP_PROPERTY,
        window: WINDOW_PROPERTY,
        root_ref: ROOT_REF_PROPERTY,
        max_depth: { type: "integer", minimum: 1, maximum: 40, default: 8, description: "Levels below the root to read" },
        max_elements: { type: "integer", minimum: 1, maximum: 2000, default: 300, description: "Stop after this many elements" },
        text_only: { type: "boolean", default: false, description: "Only return elements that have a title, value, description or placeholder" },
      },
      required: ["app"],
    },
    run: readUi,
  },
  {
    name: "find_elements",
    title: "Find UI elements",
    description: "Find elements in a window by role (e.g. \"button\", \"AXTextField\") and/or text contained in their title, value, description or placeholder (case-insensitive).",
    parameters: {
      type: "object",
      properties: {
        app: APP_PROPERTY,
        window: WINDOW_PROPERTY,
        root_ref: ROOT_REF_PROPERTY,
        role: { type: "string", description: "Accessibility role, with or without the AX prefix, e.g. \"button\"" },
        text: { type: "string", description: "Text to look for (contains-match, case-insensitive)" },
        exact: { type: "boolean", default: false, description: "Require the whole text to match instead of contains" },
        max_depth: { type: "integer", minimum: 1, maximum: 60, default: 25 },
        max_results: { type: "integer", minimum: 1, maximum: 200, default: 20 },
      },
      required: ["app"],
    },
    run: findElements,
  },
  {
    name: "click_element",
    title: "Click element",
    description:
      "Press an element by ref (AXPress). If it has no press action, click its centre with the mouse (brings the app to the front); the click is refused when the centre is outside the element's window or another app's window covers it.",
    parameters: {
      type: "object",
      properties: {
        app: APP_PROPERTY,
        ref: REF_PROPERTY,
        fallback_click: { type: "boolean", default: true, description: "Click the element's centre when AXPress is not supported" },
      },
      required: ["app", "ref"],
    },
    run: runElementAction("click_element", (args) => ({ fallback_click: args.fallback_click })),
  },
  {
    name: "set_value",
    title: "Set element value",
    description: "Set the text of a text field or text area by ref (AXValue), without typing. Some apps ignore values set this way; then use focus_element + type_text.",
    parameters: {
      type: "object",
      properties: { app: APP_PROPERTY, ref: REF_PROPERTY, value: { type: "string", description: "New text" } },
      required: ["app", "ref", "value"],
    },
    run: runElementAction("set_value", (args) => ({ value: normalizeLineEndings(requireTextWithinLimit("value", args.value)) })),
  },
  {
    name: "focus_element",
    title: "Focus element",
    description: "Bring the app to the front and move keyboard focus to an element by ref, e.g. before type_text.",
    parameters: ELEMENT_ACTION_PARAMETERS,
    run: runElementAction("focus_element"),
  },
];
