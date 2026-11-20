/**
 * Publishes plugin releases and refreshes the `catalog` release.
 *
 * Usage: node scripts/publish-plugins.mjs [plugin-name...] [--target <git ref>] [--out <dir>] [--dry-run] [--catalog-only]
 *   plugin-name  plugins to consider (default: all)
 *   --target     commit new release tags point at (default: HEAD); plugin files must
 *                be identical between this commit and the working tree
 *   --out        working directory for tarballs and catalog files (default: dist)
 *   --dry-run    pack, test and verify, print what would be published, change nothing
 *   --catalog-only  skip testing, packing and plugin releases: rebuild `index.json` and
 *                `SHA256SUMS` from the already-published tarballs (their own manifests and
 *                READMEs) and upload them with any new icons. Refuses when a plugin in the live
 *                catalog would be dropped or change version, sha256, size or URL. Use it after
 *                changing the catalog format, a status or an icon; combine with --dry-run to only
 *                write the files.
 *
 * Steps: check generated files are in sync, run each plugin's tests (failing plugins
 * are skipped), pack and verify tarballs, create every missing `<name>-v<version>`
 * release (pre-release for 0.x), then rebuild `index.json` and `SHA256SUMS` from the
 * assets that are actually published and upload them to the `catalog` release, after the
 * plugin icons (`<plugin>/icon.svg`, uploaded as content-addressed `icon-<plugin>-<hash>.svg`
 * assets of the same release; old ones are kept so older catalogs' `icon_url`s still resolve).
 * Existing plugin releases are never modified: bump the version to ship a change.
 *
 * Needs an authenticated `gh` (GH_TOKEN in CI). Set GRAPHRT_BIN to also check each
 * tarball with `graphrt plugin install` into a temporary directory.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { REPO_ROOT, findSharedPlugins } from "./plugins.mjs";
import { packPlugins, writeCatalogFiles } from "./pack-plugins.mjs";
import { verifyTarball } from "./verify-plugins.mjs";
import {
  CATALOG_TAG, MANIFEST_FILE_NAME, RELEASE_REPOSITORY, buildCatalogEntry, describeTarballBytes, findCatalogRegressions, listPluginNames,
  releaseAssetUrl, releaseTagFor, tarballNameFor,
} from "./lib/plugin-package.mjs";
import { renderReleaseNotes } from "./lib/release-notes.mjs";

function parsePublishArguments(argumentList) {
  const options = { pluginNames: [], target: "HEAD", outputDirectory: resolve(REPO_ROOT, "dist"), dryRun: false, catalogOnly: false };
  const knownPlugins = listPluginNames();
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--catalog-only") options.catalogOnly = true;
    else if (argument === "--target") options.target = argumentList[++index];
    else if (argument === "--out") options.outputDirectory = resolve(argumentList[++index] ?? "");
    else if (knownPlugins.includes(argument)) options.pluginNames.push(argument);
    else throw new Error(`unknown argument \`${argument}\``);
  }
  if (options.pluginNames.length === 0) options.pluginNames = knownPlugins;
  return options;
}

function runCommand(command, commandArguments, { allowFailure = false, cwd = REPO_ROOT } = {}) {
  const result = spawnSync(command, commandArguments, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${commandArguments.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

const NETWORK_ERROR_PATTERN = /timeout|connection reset|EOF|ECONNRESET|502|503|504/i;
const GH_READ_ATTEMPTS = 3;

/**
 * Runs an idempotent gh command (view, download, upload --clobber), retrying
 * network failures. Release creation is not retried: it is not idempotent.
 */
function runGhIdempotent(ghArguments, { allowFailure = false } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const result = runCommand("gh", ghArguments, { allowFailure: true });
    const isNetworkError = result.status !== 0 && NETWORK_ERROR_PATTERN.test(result.stderr);
    if (isNetworkError && attempt < GH_READ_ATTEMPTS) {
      console.error(`gh ${ghArguments[0]} ${ghArguments[1]}: network error, retrying (${attempt}/${GH_READ_ATTEMPTS - 1})`);
      continue;
    }
    if (result.status !== 0 && !allowFailure) throw new Error(`gh ${ghArguments.slice(0, 3).join(" ")} failed: ${result.stderr.trim()}`);
    return result;
  }
}

function runTestSuite(directory) {
  if (!existsSync(join(directory, "test"))) return true;
  const result = spawnSync("sh", ["-c", "node --test --test-reporter=dot test/*.test.mjs"], { cwd: directory, stdio: "inherit" });
  return result.status === 0;
}

/** Runs each plugin's tests (and the shared tests for shared-based plugins); returns the names that pass. */
function selectPassingPlugins(pluginNames) {
  runCommand(process.execPath, [join(REPO_ROOT, "scripts", "sync-shared.mjs"), "--check"]);
  const sharedTestsPass = runTestSuite(join(REPO_ROOT, "shared"));
  const sharedPluginNames = new Set(findSharedPlugins().map((directory) => directory.slice(REPO_ROOT.length + 1)));
  const skipped = [];
  const passing = pluginNames.filter((pluginName) => {
    console.error(`\n== testing ${pluginName}`);
    const passes = runTestSuite(join(REPO_ROOT, pluginName)) && (sharedTestsPass || !sharedPluginNames.has(pluginName));
    if (!passes) skipped.push({ name: pluginName, reason: "tests failed" });
    return passes;
  });
  return { passing, skipped };
}

function assertPluginMatchesTarget(pluginName, targetCommit) {
  const diff = runCommand("git", ["status", "--porcelain", "--", pluginName]).stdout.trim();
  if (diff) throw new Error(`${pluginName}: uncommitted changes:\n${diff}`);
  const targetDiff = runCommand("git", ["diff", "--quiet", targetCommit, "HEAD", "--", pluginName], { allowFailure: true });
  if (targetDiff.status !== 0) throw new Error(`${pluginName}: files differ between --target ${targetCommit} and HEAD`);
}

function viewRelease(releaseTag) {
  const result = runGhIdempotent(["release", "view", releaseTag, "-R", RELEASE_REPOSITORY, "--json", "tagName,assets,isDraft"], { allowFailure: true });
  if (result.status !== 0) {
    if (/release not found/i.test(result.stderr)) return null;
    throw new Error(`gh release view ${releaseTag} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

/** Downloads a published tarball and describes it from its own bytes, manifest and README. */
function describePublishedTarball(releaseTag, tarballName, outputDirectory) {
  const downloadDirectory = join(outputDirectory, "published", releaseTag);
  mkdirSync(downloadDirectory, { recursive: true });
  runGhIdempotent(["release", "download", releaseTag, "-R", RELEASE_REPOSITORY, "-p", tarballName, "-D", downloadDirectory, "--clobber"]);
  try {
    return describeTarballBytes(tarballName, readFileSync(join(downloadDirectory, tarballName)));
  } catch (error) {
    throw new Error(`${releaseTag}: published ${error.message}`);
  }
}

function createPluginRelease(packed, targetCommit, outputDirectory) {
  const notesPath = join(outputDirectory, `${packed.tag}.notes.md`);
  writeFileSync(notesPath, renderReleaseNotes(packed));
  const releaseArguments = ["release", "create", packed.tag, packed.tarballPath, "-R", RELEASE_REPOSITORY, "--target", targetCommit,
    "--title", `${packed.name} ${packed.version}`, "--notes-file", notesPath, "--latest=false"];
  if (packed.version.startsWith("0.") || packed.version.includes("-")) releaseArguments.push("--prerelease");
  runCommand("gh", releaseArguments);
}

/** Publishes missing releases and returns `{tarballName, sha256, catalogEntry}` for every published plugin. */
function publishPluginReleases(packedPlugins, { targetCommit, outputDirectory, dryRun }) {
  const released = [];
  for (const packed of packedPlugins) {
    const existingRelease = viewRelease(packed.tag);
    const hasAsset = existingRelease?.assets.some((asset) => asset.name === packed.tarballName);
    if (existingRelease && !hasAsset) throw new Error(`${packed.tag}: release exists without ${packed.tarballName}; fix it by hand`);
    if (existingRelease) {
      const published = describePublishedTarball(packed.tag, packed.tarballName, outputDirectory);
      const status = published.sha256 === packed.sha256 ? "unchanged" : "differs from the local build (bump the version to ship changes)";
      console.error(`${packed.tag}: already published, ${status}`);
      released.push({ ...published, catalogEntry: buildCatalogEntry(published.manifest, published) });
      continue;
    }
    console.error(`${packed.tag}: ${dryRun ? "would create" : "creating"} release (${packed.sha256})`);
    if (!dryRun) createPluginRelease(packed, targetCommit, outputDirectory);
    released.push({ ...packed, catalogEntry: buildCatalogEntry(packed.manifest, packed) });
  }
  return released;
}

/** Adds already-published releases of plugins that were not packed this run (e.g. skipped ones). */
function collectOtherPublishedPlugins(packedNames, outputDirectory) {
  const released = [];
  for (const pluginName of listPluginNames().filter((name) => !packedNames.has(name))) {
    const version = JSON.parse(readFileSync(join(REPO_ROOT, pluginName, MANIFEST_FILE_NAME), "utf8")).version;
    const releaseTag = releaseTagFor(pluginName, version);
    if (!viewRelease(releaseTag)) continue;
    const published = describePublishedTarball(releaseTag, tarballNameFor(pluginName, version), outputDirectory);
    released.push({ ...published, catalogEntry: buildCatalogEntry(published.manifest, published) });
  }
  return released;
}

const ICON_UPLOAD_BATCH_SIZE = 50;

/**
 * Lists the staged icons the `catalog` release does not have yet. Icon asset names are
 * content-addressed, so a name that is already published holds the same bytes.
 *
 * @returns `{catalogRelease, newIconPaths}` (object; catalogRelease is null when there is none yet)
 */
function planCatalogUpload({ iconPaths }) {
  const catalogRelease = viewRelease(CATALOG_TAG);
  const publishedNames = new Set((catalogRelease?.assets ?? []).map((asset) => asset.name));
  return { catalogRelease, newIconPaths: iconPaths.filter((iconPath) => !publishedNames.has(basename(iconPath))) };
}

/** Uploads new icons first (so every `icon_url` resolves once index.json is live), then index.json and SHA256SUMS. */
function uploadCatalog(catalogFiles, { catalogRelease, newIconPaths }, targetCommit) {
  const { indexPath, sumsPath } = catalogFiles;
  if (catalogRelease) {
    for (let start = 0; start < newIconPaths.length; start += ICON_UPLOAD_BATCH_SIZE) {
      const iconBatch = newIconPaths.slice(start, start + ICON_UPLOAD_BATCH_SIZE);
      runGhIdempotent(["release", "upload", CATALOG_TAG, ...iconBatch, "-R", RELEASE_REPOSITORY, "--clobber"]);
    }
    runGhIdempotent(["release", "upload", CATALOG_TAG, indexPath, sumsPath, "-R", RELEASE_REPOSITORY, "--clobber"]);
    return;
  }
  const notes = [
    "Catalog of every published graphrt plugin, updated in place on each publish.",
    "",
    `- \`index.json\`: ${releaseAssetUrl(CATALOG_TAG, "index.json")}`,
    `- \`SHA256SUMS\`: ${releaseAssetUrl(CATALOG_TAG, "SHA256SUMS")}`,
    "- `icon-<plugin>-<sha256 prefix>.svg`: plugin icons, named by content (each catalog entry's `icon_url`)",
    "",
    "See the repository README (Install) for the format.",
  ].join("\n");
  runCommand("gh", ["release", "create", CATALOG_TAG, ...newIconPaths, indexPath, sumsPath, "-R", RELEASE_REPOSITORY, "--target", targetCommit,
    "--title", "Plugin catalog", "--notes", notes, "--latest"]);
}

/** Downloads the live catalog `index.json`, or returns null when there is no catalog release yet. */
function downloadLiveCatalog(outputDirectory) {
  if (!viewRelease(CATALOG_TAG)) return null;
  const downloadDirectory = join(outputDirectory, "published", CATALOG_TAG);
  mkdirSync(downloadDirectory, { recursive: true });
  runGhIdempotent(["release", "download", CATALOG_TAG, "-R", RELEASE_REPOSITORY, "-p", "index.json", "-D", downloadDirectory, "--clobber"]);
  return JSON.parse(readFileSync(join(downloadDirectory, "index.json"), "utf8"));
}

/** Rebuilds the catalog from published tarballs only; plugin releases are not touched. */
function rebuildCatalogOnly(options) {
  rmSync(options.outputDirectory, { recursive: true, force: true });
  const released = collectOtherPublishedPlugins(new Set(), options.outputDirectory);
  const liveCatalog = downloadLiveCatalog(options.outputDirectory);
  const regressions = liveCatalog ? findCatalogRegressions(liveCatalog, released.map(({ catalogEntry }) => catalogEntry)) : [];
  if (regressions.length > 0) throw new Error(`rebuilt catalog would change published plugins:\n${regressions.join("\n")}`);
  return released;
}

/** Tests, packs and verifies plugins, then publishes missing releases; returns every published plugin. */
function publishPlugins(options, targetCommit) {
  const { passing, skipped } = selectPassingPlugins(options.pluginNames);
  passing.forEach((pluginName) => assertPluginMatchesTarget(pluginName, targetCommit));
  rmSync(options.outputDirectory, { recursive: true, force: true });
  const packedPlugins = packPlugins(passing, options.outputDirectory);
  for (const packed of packedPlugins) verifyTarball(packed.tarballPath, { graphrtBinary: process.env.GRAPHRT_BIN || null });
  const released = publishPluginReleases(packedPlugins, { targetCommit, outputDirectory: options.outputDirectory, dryRun: options.dryRun });
  released.push(...collectOtherPublishedPlugins(new Set(passing), options.outputDirectory));
  return { released, skipped };
}

function main() {
  const options = parsePublishArguments(process.argv.slice(2));
  const targetCommit = runCommand("git", ["rev-parse", "--verify", `${options.target}^{commit}`]).stdout.trim();
  const { released, skipped } = options.catalogOnly ? { released: rebuildCatalogOnly(options), skipped: [] } : publishPlugins(options, targetCommit);
  const catalogDirectory = join(options.outputDirectory, "catalog");
  mkdirSync(catalogDirectory, { recursive: true });
  const catalogFiles = writeCatalogFiles(catalogDirectory, released);
  const uploadPlan = planCatalogUpload(catalogFiles);
  console.error(`catalog: index.json ${statSync(catalogFiles.indexPath).size} bytes; ${catalogFiles.iconPaths.length} icons staged in ${join(catalogDirectory, "icons")}, ${uploadPlan.newIconPaths.length} not yet on the ${CATALOG_TAG} release${options.dryRun ? " (dry run: nothing uploaded)" : ""}`);
  if (!options.dryRun) uploadCatalog(catalogFiles, uploadPlan, targetCommit);
  const icons = { staged: catalogFiles.iconPaths.length, toUpload: uploadPlan.newIconPaths.map((iconPath) => basename(iconPath)) };
  console.log(JSON.stringify({ dryRun: options.dryRun, catalogOnly: options.catalogOnly, target: targetCommit, released: released.map(({ catalogEntry }) => ({ name: catalogEntry.name, version: catalogEntry.version, sha256: catalogEntry.sha256 })), icons, skipped }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`publish-plugins: ${error.message}`);
  process.exit(1);
}
