import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMUNITY_GRAPHRT_OPT_IN_VARIABLE, selectCommunityGraphrtBinary } from "../lib/community-ingest.mjs";
import { buildIsolatedEnvironment } from "../lib/isolated-environment.mjs";
import { runTestSuite } from "../lib/plugin-test-runner.mjs";

test("an isolated environment keeps PATH and drops tokens and the maintainer's HOME", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "isolated-env-test-"));
  const savedToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_test_secret";
  try {
    const environment = buildIsolatedEnvironment(homeDirectory);
    assert.equal(environment.PATH, process.env.PATH);
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.HOME, homeDirectory);
    assert.equal(environment.XDG_CONFIG_HOME, join(homeDirectory, ".config"));
    assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  } finally {
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test("plugin test suites run without GH_TOKEN and with a temporary HOME", () => {
  const pluginDirectory = mkdtempSync(join(tmpdir(), "isolated-suite-test-"));
  const savedToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_test_secret";
  try {
    mkdirSync(join(pluginDirectory, "test"));
    writeFileSync(join(pluginDirectory, "test", "environment.test.mjs"), [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("isolated", () => {',
      "  assert.equal(process.env.GH_TOKEN, undefined);",
      `  assert.notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME)});`,
      '  assert.match(process.env.HOME, /graphrt-plugin-tests-home-/);',
      "});",
      "",
    ].join("\n"));
    assert.equal(runTestSuite(pluginDirectory, { stdio: "ignore" }), true);
  } finally {
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
    rmSync(pluginDirectory, { recursive: true, force: true });
  }
});

test("the graphrt check of community tarballs is opt-in, with a warning", () => {
  const logLines = [];
  const log = (line) => logLines.push(line);
  assert.equal(selectCommunityGraphrtBinary({}, log), null);
  assert.deepEqual(logLines, []);
  assert.equal(selectCommunityGraphrtBinary({ GRAPHRT_BIN: "/usr/bin/graphrt" }, log), null);
  assert.match(logLines.pop(), new RegExp(`not run on community tarballs.*${COMMUNITY_GRAPHRT_OPT_IN_VARIABLE}=1`));
  assert.equal(selectCommunityGraphrtBinary({ GRAPHRT_BIN: "/usr/bin/graphrt", [COMMUNITY_GRAPHRT_OPT_IN_VARIABLE]: "1" }, log), "/usr/bin/graphrt");
  assert.match(logLines.pop(), /warning: .*runs untrusted community code.*VM or a container/);
});
