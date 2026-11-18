/**
 * Runs the shared tests and every plugin's tests, and checks that copied
 * shared code and generated manifests are up to date.
 *
 * Usage: node scripts/run-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./plugins.mjs";

const testDirectories = readdirSync(REPO_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, entry.name, "test")))
  .map((entry) => join(REPO_ROOT, entry.name));

const syncCheck = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "sync-shared.mjs"), "--check"], { stdio: "inherit" });
let failedSuites = syncCheck.status === 0 ? 0 : 1;

for (const testDirectory of testDirectories) {
  const testFiles = readdirSync(join(testDirectory, "test")).filter((fileName) => fileName.endsWith(".test.mjs"));
  console.error(`\n== ${testDirectory.slice(REPO_ROOT.length + 1)} (${testFiles.length} files)`);
  const testRun = spawnSync(process.execPath, ["--test", "--test-reporter=dot", ...testFiles.map((fileName) => join("test", fileName))], {
    cwd: testDirectory,
    stdio: "inherit",
  });
  if (testRun.status !== 0) failedSuites += 1;
}

if (failedSuites > 0) {
  console.error(`\n${failedSuites} suite(s) failed`);
  process.exit(1);
}
console.error("\nAll suites passed");
