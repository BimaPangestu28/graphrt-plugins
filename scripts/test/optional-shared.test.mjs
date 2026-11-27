import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOptionalSharedFiles } from "../lib/optional-shared.mjs";
import { REPO_ROOT } from "../plugins.mjs";

function withRepository(pluginsByFile, files, work) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "graphrt-optional-shared-"));
  try {
    const optionalDirectory = join(repositoryRoot, "shared", "optional");
    mkdirSync(optionalDirectory, { recursive: true });
    for (const pluginName of ["alpha", "beta"]) {
      mkdirSync(join(repositoryRoot, pluginName));
      writeFileSync(join(repositoryRoot, pluginName, "definition.mjs"), "");
    }
    for (const [relativePath, content] of Object.entries(files)) {
      mkdirSync(join(optionalDirectory, relativePath, ".."), { recursive: true });
      writeFileSync(join(optionalDirectory, relativePath), content);
    }
    if (pluginsByFile) writeFileSync(join(optionalDirectory, "plugins.json"), JSON.stringify(pluginsByFile));
    return work(optionalDirectory, repositoryRoot);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
}

test("each optional shared file goes to the plugins plugins.json names, and nowhere without the list", () => {
  withRepository({ "lib/tool.mjs": ["beta", "alpha"], "test/tool.test.mjs": ["alpha"] }, { "lib/tool.mjs": "export {};\n", "test/tool.test.mjs": "// test\n" }, (optionalDirectory, repositoryRoot) => {
    assert.deepEqual(readOptionalSharedFiles(optionalDirectory, repositoryRoot), [
      { relativePath: "lib/tool.mjs", content: "export {};\n", pluginDirectories: [join(repositoryRoot, "beta"), join(repositoryRoot, "alpha")] },
      { relativePath: "test/tool.test.mjs", content: "// test\n", pluginDirectories: [join(repositoryRoot, "alpha")] },
    ]);
  });
  withRepository(null, {}, (optionalDirectory, repositoryRoot) => assert.deepEqual(readOptionalSharedFiles(optionalDirectory, repositoryRoot), []));
});

test("a list that is wrong is refused: unlisted or missing file, unknown plugin, a path that leaves lib/ and test/", () => {
  const refused = (pluginsByFile, files, pattern) => withRepository(pluginsByFile, files, (optionalDirectory, repositoryRoot) => assert.throws(() => readOptionalSharedFiles(optionalDirectory, repositoryRoot), pattern));
  refused({}, { "lib/forgotten.mjs": "" }, /does not say which plugins get lib\/forgotten\.mjs/);
  refused({ "lib/gone.mjs": ["alpha"] }, {}, /lib\/gone\.mjs is listed in plugins\.json but does not exist/);
  refused({ "lib/tool.mjs": ["ghost"] }, { "lib/tool.mjs": "" }, /"ghost", which is not a plugin/);
  refused({ "lib/tool.mjs": [] }, { "lib/tool.mjs": "" }, /must name at least one plugin/);
  refused({ "../alpha/plugin.mjs": ["alpha"] }, {}, /must be a \.mjs file directly in lib\/ or test\//);
  refused({ "lib/shared/operations.mjs": ["alpha"] }, {}, /must be a \.mjs file directly in lib\/ or test\//);
});

test("the copies in this repository are the files of shared/optional", () => {
  const optionalFiles = readOptionalSharedFiles(join(REPO_ROOT, "shared", "optional"), REPO_ROOT);
  assert.ok(optionalFiles.length > 0);
  for (const { relativePath, content, pluginDirectories } of optionalFiles) {
    for (const pluginDirectory of pluginDirectories) assert.equal(readFileSync(join(pluginDirectory, relativePath), "utf8"), content, `${pluginDirectory}/${relativePath}: run npm run sync`);
  }
});
