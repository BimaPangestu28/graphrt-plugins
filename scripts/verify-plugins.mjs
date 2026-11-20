/**
 * Verifies plugin release tarballs the way a host will use them.
 *
 * Usage: node scripts/verify-plugins.mjs <tarball...> [--graphrt <path to graphrt binary>]
 *        node scripts/verify-plugins.mjs --community <name...> [--graphrt <path>]
 *
 * `--community` reviews community-plugins.json entries instead: it downloads each entry's tarball from the
 * developer's GitHub release and runs every check a publish runs before mirroring it (sha256, these checks, the
 * manifest name/version against the entry and tag, pinned code, reserved parameters, the icon). Nothing is
 * mirrored or published.
 *
 * For each tarball: every entry is a file or directory under one top-level
 * `<name>/` directory, the archive extracts with the system `tar`, the extracted
 * tree has no symlinks or forbidden files, `plugin.mjs` is present and pinned,
 * and every `checksums` entry matches. With `--graphrt` (or $GRAPHRT_BIN), it also
 * runs `graphrt plugin install <dir> --dir <temp>` and `graphrt plugin list`
 * against that temporary directory only, never `~/.graphrt`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertAllowedPath, MANIFEST_FILE_NAME, sha256Hex } from "./lib/plugin-package.mjs";
import { assertSafeArchivePath, readTarGz } from "./lib/tar-archive.mjs";

/**
 * Verifies one tarball.
 *
 * @param tarballPath - Path to `<name>-<version>.tar.gz` (string)
 * @param options - Verification options
 * @param options.graphrtBinary - graphrt binary to run install/list with, or null (string|null)
 * @param options.maxUnpackedBytes - Refuse a tarball that unpacks to more than this (number, default: no limit)
 * @returns `{name, version, pinnedFiles}` (object)
 * @throws Error - On the first failed check
 */
export function verifyTarball(tarballPath, { graphrtBinary = null, maxUnpackedBytes = undefined } = {}) {
  const archiveEntries = readTarGz(readFileSync(tarballPath), { maxUnpackedBytes });
  archiveEntries.forEach((entry) => assertSafeArchivePath(entry.path));
  const pluginName = assertSingleTopLevelDirectory(archiveEntries);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "graphrt-plugin-verify-"));
  try {
    const extractResult = spawnSync("tar", ["-xzf", tarballPath, "-C", temporaryRoot], { encoding: "utf8" });
    if (extractResult.status !== 0) throw new Error(`tar -xzf failed: ${extractResult.stderr}`);
    const pluginDirectory = join(temporaryRoot, pluginName);
    assertCleanTree(pluginDirectory);
    const manifest = JSON.parse(readFileSync(join(pluginDirectory, MANIFEST_FILE_NAME), "utf8"));
    assertManifestMatchesTarball(manifest, pluginName, basename(tarballPath));
    assertChecksumsMatch(pluginDirectory, manifest.checksums ?? {});
    assertDependenciesInstalled(pluginDirectory);
    if (graphrtBinary) assertGraphrtAccepts(graphrtBinary, pluginDirectory, temporaryRoot, pluginName);
    return { name: pluginName, version: manifest.version, pinnedFiles: Object.keys(manifest.checksums).length };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertSingleTopLevelDirectory(archiveEntries) {
  const topLevelNames = new Set(archiveEntries.map((entry) => entry.path.split("/")[0]));
  if (topLevelNames.size !== 1) throw new Error(`expected one top-level directory, found ${[...topLevelNames].join(", ")}`);
  const [pluginName] = topLevelNames;
  const rootEntry = archiveEntries.find((entry) => entry.path === pluginName);
  if (rootEntry?.type !== "directory") throw new Error(`top-level entry \`${pluginName}\` is not a directory`);
  return pluginName;
}

function assertCleanTree(pluginDirectory) {
  for (const entry of readdirSync(pluginDirectory, { withFileTypes: true, recursive: true })) {
    const relativePath = relative(pluginDirectory, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`symlink \`${relativePath}\` in the extracted plugin`);
    if (!entry.isFile() && !entry.isDirectory()) throw new Error(`\`${relativePath}\` is not a regular file`);
    if (entry.isDirectory() && entry.name === ".bin") throw new Error(`\`${relativePath}\` must be dropped`);
    if (entry.isFile()) assertAllowedPath(relativePath);
  }
}

function assertManifestMatchesTarball(manifest, pluginName, tarballFileName) {
  if (manifest.name !== pluginName) throw new Error(`manifest name \`${manifest.name}\` does not match directory \`${pluginName}\``);
  if (tarballFileName !== `${manifest.name}-${manifest.version}.tar.gz`) {
    throw new Error(`tarball name \`${tarballFileName}\` does not match ${manifest.name} ${manifest.version}`);
  }
  if (!manifest.checksums?.["plugin.mjs"]) throw new Error("the entrypoint plugin.mjs is not pinned in checksums");
}

function assertChecksumsMatch(pluginDirectory, checksums) {
  for (const [relativePath, expectedSha256] of Object.entries(checksums)) {
    const filePath = join(pluginDirectory, relativePath);
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) throw new Error(`pinned \`${relativePath}\` is missing or not a regular file`);
    const actualSha256 = sha256Hex(readFileSync(filePath));
    if (actualSha256 !== expectedSha256) throw new Error(`checksum mismatch for \`${relativePath}\``);
  }
}

function assertDependenciesInstalled(pluginDirectory) {
  const packageJsonPath = join(pluginDirectory, "package.json");
  if (!existsSync(packageJsonPath)) return;
  const dependencyNames = Object.keys(JSON.parse(readFileSync(packageJsonPath, "utf8")).dependencies ?? {});
  for (const dependencyName of dependencyNames) {
    if (!existsSync(join(pluginDirectory, "node_modules", dependencyName, "package.json"))) {
      throw new Error(`dependency \`${dependencyName}\` is not installed in node_modules`);
    }
  }
}

function assertGraphrtAccepts(graphrtBinary, pluginDirectory, temporaryRoot, pluginName) {
  const installDirectory = join(temporaryRoot, "installed");
  const installResult = spawnSync(graphrtBinary, ["plugin", "install", pluginDirectory, "--dir", installDirectory], { encoding: "utf8" });
  if (installResult.status !== 0) throw new Error(`graphrt plugin install failed: ${installResult.stderr || installResult.stdout}`);
  const listResult = spawnSync(graphrtBinary, ["plugin", "list", "--json", "--no-default-plugins", "--plugins", installDirectory], { encoding: "utf8" });
  if (listResult.status !== 0) throw new Error(`graphrt plugin list failed: ${listResult.stderr || listResult.stdout}`);
  const listedPlugin = JSON.parse(listResult.stdout).find((summary) => summary.name === pluginName);
  if (!listedPlugin) throw new Error(`graphrt plugin list does not show ${pluginName}`);
  if (listedPlugin.error) throw new Error(`graphrt reports a load error: ${listedPlugin.error}`);
  const expectedNodeCount = JSON.parse(readFileSync(join(pluginDirectory, MANIFEST_FILE_NAME), "utf8")).nodes.length;
  if (listedPlugin.nodes.length !== expectedNodeCount) {
    throw new Error(`graphrt lists ${listedPlugin.nodes.length} nodes, the manifest declares ${expectedNodeCount}`);
  }
}

/**
 * Reviews community-plugins.json entries the way a publish would ingest them, without mirroring: downloads each
 * tarball from the developer's release and runs every check (community-ingest.mjs).
 *
 * @param pluginNames - Registry names (string[])
 * @param graphrtBinary - graphrt binary for the install check, or null (string|null)
 * @returns Number of entries that failed (Promise<number>)
 */
async function reviewCommunityEntries(pluginNames, graphrtBinary) {
  const { readCommunityPlugins, listRepoDirectoryNames, withPendingReviewStandIns } = await import("./lib/community-plugins.mjs");
  const { downloadHttpsBytes, ingestCommunityPlugin } = await import("./lib/community-ingest.mjs");
  const registry = readCommunityPlugins();
  const workDirectory = mkdtempSync(join(tmpdir(), "graphrt-community-review-"));
  const reviewMirror = { readMirroredTarball: () => null, createMirrorRelease: () => { throw new Error("review never mirrors"); } };
  let failureCount = 0;
  try {
    for (const pluginName of pluginNames) {
      try {
        if (!Object.hasOwn(registry, pluginName)) throw new Error(`no entry in community-plugins.json`);
        const context = { officialNames: listRepoDirectoryNames(), workDirectory, dryRun: true, graphrtBinary, mirror: reviewMirror, downloadTarball: (url) => downloadHttpsBytes(url) };
        const registryEntry = withPendingReviewStandIns(registry[pluginName]);
        const reviewed = await ingestCommunityPlugin(pluginName, registryEntry, context);
        const pendingNote = registryEntry === registry[pluginName] ? "" : "; review fields still pending";
        console.log(`ok    ${pluginName} ${reviewed.catalogEntry.version} (${reviewed.sha256}${graphrtBinary ? ", accepted by graphrt" : ""}${pendingNote})`);
      } catch (error) {
        failureCount += 1;
        console.log(`FAIL  ${pluginName}: ${error.reason ?? error.message}`);
      }
    }
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
  return failureCount;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argumentList = process.argv.slice(2);
  const graphrtFlagIndex = argumentList.indexOf("--graphrt");
  const graphrtBinary = graphrtFlagIndex === -1 ? process.env.GRAPHRT_BIN || null : argumentList.splice(graphrtFlagIndex, 2)[1];
  const communityFlagIndex = argumentList.indexOf("--community");
  if (communityFlagIndex !== -1) {
    argumentList.splice(communityFlagIndex, 1);
    process.exit((await reviewCommunityEntries(argumentList, graphrtBinary)) > 0 ? 1 : 0);
  }
  let failureCount = 0;
  for (const tarballPath of argumentList) {
    try {
      const verified = verifyTarball(tarballPath, { graphrtBinary });
      console.log(`ok    ${basename(tarballPath)} (${verified.pinnedFiles} pinned files${graphrtBinary ? ", accepted by graphrt" : ""})`);
    } catch (error) {
      failureCount += 1;
      console.log(`FAIL  ${basename(tarballPath)}: ${error.message}`);
    }
  }
  process.exit(failureCount > 0 ? 1 : 0);
}
