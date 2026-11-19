/**
 * Test helpers: temporary allowed/lookalike/outside directories and a runner
 * over the real plugin definition.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const AS_NODE = { source: "node" };
export const AS_TOOL = { source: "tool" };

/**
 * Creates temp directories and an operation runner allowed to use `allowed` (and `second`).
 *
 * @param options - `{environment, dependencies}` overrides (object, optional)
 * @param work - `async ({runOperation, allowed, second, lookalike, outside}) => void` (function)
 * @returns Promise of work's result
 */
export async function withLocalFiles({ environment = {}, dependencies = {} } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-local-files-test-")));
  const directories = {
    allowed: join(baseDirectory, "allowed"),
    second: join(baseDirectory, "second"),
    lookalike: join(baseDirectory, "allowed-evil"),
    outside: join(baseDirectory, "outside"),
  };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const definition = createPluginDefinition(dependencies);
  const runOperation = createOperationRunner(definition, {
    LOCAL_FILES_ALLOWED_DIRS: `${directories.allowed},${directories.second}`,
    ...environment,
  });
  try {
    return await work({ runOperation, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

/**
 * Makes a FIFO with the system `mkfifo` (the test's own call, never the plugin's).
 *
 * @param fifoPath - Where to create it (string)
 */
export function makeFifo(fifoPath) {
  execFileSync("mkfifo", [fifoPath]);
}
