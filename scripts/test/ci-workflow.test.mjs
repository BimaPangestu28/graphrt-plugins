import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";

/**
 * Reads the path patterns of the `wasm` filter in ci.yml: the list under the `filters` of the step with `id: wasm`.
 * Pull requests run the WebAssembly job only when they touch one of them.
 *
 * @returns The quoted patterns, in file order (string[])
 */
function readWasmFilterPatterns() {
  const workflowText = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const stepStart = workflowText.indexOf("id: wasm\n");
  assert.notEqual(stepStart, -1, "ci.yml has no step with `id: wasm`");
  const patterns = [];
  let inWasmFilter = false;
  for (const line of workflowText.slice(stepStart).split("\n").slice(1)) {
    if (/^\s+wasm:\s*$/.test(line)) {
      inWasmFilter = true;
      continue;
    }
    if (!inWasmFilter) continue;
    const patternMatch = /^\s+- '([^']+)'\s*$/.exec(line);
    if (!patternMatch) break;
    patterns.push(patternMatch[1]);
  }
  return patterns;
}

test("the ci.yml wasm path filter covers every plugin with a WebAssembly build", () => {
  const patterns = readWasmFilterPatterns();
  const builtPlugins = Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, "wasm", "builds.json"), "utf8")));
  assert.ok(builtPlugins.length > 0, "wasm/builds.json lists no plugins");
  for (const required of ["wasm/**", "shared/**", ".github/workflows/ci.yml", ...builtPlugins.map((pluginName) => `${pluginName}/**`)]) {
    assert.ok(patterns.includes(required), `ci.yml wasm filter is missing '${required}'`);
  }
});

test("the ci.yml gate job `ci-ok` waits for every other job and always reports", () => {
  const workflowText = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobsStart = workflowText.indexOf("\njobs:\n");
  assert.notEqual(jobsStart, -1, "ci.yml has no `jobs:` section");
  const jobsText = workflowText.slice(jobsStart);
  const jobIds = [...jobsText.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((jobMatch) => jobMatch[1]);
  assert.ok(jobIds.includes("ci-ok"), "ci.yml has no `ci-ok` job");

  const gateText = jobsText.slice(jobsText.indexOf("\n  ci-ok:\n"));
  // The ruleset requires the check by this name, so it must not change.
  assert.match(gateText, /^ {4}name: ci-ok$/m);
  assert.match(gateText, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
  const needsMatch = /^ {4}needs: \[([^\]]*)\]$/m.exec(gateText);
  assert.ok(needsMatch, "`ci-ok` has no inline `needs` list");
  const neededJobIds = needsMatch[1].split(",").map((jobId) => jobId.trim());
  assert.deepEqual(
    [...neededJobIds].sort(),
    jobIds.filter((jobId) => jobId !== "ci-ok").sort(),
    "`ci-ok` must need every other job in ci.yml",
  );
  assert.match(workflowText, /^ {2}merge_group:\s*$/m, "ci.yml must run for merge queue entries");
});

test("the release workflow tells skill tags from plugin tags and never treats a skill as a plugin", () => {
  const workflowText = readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
  const skillBranchStart = workflowText.indexOf('if [ "$EVENT_NAME" = "push" ] && [[ "$REF_NAME" == skill-* ]]; then');
  const pluginBranchStart = workflowText.indexOf('elif [ "$EVENT_NAME" = "push" ]; then');
  assert.ok(skillBranchStart !== -1 && pluginBranchStart > skillBranchStart, "a skill-<name>-v<version> tag is handled before the plugin branch");
  const skillBranch = workflowText.slice(skillBranchStart, pluginBranchStart);
  assert.match(skillBranch, /node scripts\/read-skill-version\.mjs "\$skill_name"/);
  assert.match(skillBranch, /publish_args\+=\(--skills-only\)/);
  assert.doesNotMatch(skillBranch, /read-manifest-version/);
  // The tag text only ever reaches scripts as a quoted argument, never as code.
  assert.doesNotMatch(workflowText, /node -e/);
});
