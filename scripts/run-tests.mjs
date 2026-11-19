/**
 * Runs the shared tests and every plugin's tests, checks that copied
 * shared code, generated manifests and status labels are up to date, and that no manifest
 * declares a node parameter graphrt reserves.
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
const statusLabelCheck = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "sync-plugin-status.mjs"), "--check"], { stdio: "inherit" });
const reservedParameterCheck = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "check-reserved-parameters.mjs")], { stdio: "inherit" });
let failedSuites = [syncCheck, statusLabelCheck, reservedParameterCheck].filter((check) => check.status !== 0).length;

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
