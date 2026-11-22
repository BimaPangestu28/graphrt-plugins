/**
 * Runs a plugin's own test suite for the publish step, with an isolated environment: the publish holds GH_TOKEN
 * (release write access), and plugin tests must neither see it nor read the maintainer's gh, git or npm
 * configuration.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIsolatedEnvironment } from "./isolated-environment.mjs";

/**
 * Runs `node --test test/*.test.mjs` in a plugin directory.
 *
 * @param directory - Plugin (or `shared`) directory (string)
 * @param options - Run options
 * @param options.stdio - stdio of the test run (string|array, default "inherit")
 * @returns True when there is no `test/` directory or every test passes (boolean)
 */
export function runTestSuite(directory, { stdio = "inherit" } = {}) {
  if (!existsSync(join(directory, "test"))) return true;
  const homeDirectory = mkdtempSync(join(tmpdir(), "graphrt-plugin-tests-home-"));
  try {
    const environment = buildIsolatedEnvironment(homeDirectory);
    const result = spawnSync("sh", ["-c", `"${process.execPath}" --test --test-reporter=dot test/*.test.mjs`], { cwd: directory, stdio, env: environment });
    return result.status === 0;
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true });
  }
}
