/**
 * Ingests community plugins (community-plugins.json) into a catalog publish.
 *
 * For each registry entry: validate it, take the tarball from its mirror release in this repo
 * (`community-<name>-v<version>`) or, when there is none yet, download it from the developer's GitHub release
 * (https only, size-capped), check its sha256 against the registry BEFORE anything reads the archive, read it
 * with the strict tar reader and RE-PACK it canonically with our own writer (createTarGz, fixed mtime), run the
 * checks verify-plugins.mjs applies to official tarballs plus the community ones (manifest name and version
 * match the entry and its tag, every code file pinned, no graphrt-reserved node parameters, a safe root
 * `icon.svg` or the neutral fallback) on that repack, mirror the repack (never replacing a mirrored asset) and
 * build the catalog item.
 *
 * The author's bytes are never shipped: the registry's `tarball_sha256` pins the author's upload and is checked
 * first, while the mirror and the catalog's `sha256` are the canonical repack. A mirror records the author's
 * sha256 in its release notes; reusing a mirror requires that record to match the registry and the mirrored
 * tarball to be canonical.
 *
 * A failing entry is skipped with its reason; it never fails the official publish. The GitHub side (release
 * view, download, create) and the developer download are injected, so the whole flow runs in tests without a
 * network.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalogV2Entry, buildPluginDetail, renderPluginDetail } from "./catalog-v2.mjs";
import { communityReleaseTagFor, findCommunityEntryProblems, versionFromTag } from "./community-plugins.mjs";
import { findCommunityRuntimeProblems, findCommunityTextProblems } from "./community-manifest.mjs";
import { findRebuildDifferences, rebuildCommunityPluginFromTag, summarizeRebuildDifferences } from "./community-rebuild.mjs";
import {
  COMMUNITY_SOURCE, MANIFEST_FILE_NAME, README_FILE_NAME, assembleCatalogEntry, dependsOnBrowser, extractCatalogWarning, isPinnedPath, releaseAssetUrl, sha256Hex,
  stripCatalogEntrySchemas, tarballNameFor,
} from "./plugin-package.mjs";
import { COMMUNITY_FALLBACK_ICON_SVG, ICON_FILE_NAME, validateIconBytes } from "./plugin-icons.mjs";
import { findReservedNodeProperties } from "./reserved-parameters.mjs";
import { createTarGz, isCanonicalTarGz, readTarGz, toWritableEntries } from "./tar-archive.mjs";
import { verifyTarball } from "./tarball-verification.mjs";

/** Largest community tarball downloaded or mirrored. */
export const MAX_COMMUNITY_TARBALL_BYTES = 64 * 1024 * 1024;
/** Largest size a community tarball may unpack to (guards against gzip bombs). */
export const MAX_COMMUNITY_UNPACKED_BYTES = 256 * 1024 * 1024;
/**
 * Largest `index-v2.json` entry of one community plugin, so one listing cannot crowd the index past its limit.
 * Its node descriptions count too: index-v2.json does not carry them, but the schema-stripped index.json does.
 */
export const MAX_COMMUNITY_V2_ENTRY_BYTES = 16 * 1024;
/** Largest `index.json` entry of one community plugin, with node schemas. */
export const MAX_COMMUNITY_V1_ENTRY_BYTES = 64 * 1024;
/** Largest `index.json` entry of one community plugin without node schemas (what index.json falls back to). */
export const MAX_COMMUNITY_V1_STRIPPED_ENTRY_BYTES = 16 * 1024;
export const COMMUNITY_DOWNLOAD_TIMEOUT_MS = 120_000;
/** mtime of every entry of a canonical community repack, so the repack depends only on paths, bytes and modes. */
export const COMMUNITY_REPACK_MTIME_SECONDS = 0;
/** Hosts a GitHub release asset download goes through (github.com redirects to its asset storage). */
export const GITHUB_DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"]);
const MAX_REDIRECTS = 5;
const SOURCE_SHA256_NOTE_PATTERN = /^- Original asset sha256: `([0-9a-f]{64})`$/m;

/** Set to `1` (with GRAPHRT_BIN) to run `graphrt plugin install/list` on community tarballs. */
export const COMMUNITY_GRAPHRT_OPT_IN_VARIABLE = "GRAPHRT_CHECK_COMMUNITY";
export const COMMUNITY_GRAPHRT_WARNING = "warning: the graphrt check runs untrusted community code on this machine (with an isolated environment, but as you and with network access); run it only in a VM or a container";

/**
 * The graphrt binary for the community install check: `graphrt plugin install/list` may run plugin code, so on
 * community tarballs it runs only when explicitly enabled, and then with a warning.
 *
 * @param environment - Variables to read GRAPHRT_BIN and GRAPHRT_CHECK_COMMUNITY from (object, e.g. process.env)
 * @param log - Logs a line (function)
 * @returns The binary, or null when the check is off (string|null)
 */
export function selectCommunityGraphrtBinary(environment, log) {
  const graphrtBinary = environment.GRAPHRT_BIN || null;
  if (!graphrtBinary) return null;
  if (environment[COMMUNITY_GRAPHRT_OPT_IN_VARIABLE] !== "1") {
    log(`community: GRAPHRT_BIN is set, but graphrt plugin install is not run on community tarballs unless ${COMMUNITY_GRAPHRT_OPT_IN_VARIABLE}=1 (VM or container only)`);
    return null;
  }
  log(COMMUNITY_GRAPHRT_WARNING);
  return graphrtBinary;
}

/** A community entry that cannot be listed; the publish skips it with this message. */
export class CommunityPluginRejection extends Error {
  constructor(pluginName, reason) {
    super(`${pluginName}: ${reason}`);
    this.name = "CommunityPluginRejection";
    this.pluginName = pluginName;
    this.reason = reason;
  }
}

/**
 * Downloads a file over https with a size cap and a timeout, following at most a few redirects, each of which
 * must stay on https and on an allowed host.
 *
 * @param url - https URL (string)
 * @param options - Download options
 * @param options.maxBytes - Refuse bodies larger than this (number, default MAX_COMMUNITY_TARBALL_BYTES)
 * @param options.timeoutMs - Whole-download timeout (number, default COMMUNITY_DOWNLOAD_TIMEOUT_MS)
 * @param options.allowedHosts - Hosts every hop must be on (Set<string>, default GITHUB_DOWNLOAD_HOSTS)
 * @param options.fetchImpl - fetch implementation (function, default: global fetch)
 * @returns The body (Promise<Buffer>)
 * @throws Error - On a non-https hop, a host outside the allowlist, a non-2xx status, too many redirects, an
 *   oversized body or a timeout
 */
export async function downloadHttpsBytes(url, { maxBytes = MAX_COMMUNITY_TARBALL_BYTES, timeoutMs = COMMUNITY_DOWNLOAD_TIMEOUT_MS, allowedHosts = GITHUB_DOWNLOAD_HOSTS, fetchImpl = fetch } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertAllowedDownloadUrl(currentUrl, allowedHosts);
    const response = await fetchImpl(currentUrl, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`download: redirect without a location from ${new URL(currentUrl).host}`);
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }
    if (!response.ok) throw new Error(`download: HTTP ${response.status} from ${new URL(currentUrl).host}`);
    return readCappedBody(response, maxBytes);
  }
  throw new Error(`download: more than ${MAX_REDIRECTS} redirects`);
}

function assertAllowedDownloadUrl(url, allowedHosts) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") throw new Error(`download: refusing non-https URL ${parsedUrl.protocol}//${parsedUrl.host}`);
  if (!allowedHosts.has(parsedUrl.hostname)) throw new Error(`download: refusing host ${parsedUrl.hostname} (allowed: ${[...allowedHosts].join(", ")})`);
}

async function readCappedBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`download: ${declaredLength} bytes is more than the ${maxBytes}-byte limit`);
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of response.body ?? []) {
    receivedBytes += chunk.length;
    if (receivedBytes > maxBytes) throw new Error(`download: body is more than the ${maxBytes}-byte limit`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Checks the author's tarball before anything reads it (size and the reviewed sha256), then reads it strictly
 * and re-packs it canonically.
 *
 * @param pluginName - Registry name (string)
 * @param registryEntry - The validated registry entry (object)
 * @param authorBytes - The tarball as downloaded from the developer's release (Buffer)
 * @returns `{archiveEntries, repackBytes}`: the author's parsed entries and the canonical repack (object)
 * @throws CommunityPluginRejection - On a size or sha256 mismatch, or an archive the strict reader refuses
 */
export function repackAuthorTarball(pluginName, registryEntry, authorBytes) {
  if (authorBytes.length > MAX_COMMUNITY_TARBALL_BYTES) reject(pluginName, `tarball is ${authorBytes.length} bytes; the limit is ${MAX_COMMUNITY_TARBALL_BYTES}`);
  const actualSha256 = sha256Hex(authorBytes);
  if (actualSha256 !== registryEntry.tarball_sha256) reject(pluginName, `tarball sha256 ${actualSha256} does not match the reviewed ${registryEntry.tarball_sha256}`);
  const archiveEntries = withRejection(pluginName, () => readTarGz(authorBytes, { maxUnpackedBytes: MAX_COMMUNITY_UNPACKED_BYTES }));
  const repackBytes = withRejection(pluginName, () => createTarGz(toWritableEntries(archiveEntries), { mtimeSeconds: COMMUNITY_REPACK_MTIME_SECONDS }));
  return { archiveEntries, repackBytes };
}

/**
 * Checks a canonical community tarball (a fresh repack, or a mirror of one): the official checks (verifyTarball:
 * strict read, safe paths, one top-level directory, extraction from the parsed entries, no forbidden files or
 * key material, pinned checksums, dependencies, `graphrt plugin install` when graphrtBinary is set) and the
 * community ones.
 *
 * @param pluginName - Registry name (string)
 * @param registryEntry - The validated registry entry (object)
 * @param tarballBytes - The canonical tarball (Buffer)
 * @param options - Check options
 * @param options.workDirectory - Scratch directory the tarball is written to (string)
 * @param options.graphrtBinary - graphrt binary for the install check, or null (string|null)
 * @param options.log - Logs a line (function, default console.error)
 * @returns `{version, manifest, readmeText, packageJson, icon, tarballPath}`; icon is `{assetName, bytes, sha256}`,
 *   tarballPath where the checked bytes were written (object)
 * @throws CommunityPluginRejection - On the first failed check
 */
export function verifyCommunityTarball(pluginName, registryEntry, tarballBytes, { workDirectory, graphrtBinary = null, log = console.error }) {
  const version = versionFromTag(registryEntry.tag);
  if (tarballBytes.length > MAX_COMMUNITY_TARBALL_BYTES) reject(pluginName, `tarball is ${tarballBytes.length} bytes; the limit is ${MAX_COMMUNITY_TARBALL_BYTES}`);
  const archiveEntries = withRejection(pluginName, () => readTarGz(tarballBytes, { maxUnpackedBytes: MAX_COMMUNITY_UNPACKED_BYTES }));
  const manifest = parseTopLevelJson(pluginName, archiveEntries, MANIFEST_FILE_NAME);
  if (manifest?.name !== pluginName) reject(pluginName, `manifest name \`${manifest?.name}\` does not match the registry name`);
  if (manifest.version !== version) reject(pluginName, `manifest version \`${manifest.version}\` does not match tag ${registryEntry.tag}`);
  const runtimeProblems = findCommunityRuntimeProblems(manifest);
  if (runtimeProblems.length > 0) reject(pluginName, `manifest runtime: ${runtimeProblems.join("; ")}`);
  const readmeText = findTopLevelFile(archiveEntries, pluginName, README_FILE_NAME)?.content.toString("utf8") ?? null;
  const textProblems = findCommunityTextProblems(pluginName, manifest, readmeText === null ? null : extractCatalogWarning(readmeText));
  if (textProblems.length > 0) reject(pluginName, `manifest text: ${textProblems.slice(0, 10).join("; ")}${textProblems.length > 10 ? `; and ${textProblems.length - 10} more` : ""}`);
  const tarballPath = runOfficialTarballChecks(pluginName, tarballBytes, { version, workDirectory, graphrtBinary });
  assertEveryCodeFilePinned(pluginName, archiveEntries, manifest.checksums ?? {});
  const reservedProperties = findReservedNodeProperties(pluginName, manifest);
  if (reservedProperties.length > 0) reject(pluginName, `node parameters graphrt reserves (rename them): ${reservedProperties.join(", ")}`);
  return {
    version,
    manifest,
    readmeText,
    packageJson: parseTopLevelJson(pluginName, archiveEntries, "package.json"),
    icon: selectCommunityIcon(pluginName, findTopLevelFile(archiveEntries, pluginName, ICON_FILE_NAME), log),
    tarballPath,
  };
}

function runOfficialTarballChecks(pluginName, tarballBytes, { version, workDirectory, graphrtBinary }) {
  const checkDirectory = join(workDirectory, `${pluginName}-${version}`);
  rmSync(checkDirectory, { recursive: true, force: true });
  mkdirSync(checkDirectory, { recursive: true });
  const tarballPath = join(checkDirectory, tarballNameFor(pluginName, version));
  writeFileSync(tarballPath, tarballBytes);
  withRejection(pluginName, () => verifyTarball(tarballPath, { graphrtBinary, maxUnpackedBytes: MAX_COMMUNITY_UNPACKED_BYTES }));
  return tarballPath;
}

/** Official tarballs pin every code and JSON file outside node_modules; a community one must too. */
function assertEveryCodeFilePinned(pluginName, archiveEntries, checksums) {
  const prefix = `${pluginName}/`;
  const unpinned = archiveEntries
    .filter((entry) => entry.type === "file" && entry.path.startsWith(prefix))
    .map((entry) => entry.path.slice(prefix.length))
    .filter((relativePath) => isPinnedPath(relativePath) && !Object.hasOwn(checksums, relativePath));
  if (unpinned.length > 0) reject(pluginName, `files not pinned in the manifest checksums: ${unpinned.slice(0, 10).join(", ")}`);
}

/** The tarball's root icon.svg when it passes the allowlist and size checks, else the neutral fallback (logged). */
function selectCommunityIcon(pluginName, iconEntry, log) {
  if (iconEntry) {
    try {
      return validateIconBytes(pluginName, iconEntry.content);
    } catch (error) {
      log(`${pluginName}: icon.svg rejected (${error.message}); using the neutral fallback icon`);
    }
  } else {
    log(`${pluginName}: no icon.svg in the tarball root; using the neutral fallback icon`);
  }
  return validateIconBytes(pluginName, Buffer.from(COMMUNITY_FALLBACK_ICON_SVG));
}

function findTopLevelFile(archiveEntries, pluginName, fileName) {
  return archiveEntries.find((entry) => entry.type === "file" && entry.path === `${pluginName}/${fileName}`) ?? null;
}

function parseTopLevelJson(pluginName, archiveEntries, fileName) {
  const fileEntry = findTopLevelFile(archiveEntries, pluginName, fileName);
  if (!fileEntry) {
    if (fileName === MANIFEST_FILE_NAME) reject(pluginName, `tarball has no ${pluginName}/${MANIFEST_FILE_NAME} (is the top-level directory named after the plugin?)`);
    return null;
  }
  return withRejection(pluginName, () => JSON.parse(fileEntry.content.toString("utf8")), `${fileName} is not valid JSON`);
}

/**
 * Builds the catalog item of a verified community plugin: the v1 entry (`source: "community"`, the registry's
 * publisher, display name, status and repository, the mirror's tarball URL), plus what writeCatalogFiles needs.
 *
 * @param pluginName - Registry name (string)
 * @param registryEntry - The registry entry (object)
 * @param verified - Result of verifyCommunityTarball (object)
 * @param tarballFacts - `{sha256, sizeBytes}` of the shipped (repacked) tarball (object)
 * @returns `{tarballName, sha256, sizeBytes, manifest, readmeText, icon, releaseTag, catalogEntry}` (object)
 */
export function buildCommunityCatalogItem(pluginName, registryEntry, verified, { sha256, sizeBytes }) {
  const releaseTag = communityReleaseTagFor(pluginName, verified.version);
  const tarballName = tarballNameFor(pluginName, verified.version);
  const catalogEntry = assembleCatalogEntry(verified.manifest, { sha256, sizeBytes, readmeText: verified.readmeText }, {
    displayName: registryEntry.display_name,
    iconAssetName: verified.icon.assetName,
    tarballUrl: releaseAssetUrl(releaseTag, tarballName),
    needsBrowser: dependsOnBrowser(verified.packageJson),
    statusEntry: { status: registryEntry.status, reason: registryEntry.status_reason, tos_risk: registryEntry.tos_risk },
    source: COMMUNITY_SOURCE,
    publisher: registryEntry.publisher,
    repositoryUrl: registryEntry.repository_url,
    readmeUrl: `${registryEntry.repository_url}/blob/${registryEntry.tag}/README.md`,
  });
  return { tarballName, sha256, sizeBytes, manifest: verified.manifest, readmeText: verified.readmeText, icon: verified.icon, releaseTag, catalogEntry };
}

/**
 * Checks what the catalog would publish for the item: its detail file fits and, when the `catalog` release already
 * has a detail file of that name, holds the same bytes (detail files are immutable); its index.json entry (with
 * and without node schemas) and its v2 entry (plus node descriptions) stay within the community budgets.
 *
 * @param pluginName - Registry name (string)
 * @param catalogItem - From buildCommunityCatalogItem (object)
 * @param findPublishedCatalogSha256 - Returns the sha256 of a `catalog` release asset, or undefined (function)
 * @param budgets - Byte budgets (object, default: the MAX_COMMUNITY_* constants)
 * @param budgets.maxV1Bytes - index.json entry with schemas (number)
 * @param budgets.maxV1StrippedBytes - index.json entry without schemas (number)
 * @param budgets.maxV2Bytes - index-v2.json entry plus node descriptions (number)
 * @throws CommunityPluginRejection - When the detail file would change or an entry is too large
 */
export function assertCatalogFilesFit(pluginName, catalogItem, findPublishedCatalogSha256, budgets = {}) {
  const { maxV1Bytes = MAX_COMMUNITY_V1_ENTRY_BYTES, maxV1StrippedBytes = MAX_COMMUNITY_V1_STRIPPED_ENTRY_BYTES, maxV2Bytes = MAX_COMMUNITY_V2_ENTRY_BYTES } = budgets;
  const { catalogEntry } = catalogItem;
  const v1EntryBytes = Buffer.byteLength(JSON.stringify(catalogEntry));
  if (v1EntryBytes > maxV1Bytes) reject(pluginName, `its index.json entry is ${v1EntryBytes} bytes; the limit is ${maxV1Bytes}`);
  const v1StrippedBytes = Buffer.byteLength(JSON.stringify(stripCatalogEntrySchemas(catalogEntry)));
  if (v1StrippedBytes > maxV1StrippedBytes) reject(pluginName, `its index.json entry without node schemas is ${v1StrippedBytes} bytes; the limit is ${maxV1StrippedBytes}`);
  const renderedDetail = withRejection(pluginName, () => renderPluginDetail(buildPluginDetail(catalogItem.manifest)));
  const publishedSha256 = findPublishedCatalogSha256(renderedDetail.assetName);
  if (publishedSha256 !== undefined && publishedSha256 !== renderedDetail.sha256) {
    reject(pluginName, `${renderedDetail.assetName} is already published with other bytes (detail files are immutable)`);
  }
  const descriptionBytes = catalogEntry.nodes.reduce((total, node) => total + Buffer.byteLength(node.description ?? ""), 0);
  const v2EntryBytes = Buffer.byteLength(JSON.stringify(buildCatalogV2Entry(catalogEntry, renderedDetail))) + descriptionBytes;
  if (v2EntryBytes > maxV2Bytes) reject(pluginName, `its index-v2.json entry with its node descriptions is ${v2EntryBytes} bytes; the limit is ${maxV2Bytes}`);
}

/**
 * Validates, fetches, repacks, verifies and (unless dryRun or catalogOnly) mirrors one community plugin.
 *
 * @param pluginName - Registry name (string)
 * @param registryEntry - Registry entry (object)
 * @param context - Ingest context (object)
 * @param context.officialNames - Top-level directories of this repo (string[])
 * @param context.workDirectory - Scratch directory (string)
 * @param context.catalogOnly - Use only already-mirrored tarballs (boolean)
 * @param context.dryRun - Never create a mirror release (boolean)
 * @param context.graphrtBinary - graphrt binary for the install check, or null (string|null)
 * @param context.mirror - `{readMirroredTarball(tag, assetName) -> Buffer|null, readMirrorNotes(tag) -> string|null,
 *   createMirrorRelease({releaseTag, tarballPath, title, notes, prerelease})}` (object)
 * @param context.downloadTarball - Downloads the developer's tarball: `(url) -> Promise<Buffer>` (function)
 * @param context.rebuildFromTag - Rebuilds the plugin from its tag: `(pluginName, registryEntry) -> entries` (function,
 *   default: rebuildCommunityPluginFromTag cloning `repository_url`)
 * @param context.findPublishedCatalogSha256 - See assertCatalogFilesFit (function, default: nothing published)
 * @param context.log - Logs a line (function, default console.error)
 * @returns The catalog item plus `mirrorAction` ("mirrored", "would mirror" or "mirror created") (Promise<object>)
 * @throws CommunityPluginRejection - On any failed check
 */
export async function ingestCommunityPlugin(pluginName, registryEntry, context) {
  const { officialNames, workDirectory, graphrtBinary = null, log = console.error } = context;
  const problems = findCommunityEntryProblems(pluginName, registryEntry, officialNames);
  if (problems.length > 0) reject(pluginName, `invalid registry entry: ${problems.map((problem) => problem.slice(pluginName.length + 2)).join("; ")}`);
  const version = versionFromTag(registryEntry.tag);
  const releaseTag = communityReleaseTagFor(pluginName, version);
  const mirroredBytes = readReusableMirror(pluginName, registryEntry, { ...context, releaseTag, tarballName: tarballNameFor(pluginName, version) });
  const fetched = mirroredBytes ? null : await fetchAndRepack(pluginName, registryEntry, context);
  const shippedBytes = mirroredBytes ?? fetched.repackBytes;
  const verified = verifyCommunityTarball(pluginName, registryEntry, shippedBytes, { workDirectory, graphrtBinary, log });
  const shippedSha256 = sha256Hex(shippedBytes);
  const catalogItem = buildCommunityCatalogItem(pluginName, registryEntry, verified, { sha256: shippedSha256, sizeBytes: shippedBytes.length });
  assertCatalogFilesFit(pluginName, catalogItem, context.findPublishedCatalogSha256 ?? (() => undefined));
  // A mirror was rebuilt and compared when it was created; a new one needs the rebuild now.
  if (fetched) await assertMatchesRebuildFromTag(pluginName, registryEntry, fetched.archiveEntries, context);
  const mirrorAction = mirroredBytes ? "mirrored" : context.dryRun ? "would mirror" : "mirror created";
  if (mirrorAction === "mirror created") createMirror(pluginName, registryEntry, { mirror: context.mirror, releaseTag, version, tarballPath: verified.tarballPath, shippedSha256 });
  log(`${releaseTag}: ${mirrorAction === "mirrored" ? "already mirrored, unchanged" : mirrorAction} (repack ${shippedSha256} of the reviewed upload ${registryEntry.tarball_sha256})`);
  return { ...catalogItem, mirrorAction };
}

/**
 * The mirrored tarball when the entry's mirror release exists: it must record the reviewed upload's sha256 and be
 * a canonical repack. Null when there is no mirror yet (refused with catalogOnly).
 */
function readReusableMirror(pluginName, registryEntry, { mirror, catalogOnly = false, releaseTag, tarballName }) {
  const mirroredBytes = withRejection(pluginName, () => mirror.readMirroredTarball(releaseTag, tarballName));
  if (!mirroredBytes) {
    if (catalogOnly) reject(pluginName, `not mirrored yet (no ${releaseTag} release); run a full publish to mirror it`);
    return null;
  }
  const recordedSha256 = parseMirrorSourceSha256(withRejection(pluginName, () => mirror.readMirrorNotes(releaseTag)));
  if (recordedSha256 !== registryEntry.tarball_sha256) {
    reject(pluginName, `${releaseTag} was mirrored from the upload with sha256 ${recordedSha256 ?? "(not recorded)"}, not the reviewed ${registryEntry.tarball_sha256}; a mirrored release is never modified, so release a new version`);
  }
  const isCanonical = withRejection(pluginName, () => isCanonicalTarGz(mirroredBytes, { mtimeSeconds: COMMUNITY_REPACK_MTIME_SECONDS, maxUnpackedBytes: MAX_COMMUNITY_UNPACKED_BYTES }));
  if (!isCanonical) reject(pluginName, `${releaseTag} holds a ${tarballName} that is not a canonical repack; a mirrored release is never modified, so release a new version`);
  return mirroredBytes;
}

/**
 * Rebuilds the plugin from its tag (community-rebuild.mjs) and refuses it unless the rebuilt files equal the
 * author's tarball. `context.rebuildFromTag(pluginName, registryEntry)` replaces the git clone (tests).
 */
async function assertMatchesRebuildFromTag(pluginName, registryEntry, authorEntries, context) {
  const rebuildFromTag = context.rebuildFromTag ?? ((name, entry) => rebuildCommunityPluginFromTag({
    pluginName: name, cloneUrl: entry.repository_url, tag: entry.tag, workDirectory: context.workDirectory, maxUnpackedBytes: MAX_COMMUNITY_UNPACKED_BYTES,
  }));
  mkdirSync(context.workDirectory, { recursive: true });
  const rebuiltEntries = await withRejectionAsync(pluginName, async () => rebuildFromTag(pluginName, registryEntry), `rebuild from tag ${registryEntry.tag} failed`);
  const differences = findRebuildDifferences(authorEntries, rebuiltEntries);
  if (differences.length > 0) reject(pluginName, `the tarball does not match a rebuild from tag ${registryEntry.tag} (${differences.length} differences): ${summarizeRebuildDifferences(differences)}`);
}

async function fetchAndRepack(pluginName, registryEntry, { downloadTarball }) {
  const authorBytes = await withRejectionAsync(pluginName, () => downloadTarball(registryEntry.tarball_url));
  return repackAuthorTarball(pluginName, registryEntry, authorBytes);
}

/**
 * The reviewed upload's sha256 that a mirror release recorded in its notes (renderCommunityReleaseNotes).
 *
 * @param releaseNotes - Release notes, or null (string|null)
 * @returns The sha256, or null when the notes record none (string|null)
 */
export function parseMirrorSourceSha256(releaseNotes) {
  return SOURCE_SHA256_NOTE_PATTERN.exec(releaseNotes ?? "")?.[1] ?? null;
}

function createMirror(pluginName, registryEntry, { mirror, releaseTag, version, tarballPath, shippedSha256 }) {
  withRejection(pluginName, () => mirror.createMirrorRelease({
    releaseTag,
    tarballPath,
    title: `${registryEntry.display_name} ${version} (community)`,
    notes: renderCommunityReleaseNotes(pluginName, registryEntry, version, shippedSha256),
    prerelease: version.startsWith("0.") || version.includes("-"),
  }));
}

/**
 * Release notes of a mirror release: who publishes it, where its source is, what was reviewed, and the sha256 of
 * the reviewed upload (parseMirrorSourceSha256 reads it back when the mirror is reused).
 *
 * @param pluginName - Registry name (string)
 * @param registryEntry - Registry entry (object)
 * @param version - Plugin version (string)
 * @param mirroredSha256 - sha256 of the canonical repack the release holds (string)
 * @returns Markdown (string)
 */
export function renderCommunityReleaseNotes(pluginName, registryEntry, version, mirroredSha256) {
  return [
    `Community plugin **${escapeMarkdown(registryEntry.display_name)}** (\`${pluginName}\`) ${version}, published by ${escapeMarkdown(registryEntry.publisher)}.`,
    "",
    `- Source: ${registryEntry.repository_url} at tag \`${registryEntry.tag}\``,
    `- Original asset: ${registryEntry.tarball_url}`,
    `- Original asset sha256: \`${registryEntry.tarball_sha256}\``,
    `- Mirrored (canonical repack) sha256: \`${mirroredSha256}\``,
    `- Reviewed by @${registryEntry.reviewed_by} on ${registryEntry.reviewed_at}`,
    `- Status: ${registryEntry.status}, ToS risk: ${registryEntry.tos_risk}`,
    "",
    "This is a canonical repack of the reviewed release asset: the same files and bytes, rewritten by graphrt-plugins' own tar writer. It is never modified. A new version needs a new review (see docs/community-plugins.md).",
  ].join("\n");
}

/**
 * Escapes text for a Markdown release body: every character Markdown or a GitHub mention could interpret.
 *
 * @param text - Plain text (string)
 * @returns The escaped text (string)
 */
export function escapeMarkdown(text) {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~@&]/g, (character) => `\\${character}`);
}

/**
 * Ingests every registry entry; a failing entry is skipped with its reason and never fails the run.
 *
 * @param registry - Plugin name to registry entry (object)
 * @param context - As for ingestCommunityPlugin (object)
 * @returns `{released, skipped}`: catalog items, and `{name, source: "community", reason}` per skipped entry (Promise<object>)
 */
export async function ingestCommunityPlugins(registry, context) {
  const log = context.log ?? console.error;
  const released = [];
  const skipped = [];
  for (const [pluginName, registryEntry] of Object.entries(registry)) {
    try {
      released.push(await ingestCommunityPlugin(pluginName, registryEntry, context));
    } catch (error) {
      const reason = error instanceof CommunityPluginRejection ? error.reason : `unexpected error: ${error.message}`;
      log(`community ${pluginName}: skipped (${reason})`);
      skipped.push({ name: pluginName, source: COMMUNITY_SOURCE, reason });
    }
  }
  return { released, skipped };
}

function reject(pluginName, reason) {
  throw new CommunityPluginRejection(pluginName, reason);
}

function withRejection(pluginName, action, reasonPrefix = null) {
  try {
    return action();
  } catch (error) {
    if (error instanceof CommunityPluginRejection) throw error;
    reject(pluginName, reasonPrefix ? `${reasonPrefix}: ${error.message}` : error.message);
  }
}

async function withRejectionAsync(pluginName, action, reasonPrefix = null) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CommunityPluginRejection) throw error;
    reject(pluginName, reasonPrefix ? `${reasonPrefix}: ${error.message}` : error.message);
  }
}
