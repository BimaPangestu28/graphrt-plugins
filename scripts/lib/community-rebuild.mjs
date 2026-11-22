/**
 * Reproducible rebuild of a community plugin from its reviewed tag.
 *
 * The tarball checks only see what the author uploaded; code outside the pinned `.mjs/.js/.cjs/.json` files and
 * all of `node_modules` is not covered by any checksum. So before a community tarball is mirrored, the
 * maintainer step clones `repository_url` at `tag` (shallow, no submodules, no hooks, isolated environment),
 * packs it with this repo's packer (pack-plugins.mjs --plugin-dir logic: git-tracked files only,
 * `npm ci --omit=dev --ignore-scripts` with a lockfile required when there are dependencies) and requires the
 * rebuilt file set, and every file's bytes, to equal the author's tarball. Reviewers then read the source at the
 * tag knowing that it is exactly what ships.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { packExternalPlugin } from "../pack-plugins.mjs";
import { buildIsolatedEnvironment } from "./isolated-environment.mjs";
import { sha256Hex } from "./plugin-package.mjs";
import { readTarGz } from "./tar-archive.mjs";

const MAX_LISTED_DIFFERENCES = 10;
const GIT_CLONE_TIMEOUT_MS = 5 * 60_000;
/** Settings for the clone: no hooks from any configuration, no templates, no exotic transports. */
const SAFE_CLONE_CONFIG = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "protocol.ext.allow=never", "advice.detachedHead=false"];

/**
 * Clones `cloneUrl` at `tag` (shallow) and packs it with this repo's packer.
 *
 * @param options - Rebuild options
 * @param options.pluginName - Registry name; the manifest at the tag must have it (string)
 * @param options.cloneUrl - Repository to clone, e.g. the entry's `repository_url` (a `file://` URL in tests) (string)
 * @param options.tag - Tag to check out (string)
 * @param options.workDirectory - Directory the temporary clone, HOME and output go into (string)
 * @param options.maxUnpackedBytes - Refuse a rebuild that unpacks to more than this (number, default: no limit)
 * @returns The rebuilt archive's entries, as readTarGz returns them (object[])
 * @throws Error - When the clone or the packer fails, or the manifest names another plugin
 */
export function rebuildCommunityPluginFromTag({ pluginName, cloneUrl, tag, workDirectory, maxUnpackedBytes = undefined }) {
  const rebuildRoot = mkdtempSync(join(workDirectory, `rebuild-${pluginName}-`));
  try {
    const environment = buildIsolatedEnvironment(join(rebuildRoot, "home"));
    const checkoutDirectory = join(rebuildRoot, "checkout");
    cloneTagShallow(cloneUrl, tag, checkoutDirectory, environment);
    const packed = packExternalPlugin(checkoutDirectory, join(rebuildRoot, "out"), { commandEnvironment: environment });
    if (packed.name !== pluginName) throw new Error(`the manifest at tag ${tag} names \`${packed.name}\`, not \`${pluginName}\``);
    return readTarGz(readFileSync(packed.tarballPath), { maxUnpackedBytes });
  } finally {
    rmSync(rebuildRoot, { recursive: true, force: true });
  }
}

/**
 * `git clone --depth 1 --branch <tag>` with an argument array, an isolated environment, no hooks, no templates
 * and no submodules.
 *
 * @param cloneUrl - Repository URL (string)
 * @param tag - Tag (string)
 * @param destination - Directory to create (string)
 * @param environment - Environment from buildIsolatedEnvironment (object)
 * @throws Error - When git fails or times out
 */
export function cloneTagShallow(cloneUrl, tag, destination, environment) {
  const configArguments = SAFE_CLONE_CONFIG.flatMap((setting) => ["-c", setting]);
  const cloneArguments = [...configArguments, "clone", "--quiet", "--depth", "1", "--branch", tag, "--no-recurse-submodules", "--template=", "--", cloneUrl, destination];
  const cloneResult = spawnSync("git", cloneArguments, { encoding: "utf8", env: environment, timeout: GIT_CLONE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  if (cloneResult.error) throw new Error(`git clone of ${tag} failed: ${cloneResult.error.message}`);
  if (cloneResult.status !== 0) throw new Error(`git clone of ${tag} failed: ${cloneResult.stderr.trim()}`);
}

/**
 * Compares the author's archive with the rebuild: the same paths, types and file bytes.
 *
 * @param authorEntries - Entries of the author's tarball (object[])
 * @param rebuiltEntries - Entries of the rebuild (object[])
 * @returns Differences such as `only in the tarball: acme/x.mjs`; empty when they match (string[])
 */
export function findRebuildDifferences(authorEntries, rebuiltEntries) {
  const authorFingerprints = fingerprintEntries(authorEntries);
  const rebuiltFingerprints = fingerprintEntries(rebuiltEntries);
  const differences = [];
  for (const [entryPath, fingerprint] of authorFingerprints) {
    if (!rebuiltFingerprints.has(entryPath)) differences.push(`only in the tarball: ${entryPath}`);
    else if (rebuiltFingerprints.get(entryPath) !== fingerprint) differences.push(`differs: ${entryPath}`);
  }
  for (const entryPath of rebuiltFingerprints.keys()) {
    if (!authorFingerprints.has(entryPath)) differences.push(`only in the rebuild: ${entryPath}`);
  }
  return differences;
}

/**
 * One line summarising rebuild differences for a skip reason.
 *
 * @param differences - From findRebuildDifferences (string[])
 * @returns The first few differences and how many more there are (string)
 */
export function summarizeRebuildDifferences(differences) {
  const listed = differences.slice(0, MAX_LISTED_DIFFERENCES).join("; ");
  const remaining = differences.length - MAX_LISTED_DIFFERENCES;
  return remaining > 0 ? `${listed}; and ${remaining} more` : listed;
}

function fingerprintEntries(entries) {
  return new Map(entries.map((entry) => [entry.path, entry.type === "directory" ? "directory" : `file:${sha256Hex(entry.content)}`]));
}
