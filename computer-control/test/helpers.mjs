import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createComputerControlDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = { COMPUTER_CONTROL_ALLOWED_APPS: "Finder, WhatsApp", COMPUTER_CONTROL_SCREENSHOT_DIR: "/tmp/never-used" };

/**
 * Creates fake side-effect dependencies that record every call.
 *
 * @param options - `{jxaResults: {scriptName: value | (input) => value | Error}, commandResult: (file, args) => {exitCode, stdout, stderr}}`
 * @returns Dependencies plus `jxaCalls`, `commandCalls`, `sleeps`, `logs` arrays (object)
 */
export function createFakeDependencies({ jxaResults = {}, commandResult = () => ({ exitCode: 0, stdout: "", stderr: "" }), platform = "darwin" } = {}) {
  const recorded = { jxaCalls: [], commandCalls: [], sleeps: [], logs: [] };
  return {
    ...recorded,
    platform,
    temporaryDirectory: "/tmp",
    now: () => new Date("2026-11-18T10:00:00.000Z"),
    sleep: async (delayMs) => recorded.sleeps.push(delayMs),
    logAction: (operationName, details) => recorded.logs.push({ operationName, details }),
    runJxa: async (scriptName, input, options) => {
      recorded.jxaCalls.push({ scriptName, input, options });
      const configured = jxaResults[scriptName];
      const value = typeof configured === "function" ? configured(input) : configured;
      if (value instanceof Error) throw value;
      return value ?? {};
    },
    runCommand: async (file, args, options) => {
      recorded.commandCalls.push({ file, args, options });
      return commandResult(file, args);
    },
  };
}

/**
 * Runs one operation with fake dependencies.
 *
 * @returns `{output, dependencies}`
 */
export async function runWithFakes(operationName, args, fakeOptions = {}, { environment = TEST_ENVIRONMENT, source = "tool" } = {}) {
  const dependencies = createFakeDependencies(fakeOptions);
  const runOperation = createOperationRunner(createComputerControlDefinition(dependencies), environment);
  const output = await runOperation(operationName, args, { source });
  return { output, dependencies };
}

/**
 * Runs an operation that must fail and returns the error.
 */
export async function runExpectingError(operationName, args, fakeOptions = {}, runOptions = {}) {
  const dependencies = createFakeDependencies(fakeOptions);
  const runOperation = createOperationRunner(createComputerControlDefinition(dependencies), runOptions.environment ?? TEST_ENVIRONMENT);
  try {
    await runOperation(operationName, args, { source: runOptions.source ?? "tool" });
  } catch (error) {
    return { error, dependencies };
  }
  throw new Error(`${operationName} was expected to fail`);
}
