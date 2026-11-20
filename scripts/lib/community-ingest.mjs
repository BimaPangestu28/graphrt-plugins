/**
 * Ingests community plugins (community-plugins.json) into a catalog publish.
 *
 * For each registry entry: validate it, take the tarball from its mirror release in this repo
 * (`community-<name>-v<version>`) or, when there is none yet, download it from the developer's GitHub release
 * (https only, size-capped), check its sha256 against the registry BEFORE anything reads the archive, run the
 * checks verify-plugins.mjs applies to official tarballs plus the community ones (manifest name and version
 * match the entry and its tag, every code file pinned, no graphrt-reserved node parameters, a safe root
 * `icon.svg` or the neutral fallback), mirror the exact bytes (never replacing a mirrored asset) and build the
 * catalog item.
 *
 * A failing entry is skipped with its reason; it never fails the official publish. The GitHub side (release
 * view, download, create) and the developer download are injected, so the whole flow runs in tests without a
 * network.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalogV2Entry, buildPluginDetail, renderPluginDetail } from "./catalog-v2.mjs";
import { communityReleaseTagFor, findCommunityEntryProblems, versionFromTag } from "./community-plugins.mjs";
import {
  COMMUNITY_SOURCE, MANIFEST_FILE_NAME, README_FILE_NAME, assembleCatalogEntry, dependsOnBrowser, isPinnedPath, releaseAssetUrl, sha256Hex,
  tarballNameFor,
} from "./plugin-package.mjs";
import { COMMUNITY_FALLBACK_ICON_SVG, ICON_FILE_NAME, validateIconBytes } from "./plugin-icons.mjs";
import { findReservedNodeProperties } from "./reserved-parameters.mjs";
import { readTarGz } from "./tar-archive.mjs";
import { verifyTarball } from "../verify-plugins.mjs";

/** Largest community tarball downloaded or mirrored. */
export const MAX_COMMUNITY_TARBALL_BYTES = 64 * 1024 * 1024;
/** Largest size a community tarball may unpack to (guards against gzip bombs). */
export const MAX_COMMUNITY_UNPACKED_BYTES = 256 * 1024 * 1024;
/** Largest `index-v2.json` entry of one community plugin, so one listing cannot crowd the index past its limit. */
export const MAX_COMMUNITY_V2_ENTRY_BYTES = 16 * 1024;
export const COMMUNITY_DOWNLOAD_TIMEOUT_MS = 120_000;
/** Hosts a GitHub release asset download goes through (github.com redirects to its asset storage). */
export const GITHUB_DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"]);
const MAX_REDIRECTS = 5;

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
 * Checks a community tarball: size and sha256 first (before the archive is read), then the official checks
 * (verifyTarball: safe paths, one top-level directory, safe extraction, no forbidden files or key material,
 * pinned checksums, dependencies, `graphrt plugin install` when graphrtBinary is set) and the community ones.
 *
 * @param pluginName - Registry name (string)
 * @param registryEntry - The validated registry entry (object)
 * @param tarballBytes - The tarball (Buffer)
 * @param options - Check options
 * @param options.workDirectory - Scratch directory the tarball is written to for extraction (string)
 * @param options.graphrtBinary - graphrt binary for the install check, or null (string|null)
 * @param options.log - Logs a line (function, default console.error)
 * @returns `{version, manifest, readmeText, packageJson, icon}`; icon is `{assetName, bytes, sha256}` (object)
 * @throws CommunityPluginRejection - On the first failed check
 */
export function verifyCommunityTarball(pluginName, registryEntry, tarballBytes, { workDirectory, graphrtBinary = null, log = console.error }) {
  const version = versionFromTag(registryEntry.tag);
  if (tarballBytes.length > MAX_COMMUNITY_TARBALL_BYTES) reject(pluginName, `tarball is ${tarballBytes.length} bytes; the limit is ${MAX_COMMUNITY_TARBALL_BYTES}`);
  const actualSha256 = sha256Hex(tarballBytes);
  if (actualSha256 !== registryEntry.tarball_sha256) reject(pluginName, `tarball sha256 ${actualSha256} does not match the reviewed ${registryEntry.tarball_sha256}`);
  const archiveEntries = withRejection(pluginName, () => readTarGz(tarballBytes, { maxUnpackedBytes: MAX_COMMUNITY_UNPACKED_BYTES }));
  const manifest = parseTopLevelJson(pluginName, archiveEntries, MANIFEST_FILE_NAME);
  if (manifest?.name !== pluginName) reject(pluginName, `manifest name \`${manifest?.name}\` does not match the registry name`);
  if (manifest.version !== version) reject(pluginName, `manifest version \`${manifest.version}\` does not match tag ${registryEntry.tag}`);
  runOfficialTarballChecks(pluginName, tarballBytes, { version, workDirectory, graphrtBinary });
  assertEveryCodeFilePinned(pluginName, archiveEntries, manifest.checksums ?? {});
  const reservedProperties = findReservedNodeProperties(pluginName, manifest);
  if (reservedProperties.length > 0) reject(pluginName, `node parameters graphrt reserves (rename them): ${reservedProperties.join(", ")}`);
  return {
    version,
    manifest,
    readmeText: findTopLevelFile(archiveEntries, pluginName, README_FILE_NAME)?.content.toString("utf8") ?? null,
    packageJson: parseTopLevelJson(pluginName, archiveEntries, "package.json"),
    icon: selectCommunityIcon(pluginName, findTopLevelFile(archiveEntries, pluginName, ICON_FILE_NAME), log),
  };
}

function runOfficialTarballChecks(pluginName, tarballBytes, { version, workDirectory, graphrtBinary }) {
  const checkDirectory = join(workDirectory, `${pluginName}-${version}`);
  rmSync(checkDirectory, { recursive: true, force: true });
  mkdirSync(checkDirectory, { recursive: true });
  const tarballPath = join(checkDirectory, tarballNameFor(pluginName, version));
  writeFileSync(tarballPath, tarballBytes);
  withRejection(pluginName, () => verifyTarball(tarballPath, { graphrtBinary, maxUnpackedBytes: MAX_COMMUNITY_UNPACKED_BYTES }));
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
 * @param tarballFacts - `{sha256, sizeBytes}` of the tarball (object)
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
 * has a detail file of that name, holds the same bytes (detail files are immutable); its v2 entry stays small.
 *
 * @param pluginName - Registry name (string)
 * @param catalogItem - From buildCommunityCatalogItem (object)
 * @param findPublishedCatalogSha256 - Returns the sha256 of a `catalog` release asset, or undefined (function)
 * @throws CommunityPluginRejection - When the detail file would change or an entry is too large
 */
export function assertCatalogFilesFit(pluginName, catalogItem, findPublishedCatalogSha256) {
  const renderedDetail = withRejection(pluginName, () => renderPluginDetail(buildPluginDetail(catalogItem.manifest)));
  const publishedSha256 = findPublishedCatalogSha256(renderedDetail.assetName);
  if (publishedSha256 !== undefined && publishedSha256 !== renderedDetail.sha256) {
    reject(pluginName, `${renderedDetail.assetName} is already published with other bytes (detail files are immutable)`);
  }
  const v2EntryBytes = Buffer.byteLength(JSON.stringify(buildCatalogV2Entry(catalogItem.catalogEntry, renderedDetail)));
  if (v2EntryBytes > MAX_COMMUNITY_V2_ENTRY_BYTES) reject(pluginName, `its index-v2.json entry is ${v2EntryBytes} bytes; the limit is ${MAX_COMMUNITY_V2_ENTRY_BYTES}`);
}

/**
 * Validates, fetches, verifies and (unless dryRun or catalogOnly) mirrors one community plugin.
 *
 * @param pluginName - Registry name (string)
 * @param registryEntry - Registry entry (object)
 * @param context - Ingest context (object)
 * @param context.officialNames - Top-level directories of this repo (string[])
 * @param context.workDirectory - Scratch directory (string)
 * @param context.catalogOnly - Use only already-mirrored tarballs (boolean)
 * @param context.dryRun - Never create a mirror release (boolean)
 * @param context.graphrtBinary - graphrt binary for the install check, or null (string|null)
 * @param context.mirror - `{readMirroredTarball(tag, assetName) -> Buffer|null, createMirrorRelease({releaseTag, tarballPath, title, notes, prerelease})}` (object)
 * @param context.downloadTarball - Downloads the developer's tarball: `(url) -> Promise<Buffer>` (function)
 * @param context.findPublishedCatalogSha256 - See assertCatalogFilesFit (function, default: nothing published)
 * @param context.log - Logs a line (function, default console.error)
 * @returns The catalog item plus `mirrorAction` ("mirrored", "would mirror" or "mirror created") (Promise<object>)
 * @throws CommunityPluginRejection - On any failed check
 */
export async function ingestCommunityPlugin(pluginName, registryEntry, context) {
  const { officialNames, workDirectory, catalogOnly = false, dryRun = false, graphrtBinary = null, mirror, downloadTarball, log = console.error } = context;
  const problems = findCommunityEntryProblems(pluginName, registryEntry, officialNames);
  if (problems.length > 0) reject(pluginName, `invalid registry entry: ${problems.map((problem) => problem.slice(pluginName.length + 2)).join("; ")}`);
  const version = versionFromTag(registryEntry.tag);
  const releaseTag = communityReleaseTagFor(pluginName, version);
  const tarballName = tarballNameFor(pluginName, version);
  const mirroredBytes = withRejection(pluginName, () => mirror.readMirroredTarball(releaseTag, tarballName));
  if (mirroredBytes && sha256Hex(mirroredBytes) !== registryEntry.tarball_sha256) {
    reject(pluginName, `${releaseTag} already holds ${tarballName} with sha256 ${sha256Hex(mirroredBytes)}, not the reviewed ${registryEntry.tarball_sha256}; a mirrored release is never modified, so release a new version`);
  }
  if (!mirroredBytes && catalogOnly) reject(pluginName, `not mirrored yet (no ${releaseTag} release); run a full publish to mirror it`);
  const tarballBytes = mirroredBytes ?? (await withRejectionAsync(pluginName, () => downloadTarball(registryEntry.tarball_url)));
  const verified = verifyCommunityTarball(pluginName, registryEntry, tarballBytes, { workDirectory, graphrtBinary, log });
  const catalogItem = buildCommunityCatalogItem(pluginName, registryEntry, verified, { sha256: registryEntry.tarball_sha256, sizeBytes: tarballBytes.length });
  assertCatalogFilesFit(pluginName, catalogItem, context.findPublishedCatalogSha256 ?? (() => undefined));
  const mirrorAction = mirroredBytes ? "mirrored" : dryRun ? "would mirror" : "mirror created";
  if (!mirroredBytes && !dryRun) createMirror(pluginName, registryEntry, { mirror, releaseTag, version, tarballPath: join(workDirectory, `${pluginName}-${version}`, tarballName) });
  log(`${releaseTag}: ${mirrorAction === "mirrored" ? "already mirrored, unchanged" : mirrorAction} (${registryEntry.tarball_sha256})`);
  return { ...catalogItem, mirrorAction };
}

function createMirror(pluginName, registryEntry, { mirror, releaseTag, version, tarballPath }) {
  withRejection(pluginName, () => mirror.createMirrorRelease({
    releaseTag,
    tarballPath,
    title: `${registryEntry.display_name} ${version} (community)`,
    notes: renderCommunityReleaseNotes(pluginName, registryEntry, version),
    prerelease: version.startsWith("0.") || version.includes("-"),
  }));
}

/**
 * Release notes of a mirror release: who publishes it, where its source is, and what was reviewed.
 *
 * @param pluginName - Registry name (string)
 * @param registryEntry - Registry entry (object)
 * @param version - Plugin version (string)
 * @returns Markdown (string)
 */
export function renderCommunityReleaseNotes(pluginName, registryEntry, version) {
  return [
    `Community plugin **${registryEntry.display_name}** (\`${pluginName}\`) ${version}, published by ${registryEntry.publisher}.`,
    "",
    `- Source: ${registryEntry.repository_url} at tag \`${registryEntry.tag}\``,
    `- Original asset: ${registryEntry.tarball_url}`,
    `- sha256: \`${registryEntry.tarball_sha256}\``,
    `- Reviewed by @${registryEntry.reviewed_by} on ${registryEntry.reviewed_at}`,
    `- Status: ${registryEntry.status}, ToS risk: ${registryEntry.tos_risk}`,
    "",
    "This is an exact mirror of the reviewed release asset; it is never modified. A new version needs a new review (see docs/community-plugins.md).",
  ].join("\n");
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

async function withRejectionAsync(pluginName, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CommunityPluginRejection) throw error;
    reject(pluginName, error.message);
  }
}
