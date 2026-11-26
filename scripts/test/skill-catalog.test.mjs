import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { signCatalogIndexes, verifyFileSignature } from "../lib/catalog-signing.mjs";
import { buildCatalogEntry, sha256Hex } from "../lib/plugin-package.mjs";
import { buildSkillCatalogEntry, describeSkillTarballBytes, listSkillNames, packSkill, skillTarballNameFor } from "../lib/skill-package.mjs";
import { SKILL_KIND, readSkillVersion, releaseSkills, renderSkillReleaseNotes } from "../lib/skill-release.mjs";
import { fitCommunityPluginsIntoCatalog, measureCatalogSizes, writeCatalogFiles } from "../pack-plugins.mjs";
import { REPO_ROOT } from "../plugins.mjs";

const minisignAvailable = spawnSync("minisign", ["-v"], { encoding: "utf8" }).status === 0;
const skipWithoutMinisign = minisignAvailable ? false : "minisign is not installed";
/** The fields graphrt-builder-desktop reads from a `skills[]` entry (`plugins/models.rs`, `CatalogSkill`), in entry order. */
const DESKTOP_SKILL_FIELDS = ["name", "display_name", "version", "description", "tarball_url", "sha256", "size_bytes", "publisher"];
/** Where the desktop app accepts archives of this catalog: under the release assets of the catalog's repository. */
const RELEASE_ASSET_PREFIX = "https://github.com/Graphrt/graphrt-plugins/releases/download/";

function withScratchDirectory(action) {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "skill-catalog-test-"));
  try {
    return action(scratchDirectory);
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

function releasedOfficialPlugin(pluginName) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pluginName, "graphrt-plugin.json"), "utf8"));
  const released = { tarballName: `${pluginName}-${manifest.version}.tar.gz`, sha256: "a".repeat(64), sizeBytes: 1, manifest };
  return { ...released, catalogEntry: buildCatalogEntry(manifest, released) };
}

const skillText = (name, { version = "1.0.0", displayName = "Sample Skill", body = "Do the thing.\n" } = {}) =>
  `---\nname: ${name}\ndescription: Does the ${name} thing. Use when someone asks for it.\nmetadata:\n  version: "${version}"\n  display_name: ${displayName}\n---\n\n${body}`;

function git(repositoryDirectory, ...gitArguments) {
  const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];
  const gitResult = spawnSync("git", [...identity, ...gitArguments], { cwd: repositoryDirectory, encoding: "utf8" });
  assert.equal(gitResult.status, 0, gitResult.stderr);
  return gitResult.stdout;
}

function writeFiles(repositoryDirectory, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repositoryDirectory, relativePath)), { recursive: true });
    writeFileSync(join(repositoryDirectory, relativePath), content);
  }
}

function createSkillRepository(repositoryDirectory, files) {
  writeFiles(repositoryDirectory, files);
  git(repositoryDirectory, "init", "-q");
  git(repositoryDirectory, "add", "-A");
  git(repositoryDirectory, "commit", "-q", "-m", "skills");
  return repositoryDirectory;
}

/** The released form of every skill of this repository, packed into `outputDirectory`. */
function releasedRepositorySkills(outputDirectory) {
  return listSkillNames().map((skillName) => {
    const packed = packSkill(skillName, { outputDirectory });
    const described = describeSkillTarballBytes(packed.tarballName, readFileSync(packed.tarballPath));
    return { name: skillName, version: packed.version, tarballName: packed.tarballName, sha256: packed.sha256, sizeBytes: packed.sizeBytes, catalogEntry: buildSkillCatalogEntry(described) };
  });
}

/** An in-memory stand-in for the GitHub releases of the repository, recording what a publish did. */
function fakeReleases(published = {}) {
  const assetsByTag = new Map(Object.entries(published).map(([tag, assets]) => [tag, new Map(Object.entries(assets))]));
  const calls = [];
  return {
    calls,
    assetsByTag,
    planAction(tag, assetName) {
      if (!assetsByTag.has(tag)) return "create";
      return assetsByTag.get(tag).has(assetName) ? "exists" : "upload";
    },
    downloadAsset(tag, assetName) {
      calls.push(`download ${tag}`);
      return assetsByTag.get(tag).get(assetName);
    },
    createRelease(packed, notes) {
      calls.push(`create ${packed.tag}`);
      assert.match(notes, new RegExp(`sha256: \`${packed.sha256}\``));
      assetsByTag.set(packed.tag, new Map([[packed.tarballName, readFileSync(packed.tarballPath)]]));
    },
    uploadAsset(tag, tarballPath) {
      calls.push(`upload ${tag}`);
      assetsByTag.get(tag).set(basename(tarballPath), readFileSync(tarballPath));
    },
  };
}

test("index-v2.json lists the skills in the format the desktop app reads; index.json and the plugins are unchanged", () => {
  withScratchDirectory((scratchDirectory) => {
    const releasedPlugins = ["currency-rates", "open-meteo"].map(releasedOfficialPlugin);
    const releasedSkills = releasedRepositorySkills(join(scratchDirectory, "skills"));
    assert.ok(releasedSkills.length >= 3);
    const withSkills = writeCatalogFiles(join(scratchDirectory, "with"), releasedPlugins, { releasedSkills: [...releasedSkills].reverse() });
    const withoutSkills = writeCatalogFiles(join(scratchDirectory, "without"), releasedPlugins);
    const read = (path) => JSON.parse(readFileSync(path, "utf8"));
    const [v2, v1, plainV2, plainV1] = [withSkills.indexV2Path, withSkills.indexPath, withoutSkills.indexV2Path, withoutSkills.indexPath].map(read);

    assert.deepEqual(Object.keys(v2), ["schema", "generated_at", "plugins", "skills"]);
    assert.deepEqual(v2.skills.map((skill) => skill.name), listSkillNames(), "sorted by name");
    for (const [index, skill] of v2.skills.entries()) {
      assert.deepEqual(Object.keys(skill), DESKTOP_SKILL_FIELDS);
      const released = releasedSkills[index];
      assert.equal(skill.tarball_url, `${RELEASE_ASSET_PREFIX}skill-${skill.name}-v${skill.version}/skill-${skill.name}-${skill.version}.tar.gz`);
      assert.equal(skill.sha256, sha256Hex(readFileSync(join(scratchDirectory, "skills", released.tarballName))));
      assert.equal(skill.size_bytes, readFileSync(join(scratchDirectory, "skills", released.tarballName)).length);
      assert.match(skill.version, /^\d+\.\d+\.\d+$/);
      assert.equal(skill.publisher, "graphrt");
      assert.ok(skill.display_name.length > 0 && skill.display_name.length <= 60);
      assert.ok(skill.description.length > 0 && skill.description.length <= 1024);
    }

    // A reader that does not know `skills` sees exactly the catalog it saw before.
    assert.deepEqual(v2.plugins, plainV2.plugins);
    assert.deepEqual(Object.keys(plainV2), ["schema", "generated_at", "plugins"]);
    assert.deepEqual(Object.keys(v1), ["schema", "generated_at", "plugins"], "index.json never lists skills");
    assert.deepEqual(v1.plugins, plainV1.plugins);
    assert.equal(v1.schema, 1);
    assert.equal(v2.schema, 2);

    const sums = readFileSync(withSkills.sumsPath, "utf8");
    for (const { tarballName, sha256 } of releasedSkills) assert.ok(sums.includes(`${sha256}  ${tarballName}\n`), tarballName);
    assert.ok(sums.includes(`${sha256Hex(readFileSync(withSkills.indexV2Path))}  index-v2.json\n`));
    assert.equal(readFileSync(withoutSkills.sumsPath, "utf8").includes("skill-"), false);
  });
});

test("an empty skill list is published as `skills: []`, and no list as no field", () => {
  withScratchDirectory((scratchDirectory) => {
    const releasedPlugins = [releasedOfficialPlugin("currency-rates")];
    const emptyList = JSON.parse(readFileSync(writeCatalogFiles(join(scratchDirectory, "empty"), releasedPlugins, { releasedSkills: [] }).indexV2Path, "utf8"));
    assert.deepEqual(emptyList.skills, []);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(writeCatalogFiles(join(scratchDirectory, "none"), releasedPlugins).indexV2Path, "utf8")), "skills"), false);
  });
});

test("the skills are covered by the index signature", { skip: skipWithoutMinisign }, () => {
  withScratchDirectory((scratchDirectory) => {
    const keyPath = join(scratchDirectory, "throwaway.key");
    const publicKeyPath = join(scratchDirectory, "throwaway.pub");
    assert.equal(spawnSync("minisign", ["-G", "-W", "-p", publicKeyPath, "-s", keyPath], { stdio: "ignore" }).status, 0);
    const signIndexes = (indexes) => signCatalogIndexes(indexes, { keyPath, publicKeyPath, log: () => {} });
    const releasedSkills = releasedRepositorySkills(join(scratchDirectory, "skills"));
    const catalogFiles = writeCatalogFiles(join(scratchDirectory, "catalog"), [releasedOfficialPlugin("currency-rates")], { signIndexes, releasedSkills });
    assert.doesNotThrow(() => verifyFileSignature(catalogFiles.indexV2Path, { publicKeyPath }));
    // Pointing a skill at another archive (a different checksum) breaks the signature.
    const signedText = readFileSync(catalogFiles.indexV2Path, "utf8");
    const tamperedText = signedText.replace(releasedSkills[0].sha256, "f".repeat(64));
    assert.notEqual(tamperedText, signedText);
    writeFileSync(catalogFiles.indexV2Path, tamperedText);
    assert.throws(() => verifyFileSignature(catalogFiles.indexV2Path, { publicKeyPath }), /verifying .*index-v2\.json\.minisig .* failed/);
    writeFileSync(catalogFiles.indexV2Path, signedText);
    appendFileSync(catalogFiles.indexV2Path, " ");
    assert.throws(() => verifyFileSignature(catalogFiles.indexV2Path, { publicKeyPath }), /failed/);
  });
});

test("skill entries count toward the index-v2.json limit and never toward index.json", () => {
  const releasedPlugins = ["currency-rates", "open-meteo"].map(releasedOfficialPlugin);
  const generatedAt = new Date(0);
  const skillEntries = [{ name: "sample", display_name: "Sample", version: "1.0.0", description: "x".repeat(1024), tarball_url: `${RELEASE_ASSET_PREFIX}skill-sample-v1.0.0/skill-sample-1.0.0.tar.gz`, sha256: "a".repeat(64), size_bytes: 1, publisher: "graphrt" }];
  const plain = measureCatalogSizes(releasedPlugins, generatedAt);
  const withSkills = measureCatalogSizes(releasedPlugins, generatedAt, skillEntries);
  assert.equal(withSkills.v1FullBytes, plain.v1FullBytes);
  assert.equal(withSkills.v1StrippedBytes, plain.v1StrippedBytes);
  assert.equal(withSkills.v2Bytes, plain.v2Bytes + Buffer.byteLength(`,"skills":${JSON.stringify(skillEntries)}`));
  // Official plugins and skills are never dropped to make room.
  assert.deepEqual(fitCommunityPluginsIntoCatalog(releasedPlugins, { generatedAt, skillEntries, maxV2Bytes: 1 }), { kept: releasedPlugins, dropped: [] });
  withScratchDirectory((scratchDirectory) => {
    const releasedSkills = [{ tarballName: "skill-sample-1.0.0.tar.gz", sha256: "a".repeat(64), catalogEntry: skillEntries[0] }];
    assert.throws(() => writeCatalogFiles(scratchDirectory, releasedPlugins, { releasedSkills, maxV1Bytes: 1 }), /index\.json is \d+ bytes/);
  });
});

test("a publish releases each new skill version once and lists what is published", () => {
  withScratchDirectory((scratchDirectory) => {
    const repositoryRoot = createSkillRepository(join(scratchDirectory, "repo"), {
      "skills/alpha/SKILL.md": skillText("alpha"),
      "skills/beta/SKILL.md": skillText("beta", { version: "2.1.0" }),
      "skills/beta/references/table.md": "| a | b |\n",
    });
    const outputDirectory = join(scratchDirectory, "out");
    const releases = fakeReleases();
    const first = releaseSkills({ outputDirectory, releases, repositoryRoot, log: () => {} });
    assert.deepEqual(releases.calls, ["create skill-alpha-v1.0.0", "create skill-beta-v2.1.0"]);
    assert.deepEqual(first.skipped, []);
    assert.deepEqual(first.released.map(({ name, version, tarballName }) => [name, version, tarballName]), [["alpha", "1.0.0", "skill-alpha-1.0.0.tar.gz"], ["beta", "2.1.0", "skill-beta-2.1.0.tar.gz"]]);
    for (const released of first.released) {
      const publishedBytes = releases.assetsByTag.get(`skill-${released.name}-v${released.version}`).get(released.tarballName);
      assert.equal(released.sha256, sha256Hex(publishedBytes));
      assert.equal(released.catalogEntry.sha256, released.sha256);
      assert.equal(released.catalogEntry.size_bytes, publishedBytes.length);
    }

    // A second run changes nothing and lists the same entries, from the published archives.
    releases.calls.length = 0;
    const second = releaseSkills({ outputDirectory, releases, repositoryRoot, log: () => {} });
    assert.deepEqual(releases.calls, ["download skill-alpha-v1.0.0", "download skill-beta-v2.1.0"]);
    assert.deepEqual(second, first);

    // An edit without a version bump never replaces the release: the catalog keeps describing what was published.
    writeFiles(repositoryRoot, { "skills/alpha/SKILL.md": skillText("alpha", { displayName: "Renamed", body: "Do another thing.\n" }) });
    git(repositoryRoot, "commit", "-q", "-am", "edit without bump");
    releases.calls.length = 0;
    const logLines = [];
    const third = releaseSkills({ outputDirectory, releases, repositoryRoot, log: (line) => logLines.push(line) });
    assert.deepEqual(releases.calls, ["download skill-alpha-v1.0.0", "download skill-beta-v2.1.0"]);
    assert.deepEqual(third.released, first.released);
    assert.match(logLines.join("\n"), /skill-alpha-v1\.0\.0: already published, differs from the local build \(bump metadata\.version to ship changes\)/);

    // The bump ships it as a new release; the old one stays.
    writeFiles(repositoryRoot, { "skills/alpha/SKILL.md": skillText("alpha", { version: "1.1.0", displayName: "Renamed" }) });
    git(repositoryRoot, "commit", "-q", "-am", "bump");
    releases.calls.length = 0;
    const fourth = releaseSkills({ outputDirectory, releases, repositoryRoot, log: () => {} });
    assert.deepEqual(releases.calls, ["create skill-alpha-v1.1.0", "download skill-beta-v2.1.0"]);
    assert.deepEqual(fourth.released.map(({ catalogEntry }) => [catalogEntry.name, catalogEntry.version, catalogEntry.display_name]), [["alpha", "1.1.0", "Renamed"], ["beta", "2.1.0", "Sample Skill"]]);
    assert.ok(releases.assetsByTag.has("skill-alpha-v1.0.0"));
  });
});

test("a dry run and --catalog-only create nothing; a half-created release is resumed", () => {
  withScratchDirectory((scratchDirectory) => {
    const repositoryRoot = createSkillRepository(join(scratchDirectory, "repo"), { "skills/alpha/SKILL.md": skillText("alpha"), "skills/beta/SKILL.md": skillText("beta") });
    const outputDirectory = join(scratchDirectory, "out");
    const dryReleases = fakeReleases();
    const dryRun = releaseSkills({ outputDirectory, dryRun: true, releases: dryReleases, repositoryRoot, log: () => {} });
    assert.deepEqual(dryReleases.calls, []);
    assert.deepEqual(dryRun.released.map(({ name }) => name), ["alpha", "beta"], "a dry run lists what a publish would");

    const alphaBytes = readFileSync(join(outputDirectory, "skill-alpha-1.0.0.tar.gz"));
    const releases = fakeReleases({ "skill-alpha-v1.0.0": { "skill-alpha-1.0.0.tar.gz": alphaBytes }, "skill-beta-v1.0.0": {} });
    const catalogOnly = releaseSkills({ outputDirectory: join(scratchDirectory, "catalog-only"), catalogOnly: true, releases, repositoryRoot, log: () => {} });
    assert.deepEqual(releases.calls, ["download skill-alpha-v1.0.0"]);
    assert.deepEqual(catalogOnly.released.map(({ name }) => name), ["alpha"], "only what is published is listed");
    assert.deepEqual(catalogOnly.skipped, []);
    assert.equal(existsSync(join(scratchDirectory, "catalog-only")), false, "nothing is packed");

    releases.calls.length = 0;
    const resumed = releaseSkills({ outputDirectory, releases, repositoryRoot, log: () => {} });
    assert.deepEqual(releases.calls, ["download skill-alpha-v1.0.0", "upload skill-beta-v1.0.0"]);
    assert.deepEqual(resumed.released.map(({ name }) => name), ["alpha", "beta"]);
  });
});

test("a skill that fails its checks is skipped with its reason; the others are still released", () => {
  withScratchDirectory((scratchDirectory) => {
    const repositoryRoot = createSkillRepository(join(scratchDirectory, "repo"), {
      "skills/alpha/SKILL.md": skillText("alpha"),
      "skills/broken/SKILL.md": skillText("broken").replace("  version: \"1.0.0\"\n", ""),
      "skills/scripted/SKILL.md": skillText("scripted"),
      "skills/scripted/scripts/run.sh": "echo never run\n",
      "skills/dirty/SKILL.md": skillText("dirty"),
      "skills/tampered/SKILL.md": skillText("tampered"),
    });
    const outputDirectory = join(scratchDirectory, "out");
    const tamperedArchive = (() => {
      const packed = packSkill("alpha", { outputDirectory: join(scratchDirectory, "other"), repositoryRoot });
      return readFileSync(packed.tarballPath);
    })();
    const releases = fakeReleases({ "skill-tampered-v1.0.0": { "skill-tampered-1.0.0.tar.gz": tamperedArchive } });
    const assertCommitted = (repositoryPath) => {
      if (repositoryPath === "skills/dirty") throw new Error("skills/dirty: uncommitted changes");
    };
    const result = releaseSkills({ outputDirectory, releases, assertCommitted, repositoryRoot, log: () => {} });
    assert.deepEqual(result.released.map(({ name }) => name), ["alpha"]);
    assert.deepEqual(releases.calls, ["create skill-alpha-v1.0.0", "download skill-tampered-v1.0.0"]);
    const reasonOf = (skillName) => result.skipped.find(({ name }) => name === skillName).reason;
    assert.deepEqual(result.skipped.map(({ name, kind }) => [name, kind]), [["broken", SKILL_KIND], ["dirty", SKILL_KIND], ["scripted", SKILL_KIND], ["tampered", SKILL_KIND]]);
    assert.match(reasonOf("broken"), /needs `metadata\.version`/);
    assert.match(reasonOf("dirty"), /uncommitted changes/);
    assert.match(reasonOf("scripted"), /catalog skills ship no `scripts\/`/);
    assert.match(reasonOf("tampered"), /expected the name skill-alpha-1\.0\.0\.tar\.gz|holds the skill alpha/);
    // Only skills that passed their source checks were packed at all.
    assert.deepEqual(readdirSync(outputDirectory).sort(), ["skill-alpha-1.0.0.tar.gz", "skill-tampered-1.0.0.tar.gz"]);
  });
});

test("a failing GitHub command stops the publish instead of silently dropping a listed skill", () => {
  withScratchDirectory((scratchDirectory) => {
    const repositoryRoot = createSkillRepository(join(scratchDirectory, "repo"), { "skills/alpha/SKILL.md": skillText("alpha") });
    const releases = { ...fakeReleases(), planAction: () => { throw new Error("gh release view failed: HTTP 502"); } };
    assert.throws(() => releaseSkills({ outputDirectory: join(scratchDirectory, "out"), releases, repositoryRoot, log: () => {} }), /HTTP 502/);
    const failingCreate = { ...fakeReleases(), createRelease: () => { throw new Error("gh release create failed"); } };
    assert.throws(() => releaseSkills({ outputDirectory: join(scratchDirectory, "out"), releases: failingCreate, repositoryRoot, log: () => {} }), /gh release create failed/);
  });
});

test("reads a skill's version for the release workflow, refusing names that are not skill names", () => {
  for (const skillName of listSkillNames()) assert.match(readSkillVersion(skillName), /^\d+\.\d+\.\d+$/);
  for (const unsafeName of ["../scripts", "a/b", "A", "", "-x", "x y"]) assert.throws(() => readSkillVersion(unsafeName), /is not a skill name/, unsafeName);
  assert.throws(() => readSkillVersion("no-such-skill"), /ENOENT/);
  const [firstSkill] = listSkillNames();
  const cli = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "read-skill-version.mjs"), firstSkill], { encoding: "utf8" });
  assert.deepEqual([cli.status, cli.stdout.trim()], [0, readSkillVersion(firstSkill)]);
  const refused = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "read-skill-version.mjs"), "$(touch pwned)"], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /read-skill-version: .* is not a skill name/);
});

test("release notes say what the skill asks for and that nothing in it is run", () => {
  const notes = renderSkillReleaseNotes({ tarballName: skillTarballNameFor("sample", "1.0.0"), sha256: "a".repeat(64), sizeBytes: 10, skill: { name: "sample", version: "1.0.0", displayName: "Sample", description: "Does a thing.", allowedTools: ["orders/lookup"] } });
  assert.match(notes, /Agent skill \*\*Sample\*\* \(`sample`\) 1\.0\.0\./);
  assert.match(notes, /- `orders\/lookup`/);
  assert.match(notes, /nothing in it is run/);
  assert.match(renderSkillReleaseNotes({ tarballName: "x", sha256: "a", sizeBytes: 1, skill: { name: "s", version: "1.0.0", displayName: "S", description: "d", allowedTools: [] } }), /It asks for no tools\./);
});

test("the checks pull requests and releases run accept this repository's skills", () => {
  const strict = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "check-skills.mjs")], { encoding: "utf8" });
  assert.equal(strict.status, 0, strict.stderr);
  assert.match(strict.stderr, /\d+ skill\(s\) under skills\/ are valid\./);
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.match(packageJson.scripts.check, /node scripts\/check-skills\.mjs &&/, "pull requests get the strict check");
  assert.match(packageJson.scripts["check:release"], /node scripts\/check-skills\.mjs --lenient &&/, "a release skips an invalid skill instead of failing");
});

test("the strict check fails a pull request with an invalid skill; the lenient one annotates and lets the release go on", () => {
  withScratchDirectory((scratchDirectory) => {
    const repositoryRoot = createSkillRepository(scratchDirectory, {
      "skills/alpha/SKILL.md": skillText("alpha"),
      "skills/scripted/SKILL.md": skillText("scripted"),
      "skills/scripted/scripts/run.sh": "echo never run\n",
    });
    const check = (...flags) => spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "check-skills.mjs"), "--root", repositoryRoot, ...flags], { encoding: "utf8" });
    const strict = check();
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /skills\/ is invalid:\n {2}skills\/scripted: `scripts\/run\.sh`: catalog skills ship no `scripts\/`/);
    const lenient = check("--lenient");
    assert.equal(lenient.status, 0);
    assert.match(lenient.stdout, /^::error title=skill scripted::skills\/scripted: .*\(the publish skips an invalid skill\)$/m);
    rmSync(join(repositoryRoot, "skills", "scripted"), { recursive: true });
    assert.equal(check().status, 0);
  });
});
