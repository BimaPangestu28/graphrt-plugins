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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyTarball } from "./lib/tarball-verification.mjs";

export { verifyTarball };

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
