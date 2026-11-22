/**
 * Publishes plugin releases and refreshes the `catalog` release.
 *
 * Usage: node scripts/publish-plugins.mjs [plugin-name...] [--target <git ref>] [--out <dir>] [--dry-run] [--catalog-only]
 *   plugin-name  plugins to consider (default: all)
 *   --target     commit new release tags point at (default: HEAD); plugin files must
 *                be identical between this commit and the working tree
 *   --out        working directory for tarballs and catalog files (default: dist)
 *   --dry-run    pack, test and verify, print what would be published, change nothing
 *   --catalog-only  skip testing, packing and plugin releases: rebuild `index.json`,
 *                `index-v2.json`, the detail files and `SHA256SUMS` from the already-published
 *                tarballs (their own manifests and READMEs) and upload them with any new icons and
 *                detail files. Refuses when a plugin in the live catalog would be dropped or change
 *                version, sha256, size or URL. Use it after changing the catalog format, a status or
 *                an icon; combine with --dry-run to only write the files.
 *
 * Steps: check generated files are in sync, run each plugin's tests (failing plugins
 * are skipped), pack and verify tarballs, create every missing `<name>-v<version>`
 * release (pre-release for 0.x), then rebuild the catalog from the assets that are
 * actually published and upload it to the `catalog` release: first the plugin icons
 * (`<plugin>/icon.svg`, as content-addressed `icon-<plugin>-<hash>.svg`) and the v2 detail
 * files (`plugin-<name>-<version>.json`, immutable: a published one with other bytes makes
 * the publish fail) that are not there yet, then `index.json`, `index-v2.json` and
 * `SHA256SUMS`. Old icons and detail files are kept so older catalogs' URLs still resolve.
 * Existing plugin releases are never modified: bump the version to ship a change.
 *
 * Community plugins (community-plugins.json, see docs/community-plugins.md) are added to every catalog: each
 * entry's tarball is taken from its mirror release `community-<name>-v<version>` in this repo or, when there is
 * none yet (not with --catalog-only), downloaded from the developer's GitHub release, checked against the
 * reviewed sha256, re-packed canonically by our own tar writer, given the same checks as official tarballs, and
 * that repack is mirrored there (the catalog `sha256` is the repack's). An entry that fails is skipped (listed
 * under `skipped` with its reason); it never fails the official publish.
 *
 * Needs an authenticated `gh` (GH_TOKEN in CI). Set GRAPHRT_BIN to also check each official
 * tarball with `graphrt plugin install` into a temporary directory; community tarballs get that check only
 * with GRAPHRT_CHECK_COMMUNITY=1 as well (it may run their code: VM or container only). Plugin tests and
 * graphrt run with an isolated environment (no GH_TOKEN, a temporary HOME).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { REPO_ROOT, findSharedPlugins } from "./plugins.mjs";
import { DETAIL_STAGING_DIRECTORY_NAME, ICON_STAGING_DIRECTORY_NAME, packPlugins, writeCatalogFiles } from "./pack-plugins.mjs";
import { verifyTarball } from "./verify-plugins.mjs";
import {
  CATALOG_TAG, COMMUNITY_SOURCE, MANIFEST_FILE_NAME, RELEASE_REPOSITORY, buildCatalogEntry, describeTarballBytes, findCatalogRegressions,
  listPluginNames, releaseAssetUrl, releaseTagFor, sha256Hex, tarballNameFor,
} from "./lib/plugin-package.mjs";
import { CATALOG_V2_INDEX_NAME, MAX_RELEASE_ASSETS, RELEASE_ASSETS_WARNING_COUNT, detailConflictError, planDetailUploads } from "./lib/catalog-v2.mjs";
import { renderReleaseNotes } from "./lib/release-notes.mjs";
import { signCatalogIndexes } from "./lib/catalog-signing.mjs";
import { findUploadedDigestMismatches, planCatalogUploadBatches, planReleaseAction } from "./lib/release-plan.mjs";
import { listRepoDirectoryNames, readCommunityPlugins } from "./lib/community-plugins.mjs";
import { downloadHttpsBytes, ingestCommunityPlugins, selectCommunityGraphrtBinary } from "./lib/community-ingest.mjs";
import { runTestSuite } from "./lib/plugin-test-runner.mjs";

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

/** Downloads one asset of a release of this repo into `<out>/published/<tag>/` and returns its bytes. */
function downloadReleaseAsset(releaseTag, assetName, outputDirectory) {
  const downloadDirectory = join(outputDirectory, "published", releaseTag);
  mkdirSync(downloadDirectory, { recursive: true });
  runGhIdempotent(["release", "download", releaseTag, "-R", RELEASE_REPOSITORY, "-p", assetName, "-D", downloadDirectory, "--clobber"]);
  return readFileSync(join(downloadDirectory, assetName));
}

/** Downloads a published tarball and describes it from its own bytes, manifest and README. */
function describePublishedTarball(releaseTag, tarballName, outputDirectory) {
  const tarballBytes = downloadReleaseAsset(releaseTag, tarballName, outputDirectory);
  try {
    return describeTarballBytes(tarballName, tarballBytes);
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

/**
 * Uploads the one asset of a release that exists without it. No `--clobber`: if the asset appeared meanwhile,
 * gh refuses and the publish stops instead of replacing it.
 */
function uploadMissingAsset(releaseTag, assetPath) {
  runCommand("gh", ["release", "upload", releaseTag, assetPath, "-R", RELEASE_REPOSITORY]);
}

/** Publishes missing releases and returns `{tarballName, sha256, catalogEntry}` for every published plugin. */
function publishPluginReleases(packedPlugins, { targetCommit, outputDirectory, dryRun }) {
  const released = [];
  for (const packed of packedPlugins) {
    const releaseAction = planReleaseAction(viewRelease(packed.tag), packed.tarballName);
    if (releaseAction === "upload") {
      // A half-created release (the create failed after the tag): resume it with the missing asset.
      console.error(`${packed.tag}: release exists without ${packed.tarballName}; ${dryRun ? "would upload" : "uploading"} it (${packed.sha256})`);
      if (!dryRun) uploadMissingAsset(packed.tag, packed.tarballPath);
      released.push({ ...packed, catalogEntry: buildCatalogEntry(packed.manifest, packed) });
      continue;
    }
    if (releaseAction === "exists") {
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
    const releaseAction = planReleaseAction(viewRelease(releaseTag), tarballNameFor(pluginName, version));
    if (releaseAction === "upload") console.error(`${releaseTag}: release exists without its tarball; a publish of ${pluginName} resumes it`);
    if (releaseAction !== "exists") continue;
    const published = describePublishedTarball(releaseTag, tarballNameFor(pluginName, version), outputDirectory);
    released.push({ ...published, catalogEntry: buildCatalogEntry(published.manifest, published) });
  }
  return released;
}

const ASSET_UPLOAD_BATCH_SIZE = 50;
const SHA256_DIGEST_PREFIX = "sha256:";
// index.json, index-v2.json, their two .minisig signatures and SHA256SUMS.
const CATALOG_INDEX_FILE_COUNT = 5;

/**
 * Lists the staged icons and detail files the `catalog` release does not have yet. Icon asset names are
 * content-addressed, so a published name holds the same bytes. Detail files are immutable: a published one
 * must hold exactly the rebuilt bytes, else this refuses.
 *
 * @returns `{catalogRelease, newAssetPaths, newIconPaths, newDetailPaths}` (object; catalogRelease is null when there is none yet)
 * @throws Error - When a published detail file differs from the rebuilt one
 */
function planCatalogUpload({ iconPaths, detailFiles }, outputDirectory) {
  const catalogRelease = viewRelease(CATALOG_TAG);
  const publishedAssets = catalogRelease?.assets ?? [];
  const publishedNames = new Set(publishedAssets.map((asset) => asset.name));
  const newIconPaths = iconPaths.filter((iconPath) => !publishedNames.has(basename(iconPath)));
  const stagedNames = new Set(detailFiles.map((detailFile) => detailFile.assetName));
  const publishedDetails = publishedAssets.filter((asset) => stagedNames.has(asset.name));
  const { newDetails, conflicts } = planDetailUploads(detailFiles, readPublishedSha256ByName(publishedDetails, outputDirectory));
  if (conflicts.length > 0) throw detailConflictError(conflicts);
  const newDetailPaths = newDetails.map((detailFile) => detailFile.stagedPath);
  warnAboutAssetCount(publishedAssets.length + newIconPaths.length + newDetailPaths.length + (catalogRelease ? 0 : CATALOG_INDEX_FILE_COUNT));
  return { catalogRelease, newAssetPaths: [...newIconPaths, ...newDetailPaths], newIconPaths, newDetailPaths };
}

/** sha256 of each published asset: from GitHub's `digest` when it has one, else by downloading the asset. */
function readPublishedSha256ByName(publishedAssets, outputDirectory) {
  const sha256ByName = new Map();
  const undigestedNames = [];
  for (const asset of publishedAssets) {
    if (asset.digest?.startsWith(SHA256_DIGEST_PREFIX)) sha256ByName.set(asset.name, asset.digest.slice(SHA256_DIGEST_PREFIX.length));
    else undigestedNames.push(asset.name);
  }
  if (undigestedNames.length === 0) return sha256ByName;
  const downloadDirectory = join(outputDirectory, "published", CATALOG_TAG, "details");
  mkdirSync(downloadDirectory, { recursive: true });
  for (const assetName of undigestedNames) {
    runGhIdempotent(["release", "download", CATALOG_TAG, "-R", RELEASE_REPOSITORY, "-p", assetName, "-D", downloadDirectory, "--clobber"]);
    sha256ByName.set(assetName, sha256Hex(readFileSync(join(downloadDirectory, assetName))));
  }
  return sha256ByName;
}

/** Refuses an upload that would exceed GitHub's per-release asset limit, and warns as it gets close. */
function warnAboutAssetCount(assetCountAfterUpload) {
  if (assetCountAfterUpload > MAX_RELEASE_ASSETS) {
    throw new Error(`the ${CATALOG_TAG} release would hold ${assetCountAfterUpload} assets (GitHub allows ${MAX_RELEASE_ASSETS}); prune icons and detail files no index references first`);
  }
  if (assetCountAfterUpload >= RELEASE_ASSETS_WARNING_COUNT) {
    console.error(`warning: the ${CATALOG_TAG} release will hold ${assetCountAfterUpload} of ${MAX_RELEASE_ASSETS} assets; prune icons and detail files no index references`);
  }
}

/**
 * Uploads new icons and detail files first (so every `icon_url` and `detail_url` resolves once an index is
 * live), then the index signatures, then index-v2.json and index.json together, then SHA256SUMS last (planCatalogUploadBatches), and checks
 * the release digests afterwards. GitHub cannot replace several assets atomically: for a few seconds a reader
 * may see one index updated and not the other, or new indexes with the previous SHA256SUMS.
 */
function uploadCatalog(catalogFiles, { catalogRelease, newAssetPaths }, targetCommit) {
  const uploadBatches = planCatalogUploadBatches(catalogFiles, newAssetPaths, ASSET_UPLOAD_BATCH_SIZE);
  if (catalogRelease) {
    for (const assetBatch of uploadBatches) runGhIdempotent(["release", "upload", CATALOG_TAG, ...assetBatch, "-R", RELEASE_REPOSITORY, "--clobber"]);
  } else {
    runCommand("gh", ["release", "create", CATALOG_TAG, ...uploadBatches.flat(), "-R", RELEASE_REPOSITORY, "--target", targetCommit,
      "--title", "Plugin catalog", "--notes", renderCatalogReleaseNotes(), "--latest"]);
  }
  assertUploadedDigests(uploadBatches.flat());
}

/** Re-reads the `catalog` release and refuses when an uploaded asset's GitHub digest differs from the local file. */
function assertUploadedDigests(uploadedPaths) {
  const mismatches = findUploadedDigestMismatches(uploadedPaths, viewRelease(CATALOG_TAG)?.assets ?? [], (filePath) => sha256Hex(readFileSync(filePath)));
  if (mismatches.length > 0) throw new Error(`the ${CATALOG_TAG} release does not hold what was uploaded:\n  ${mismatches.join("\n  ")}`);
  console.error(`catalog: ${uploadedPaths.length} uploaded assets checked against the release digests`);
}

function renderCatalogReleaseNotes() {
  return [
    "Catalog of every published graphrt plugin, updated in place on each publish.",
    "",
    `- \`${CATALOG_V2_INDEX_NAME}\`: ${releaseAssetUrl(CATALOG_TAG, CATALOG_V2_INDEX_NAME)} (schema 2, slim; each entry links its detail file)`,
    "- `plugin-<name>-<version>.json`: immutable per-version details (node config schemas and outputs, tool descriptions)",
    `- \`index.json\`: ${releaseAssetUrl(CATALOG_TAG, "index.json")} (schema 1, for older apps)`,
    "- `index-v2.json.minisig`, `index.json.minisig`: minisign signatures of both indexes (public key: `catalog-signing.pub` in the repository)",
    `- \`SHA256SUMS\`: ${releaseAssetUrl(CATALOG_TAG, "SHA256SUMS")}`,
    "- `icon-<plugin>-<sha256 prefix>.svg`: plugin icons, named by content (each catalog entry's `icon_url`)",
    "",
    "See the repository README (Install) for the format.",
  ].join("\n");
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

/**
 * The GitHub side of community mirroring: mirror releases are read with gh and created once, never modified.
 *
 * @param options - `{outputDirectory}` (object)
 * @param targetCommit - Commit new mirror tags point at (string)
 * @returns The `mirror` object community-ingest.mjs expects (object)
 */
function createGithubMirror({ outputDirectory }, targetCommit) {
  return {
    // A mirror release without its tarball (a half-created one) reads as "not mirrored": the ingest then verifies
    // a fresh repack and createMirrorRelease resumes the release.
    readMirroredTarball(releaseTag, tarballName) {
      if (planReleaseAction(viewRelease(releaseTag), tarballName) !== "exists") return null;
      return downloadReleaseAsset(releaseTag, tarballName, outputDirectory);
    },
    readMirrorNotes(releaseTag) {
      const result = runGhIdempotent(["release", "view", releaseTag, "-R", RELEASE_REPOSITORY, "--json", "body"]);
      return JSON.parse(result.stdout).body ?? null;
    },
    createMirrorRelease({ releaseTag, tarballPath, title, notes, prerelease }) {
      const notesPath = join(outputDirectory, `${releaseTag}.notes.md`);
      writeFileSync(notesPath, notes);
      if (planReleaseAction(viewRelease(releaseTag), basename(tarballPath)) === "upload") {
        // Resume a half-created mirror: its notes must record the upload this repack was made from.
        runCommand("gh", ["release", "edit", releaseTag, "-R", RELEASE_REPOSITORY, "--notes-file", notesPath]);
        uploadMissingAsset(releaseTag, tarballPath);
        return;
      }
      const releaseArguments = ["release", "create", releaseTag, tarballPath, "-R", RELEASE_REPOSITORY, "--target", targetCommit,
        "--title", title, "--notes-file", notesPath, "--latest=false"];
      if (prerelease) releaseArguments.push("--prerelease");
      runCommand("gh", releaseArguments);
    },
  };
}

/** sha256 of a `catalog` release asset (or undefined when it is not published), for the community detail-file check. */
function createPublishedCatalogLookup(outputDirectory) {
  let publishedAssets = null;
  return (assetName) => {
    publishedAssets ??= viewRelease(CATALOG_TAG)?.assets ?? [];
    const publishedAsset = publishedAssets.filter((asset) => asset.name === assetName);
    return publishedAsset.length === 0 ? undefined : readPublishedSha256ByName(publishedAsset, outputDirectory).get(assetName);
  };
}

/**
 * Ingests every community-plugins.json entry; never throws for a bad entry or registry file.
 *
 * @returns `{released, skipped}` (Promise<object>)
 */
async function collectCommunityPlugins(options, targetCommit) {
  let registry;
  try {
    registry = readCommunityPlugins();
  } catch (error) {
    console.error(`community: skipping every community plugin, community-plugins.json is unreadable: ${error.message}`);
    return { released: [], skipped: [{ name: "community-plugins.json", source: COMMUNITY_SOURCE, reason: error.message }] };
  }
  return ingestCommunityPlugins(registry, {
    officialNames: listRepoDirectoryNames(),
    workDirectory: join(options.outputDirectory, "community"),
    catalogOnly: options.catalogOnly,
    dryRun: options.dryRun,
    graphrtBinary: selectCommunityGraphrtBinary(process.env, console.error),
    mirror: createGithubMirror(options, targetCommit),
    downloadTarball: (url) => downloadHttpsBytes(url),
    findPublishedCatalogSha256: createPublishedCatalogLookup(options.outputDirectory),
  });
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

function logCatalogSummary(catalogFiles, uploadPlan, { catalogDirectory, dryRun }) {
  const v1Note = catalogFiles.v1WithoutSchemas ? " (without node schemas)" : "";
  console.error(`catalog: index.json ${statSync(catalogFiles.indexPath).size} bytes${v1Note}; ${CATALOG_V2_INDEX_NAME} ${statSync(catalogFiles.indexV2Path).size} bytes`);
  console.error(`catalog: ${catalogFiles.detailFiles.length} detail files staged in ${join(catalogDirectory, DETAIL_STAGING_DIRECTORY_NAME)}, ${uploadPlan.newDetailPaths.length} not yet on the ${CATALOG_TAG} release`);
  console.error(`catalog: ${catalogFiles.iconPaths.length} icons staged in ${join(catalogDirectory, ICON_STAGING_DIRECTORY_NAME)}, ${uploadPlan.newIconPaths.length} not yet on the ${CATALOG_TAG} release${dryRun ? " (dry run: nothing uploaded)" : ""}`);
}

/** One GitHub error annotation per skipped community entry: visible on the run, without failing it. */
function annotateSkippedCommunityPlugins(skippedEntries) {
  for (const { name, reason } of skippedEntries) console.log(`::error title=community plugin ${name}::${`skipped: ${reason}`.replace(/[\r\n%]/g, " ")}`);
}

async function main() {
  const options = parsePublishArguments(process.argv.slice(2));
  const targetCommit = runCommand("git", ["rev-parse", "--verify", `${options.target}^{commit}`]).stdout.trim();
  const { released, skipped } = options.catalogOnly ? { released: rebuildCatalogOnly(options), skipped: [] } : publishPlugins(options, targetCommit);
  const community = await collectCommunityPlugins(options, targetCommit);
  released.push(...community.released);
  skipped.push(...community.skipped);
  if (process.env.GITHUB_ACTIONS === "true") annotateSkippedCommunityPlugins(community.skipped);
  const catalogDirectory = join(options.outputDirectory, "catalog");
  mkdirSync(catalogDirectory, { recursive: true });
  const signIndexes = (indexes) => signCatalogIndexes(indexes, { dryRun: options.dryRun });
  const catalogFiles = writeCatalogFiles(catalogDirectory, released, { signIndexes });
  skipped.push(...catalogFiles.skipped);
  const droppedNames = new Set(catalogFiles.skipped.map(({ name }) => name));
  const listed = released.filter(({ catalogEntry }) => !droppedNames.has(catalogEntry.name));
  const uploadPlan = planCatalogUpload(catalogFiles, options.outputDirectory);
  logCatalogSummary(catalogFiles, uploadPlan, { catalogDirectory, dryRun: options.dryRun });
  if (!options.dryRun) uploadCatalog(catalogFiles, uploadPlan, targetCommit);
  const icons = { staged: catalogFiles.iconPaths.length, toUpload: uploadPlan.newIconPaths.map((iconPath) => basename(iconPath)) };
  const details = { staged: catalogFiles.detailFiles.length, toUpload: uploadPlan.newDetailPaths.map((detailPath) => basename(detailPath)) };
  console.log(JSON.stringify({ dryRun: options.dryRun, catalogOnly: options.catalogOnly, target: targetCommit, released: listed.map(({ catalogEntry }) => ({ name: catalogEntry.name, version: catalogEntry.version, sha256: catalogEntry.sha256, source: catalogEntry.source })), icons, details, skipped }, null, 2));
}

main().catch((error) => {
  console.error(`publish-plugins: ${error.message}`);
  process.exit(1);
});
