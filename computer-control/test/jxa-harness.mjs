/**
 * Runs the real JXA script source (prelude + script) inside a Node `vm` context,
 * with the ObjC bridge stubbed out. Tests replace prelude helpers (e.g.
 * `frontmostProcessIdentifier`, `keystrokeText`) with fakes, so script logic is
 * exercised without touching the keyboard, mouse, clipboard or any app.
 */
import vm from "node:vm";
import { loadJxaSource } from "../lib/jxa-runner.mjs";

/**
 * Loads a JXA script into a fresh sandbox.
 *
 * @param scriptName - One of JXA_SCRIPT_NAMES (string)
 * @param helperOverrides - Global functions/values to replace after loading, e.g. `{ assertFrontmost: fake }` (object)
 * @returns The sandbox; call `sandbox.main(input)` or any prelude helper (object)
 */
export function loadJxaSandbox(scriptName, helperOverrides = {}) {
  const sandbox = vm.createContext({
    ObjC: { import: () => {}, castRefToObject: (value) => value },
    $: createUnexpectedBridge(),
    Application: () => {
      throw new Error("unexpected Application() call in a JXA unit test");
    },
    delay: () => {},
    Ref: () => [],
  });
  vm.runInContext(loadJxaSource(scriptName), sandbox, { filename: `${scriptName}.js` });
  Object.assign(sandbox, helperOverrides);
  return sandbox;
}

/**
 * Runs `main(input)` and returns the failure the script raised through `fail(kind, message)`.
 *
 * @param sandbox - From loadJxaSandbox (object)
 * @param input - Script input (object)
 * @returns `{kind, message}` (object)
 * @throws Error - When main does not fail
 */
export function runExpectingScriptFailure(sandbox, input) {
  try {
    sandbox.main(input);
  } catch (error) {
    if (error && error.kind) return { kind: error.kind, message: error.message };
    throw error;
  }
  throw new Error("main() was expected to fail");
}

// Any ObjC call that a test did not replace is a bug in the test (or a live side effect): fail loudly.
function createUnexpectedBridge() {
  const bridge = (value) => value;
  return new Proxy(bridge, {
    get: (target, propertyName) => {
      if (propertyName === "apply" || propertyName === "call") return target[propertyName];
      throw new Error(`unexpected ObjC bridge access $.${String(propertyName)} in a JXA unit test`);
    },
  });
}
