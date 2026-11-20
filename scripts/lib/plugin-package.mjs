/**
 * Builds release tarballs for graphrt plugins.
 *
 * A release tarball holds one top-level directory `<name>/` that is ready to run:
 * the plugin's tracked files (tests excluded), its synced `lib/shared`, its
 * production npm dependencies (no browsers, no `.bin` links) and a
 * `graphrt-plugin.json` whose `checksums` pin every `.mjs`/`.js`/`.cjs`/`.json`
 * file outside `node_modules` (the manifest itself cannot pin itself).
 * `node_modules` is not pinned: npm already verified it against the lockfile's
 * integrity hashes, and hashing thousands of Playwright files before every
 * plugin start would slow every run.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";
import { ICON_FILE_NAME, readPluginIcon } from "./plugin-icons.mjs";
import { displayNameFor } from "./plugin-names.mjs";
import { readPluginStatuses, statusForPlugin } from "./plugin-status.mjs";
import { createTarGz, readTarGz } from "./tar-archive.mjs";

export const MANIFEST_FILE_NAME = "graphrt-plugin.json";
export const README_FILE_NAME = "README.md";
export const RELEASE_REPOSITORY = process.env.GRAPHRT_PLUGINS_REPOSITORY || "BimaPangestu28/graphrt-plugins";
export const CATALOG_TAG = "catalog";
export const CATALOG_SCHEMA_VERSION = 1;
export const NODE_REQUIREMENT = ">=20";

const PINNED_EXTENSIONS = [".mjs", ".js", ".cjs", ".json"];
const EXCLUDED_SOURCE_DIRECTORIES = new Set(["test", "node_modules"]);
// Catalog-only files: the icon is published with the catalog, so changing it needs no plugin release.
const EXCLUDED_SOURCE_FILES = new Set([ICON_FILE_NAME]);
const FORBIDDEN_PATH_PATTERNS = [
  { pattern: /(^|\/)\.env($|\.)/, reason: "environment file" },
  { pattern: /(^|\/)\.claude(\/|$)/, reason: "Claude session data" },
  { pattern: /(^|\/)\.cache(\/|$)/, reason: "cache directory" },
  { pattern: /(^|\/)\.git(\/|$)/, reason: "git metadata" },
  { pattern: /(^|\/)\.DS_Store$/, reason: "Finder metadata" },
  { pattern: /(^|\/)(profile|user-data-dir)(\/|$)/i, reason: "browser profile" },
  { pattern: /(^|\/)ms-playwright(\/|$)/, reason: "Playwright browser download" },
  { pattern: /\.(pem|key|p12)$/, reason: "key material" },
];

/**
 * Largest `index.json` the graphrt-builder-desktop app downloads (its `MAX_CATALOG_BYTES`). A bigger
 * catalog fails there and the app silently keeps its saved copy, so publishing refuses one.
 */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

/**
 * Serialises the catalog as compact JSON (node config schemas make the indented form ~75% larger).
 *
 * @param catalog - Catalog from buildCatalog (object)
 * @returns `index.json` text, newline-terminated (string)
 * @throws Error - When the text is larger than MAX_CATALOG_BYTES
 */
export function renderCatalogText(catalog) {
  const catalogText = `${JSON.stringify(catalog)}\n`;
  const sizeBytes = Buffer.byteLength(catalogText);
  if (sizeBytes > MAX_CATALOG_BYTES) {
    throw new Error(`index.json is ${sizeBytes} bytes; the desktop app accepts at most ${MAX_CATALOG_BYTES}. Raise its limit (and this one) first`);
  }
  return catalogText;
}

/** @returns Tag of a plugin release, e.g. `meta-api-v0.1.0` (string) */
export function releaseTagFor(pluginName, pluginVersion) {
  return `${pluginName}-v${pluginVersion}`;
}

/** @returns Asset name of a plugin tarball, e.g. `meta-api-0.1.0.tar.gz` (string) */
export function tarballNameFor(pluginName, pluginVersion) {
  return `${pluginName}-${pluginVersion}.tar.gz`;
}

/** @returns Public download URL of a release asset (string) */
export function releaseAssetUrl(releaseTag, assetName) {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/${releaseTag}/${assetName}`;
}

/**
 * Lists every plugin directory at the repository root (a directory holding graphrt-plugin.json).
 *
 * @returns Plugin names sorted alphabetically (string[])
 */
export function listPluginNames() {
  return readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, entry.name, MANIFEST_FILE_NAME)))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Reads a plugin's source manifest and checks it can be released.
 *
 * @param pluginName - Plugin directory name (string)
 * @returns The parsed manifest (object)
 * @throws Error - When the manifest name does not match the directory or the version is missing
 */
export function readSourceManifest(pluginName) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pluginName, MANIFEST_FILE_NAME), "utf8"));
  if (manifest.name !== pluginName) throw new Error(`${pluginName}: manifest name \`${manifest.name}\` must match the directory`);
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
    throw new Error(`${pluginName}: manifest version \`${manifest.version}\` must be semver`);
  }
  if (manifest.checksums) throw new Error(`${pluginName}: source manifest must not carry checksums (they are added when packing)`);
  return manifest;
}

/**
 * Packs one plugin into `<outputDirectory>/<name>-<version>.tar.gz`.
 *
 * @param pluginName - Plugin directory name (string)
 * @param options - Packing options
 * @param options.outputDirectory - Where the tarball is written (string)
 * @returns `{name, version, tag, tarballName, tarballPath, sha256, sizeBytes, manifest, readmeText}` (object)
 * @throws Error - When npm fails, a symlink or forbidden file would be shipped, or the manifest is invalid
 */
export function packPlugin(pluginName, { outputDirectory }) {
  const sourceManifest = readSourceManifest(pluginName);
  const stagingRoot = join(outputDirectory, ".staging");
  const stagedDirectory = join(stagingRoot, pluginName);
  rmSync(stagedDirectory, { recursive: true, force: true });
  try {
    copyTrackedSourceFiles(pluginName, stagedDirectory);
    installProductionDependencies(stagedDirectory);
    const stagedFiles = listStagedFiles(stagedDirectory);
    const releasedManifest = withChecksums(sourceManifest, computeChecksums(stagedDirectory, stagedFiles));
    writeFileSync(join(stagedDirectory, MANIFEST_FILE_NAME), `${JSON.stringify(releasedManifest, null, 2)}\n`);
    const tarballBytes = createTarGz(buildArchiveEntries(stagedDirectory, pluginName), { mtimeSeconds: lastCommitTime(pluginName) });
    const tarballName = tarballNameFor(pluginName, sourceManifest.version);
    const tarballPath = join(outputDirectory, tarballName);
    writeFileSync(tarballPath, tarballBytes);
    return {
      name: pluginName,
      version: sourceManifest.version,
      tag: releaseTagFor(pluginName, sourceManifest.version),
      tarballName,
      tarballPath,
      sha256: sha256Hex(tarballBytes),
      sizeBytes: tarballBytes.length,
      manifest: releasedManifest,
      readmeText: existsSync(join(stagedDirectory, README_FILE_NAME)) ? readFileSync(join(stagedDirectory, README_FILE_NAME), "utf8") : null,
    };
  } finally {
    rmSync(stagedDirectory, { recursive: true, force: true });
  }
}

/**
 * Lists the plugin files git tracks, minus tests and dotfiles, so untracked local
 * state (profiles, .env files, caches) can never reach a release.
 */
function copyTrackedSourceFiles(pluginName, stagedDirectory) {
  const gitResult = spawnSync("git", ["ls-files", "-z", "--", pluginName], { cwd: REPO_ROOT, encoding: "utf8" });
  if (gitResult.status !== 0) throw new Error(`${pluginName}: git ls-files failed: ${gitResult.stderr}`);
  const trackedPaths = gitResult.stdout.split("\0").filter(Boolean).map((trackedPath) => trackedPath.slice(pluginName.length + 1));
  const shippedPaths = trackedPaths.filter((pluginPath) => isShippedSourcePath(pluginPath));
  if (!shippedPaths.includes("plugin.mjs")) throw new Error(`${pluginName}: plugin.mjs is not tracked by git`);
  for (const pluginPath of shippedPaths) {
    const sourcePath = join(REPO_ROOT, pluginName, pluginPath);
    if (!lstatSync(sourcePath).isFile()) throw new Error(`${pluginName}: \`${pluginPath}\` is not a regular file`);
    mkdirSync(join(stagedDirectory, pluginPath, ".."), { recursive: true });
    cpSync(sourcePath, join(stagedDirectory, pluginPath));
  }
}

/**
 * Says whether a tracked plugin file goes into the release tarball.
 *
 * @param pluginPath - `/`-separated path inside the plugin directory (string)
 * @returns False for tests, node_modules, dotfiles and catalog-only files such as icon.svg (boolean)
 */
export function isShippedSourcePath(pluginPath) {
  const segments = pluginPath.split("/");
  if (EXCLUDED_SOURCE_DIRECTORIES.has(segments[0])) return false;
  if (segments.length === 1 && EXCLUDED_SOURCE_FILES.has(pluginPath)) return false;
  return !segments.some((segment) => segment.startsWith("."));
}

/**
 * Runs `npm ci --omit=dev` when the plugin has npm dependencies. Browser downloads
 * and install scripts are disabled: the host installs Playwright's Chromium later.
 */
function installProductionDependencies(stagedDirectory) {
  const packageJsonPath = join(stagedDirectory, "package.json");
  if (!existsSync(packageJsonPath)) return;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (Object.keys(packageJson.dependencies ?? {}).length === 0) return;
  if (!existsSync(join(stagedDirectory, "package-lock.json"))) throw new Error(`${stagedDirectory}: dependencies need a package-lock.json`);
  const npmResult = spawnSync(
    "npm",
    ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: stagedDirectory, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } },
  );
  if (npmResult.status !== 0) throw new Error(`${stagedDirectory}: npm ci failed (exit ${npmResult.status})`);
  pruneDependencyExtras(join(stagedDirectory, "node_modules"));
}

const NPM_METADATA_DIRECTORIES = new Set([".bin", ".cache"]);
// Dependencies' own test suites (e.g. ssh2's fixture certificates) are never needed at runtime.
const PACKAGE_TEST_DIRECTORIES = new Set(["test", "tests", "__tests__"]);

/**
 * Drops what an installed plugin never needs from its node_modules: `.bin` link directories and
 * caches anywhere, and the test folders at each dependency's package root (not deeper, so a
 * runtime `lib/test` folder stays).
 *
 * @param nodeModulesDirectory - The staged plugin's node_modules (string)
 */
export function pruneDependencyExtras(nodeModulesDirectory) {
  if (!existsSync(nodeModulesDirectory)) return;
  for (const entry of readdirSync(nodeModulesDirectory, { withFileTypes: true, recursive: true })) {
    if (!entry.isDirectory()) continue;
    const isMetadata = NPM_METADATA_DIRECTORIES.has(entry.name);
    const isPackageTests = PACKAGE_TEST_DIRECTORIES.has(entry.name) && isPackageRoot(nodeModulesDirectory, entry.parentPath);
    if (isMetadata || isPackageTests) rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
  }
}

// `node_modules/<name>` or `node_modules/@scope/<name>`, also inside nested node_modules folders.
function isPackageRoot(nodeModulesDirectory, directory) {
  const segments = relative(nodeModulesDirectory, directory).split(sep);
  const parentSegment = segments.at(-2);
  if (segments.length === 1) return !segments[0].startsWith("@");
  if (parentSegment === "node_modules") return !segments.at(-1).startsWith("@");
  return parentSegment?.startsWith("@") === true && (segments.length === 2 || segments.at(-3) === "node_modules");
}

/**
 * Walks the staged plugin and returns its files as `/`-separated relative paths.
 *
 * @throws Error - On a symlink, special file or forbidden path
 */
function listStagedFiles(stagedDirectory) {
  const stagedFiles = [];
  for (const entry of readdirSync(stagedDirectory, { withFileTypes: true, recursive: true })) {
    const relativePath = relative(stagedDirectory, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`${stagedDirectory}: symlink \`${relativePath}\` cannot be shipped`);
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new Error(`${stagedDirectory}: \`${relativePath}\` is not a regular file`);
    assertAllowedPath(relativePath);
    stagedFiles.push(relativePath);
  }
  return stagedFiles.sort();
}

/**
 * Rejects paths that must never ship in a release.
 *
 * @param relativePath - Path inside the plugin directory (string)
 * @throws Error - When the path matches a forbidden pattern
 */
export function assertAllowedPath(relativePath) {
  const forbidden = FORBIDDEN_PATH_PATTERNS.find(({ pattern }) => pattern.test(relativePath));
  if (forbidden) throw new Error(`refusing to ship \`${relativePath}\` (${forbidden.reason})`);
}

/**
 * Says whether a staged file is pinned in the manifest `checksums`.
 *
 * @param relativePath - Path inside the plugin directory (string)
 * @returns True for code and JSON files outside node_modules, except the manifest (boolean)
 */
export function isPinnedPath(relativePath) {
  if (relativePath === MANIFEST_FILE_NAME) return false;
  if (relativePath.split("/").includes("node_modules")) return false;
  return PINNED_EXTENSIONS.some((extension) => relativePath.endsWith(extension));
}

function computeChecksums(stagedDirectory, stagedFiles) {
  return Object.fromEntries(
    stagedFiles.filter((relativePath) => isPinnedPath(relativePath)).map((relativePath) => [relativePath, sha256Hex(readFileSync(join(stagedDirectory, relativePath)))]),
  );
}

/**
 * Returns a copy of the manifest with `checksums` placed right after the runtime fields.
 *
 * @param manifest - Source manifest (object)
 * @param checksums - Relative path to sha256 map (object)
 * @returns The manifest to ship (object)
 * @throws Error - When the entrypoint plugin.mjs is not pinned
 */
export function withChecksums(manifest, checksums) {
  if (!checksums["plugin.mjs"]) throw new Error(`${manifest.name}: the entrypoint plugin.mjs must be pinned`);
  const releasedManifest = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "nodes") releasedManifest.checksums = checksums;
    releasedManifest[key] = value;
  }
  releasedManifest.checksums ??= checksums;
  return releasedManifest;
}

function buildArchiveEntries(stagedDirectory, pluginName) {
  const archiveEntries = [{ path: pluginName, type: "directory" }];
  for (const entry of readdirSync(stagedDirectory, { withFileTypes: true, recursive: true })) {
    const absolutePath = join(entry.parentPath, entry.name);
    const archivePath = `${pluginName}/${relative(stagedDirectory, absolutePath).split(sep).join("/")}`;
    if (entry.isDirectory()) {
      archiveEntries.push({ path: archivePath, type: "directory" });
    } else if (entry.isFile()) {
      const executable = (lstatSync(absolutePath).mode & 0o111) !== 0;
      archiveEntries.push({ path: archivePath, type: "file", content: readFileSync(absolutePath), executable });
    } else {
      throw new Error(`${archivePath}: only regular files and directories can be archived`);
    }
  }
  return archiveEntries;
}

/** Commit time of the plugin's last change: a stable mtime so repacking is reproducible. */
function lastCommitTime(pluginName) {
  const gitResult = spawnSync("git", ["log", "-1", "--format=%ct", "--", pluginName], { cwd: REPO_ROOT, encoding: "utf8" });
  const commitSeconds = Number.parseInt(gitResult.stdout.trim(), 10);
  return Number.isFinite(commitSeconds) ? commitSeconds : 0;
}

/** @returns Lowercase hex sha256 of the bytes (string) */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Builds one catalog entry from a released manifest and its tarball.
 *
 * Nodes carry their `config_schema` (verbatim) and `outputs` (when the manifest
 * declares them) so an agent builder can write correct steps for a plugin that is
 * not installed yet. These are additive fields: schema-1 readers ignore them.
 *
 * @param releasedManifest - The manifest inside the tarball (object)
 * @param tarball - The published tarball (object)
 * @param tarball.sha256 - Hex sha256 of the tarball bytes (string)
 * @param tarball.sizeBytes - Tarball size (number)
 * @param tarball.readmeText - The plugin README shipped in the tarball, or null (string|null)
 * @param pluginStatuses - Maturity labels by plugin name (object, default: the repo's plugin-status.json). They come
 *   from the repo at catalog time, not from the tarball, so relabelling a plugin needs no new release
 * @param readIcon - Returns `{assetName}` for a plugin name (function, default: readPluginIcon). Like the status, the
 *   icon comes from the repo at catalog time; `icon_url` points at its content-addressed `catalog` release asset
 * @returns A catalog `plugins[]` entry (object)
 * @throws Error - When the plugin has no entry in plugin-status.json, or no valid icon.svg
 */
export function buildCatalogEntry(releasedManifest, { sha256, sizeBytes, readmeText = null }, pluginStatuses = readPluginStatuses(), readIcon = readPluginIcon) {
  const { name, version } = releasedManifest;
  const statusEntry = statusForPlugin(pluginStatuses, name);
  const { assetName: iconAssetName } = readIcon(name);
  const tag = releaseTagFor(name, version);
  const permissions = releasedManifest.permissions ?? {};
  const manifestNodes = releasedManifest.nodes ?? [];
  return {
    name,
    display_name: displayNameFor(name),
    version,
    description: releasedManifest.description ?? "",
    icon_url: releaseAssetUrl(CATALOG_TAG, iconAssetName),
    tarball_url: releaseAssetUrl(tag, tarballNameFor(name, version)),
    sha256,
    size_bytes: sizeBytes,
    permissions: { network: Boolean(permissions.network), secrets: Boolean(permissions.secrets), env: permissions.env ?? [] },
    needs_browser: needsBrowser(releasedManifest),
    node: NODE_REQUIREMENT,
    warning: readmeText ? extractCatalogWarning(readmeText) : null,
    status: statusEntry.status,
    status_reason: statusEntry.reason,
    tos_risk: statusEntry.tos_risk,
    operations_count: manifestNodes.length,
    nodes: manifestNodes.map((manifestNode) => buildCatalogNode(manifestNode)),
    tools: (releasedManifest.tools ?? []).map((tool) => tool.name),
    readme_url: `https://github.com/${RELEASE_REPOSITORY}/blob/${tag}/${name}/README.md`,
  };
}

/**
 * Describes one manifest node for the catalog.
 *
 * @param manifestNode - A `nodes[]` entry of the released manifest (object)
 * @returns `{kind, title, description, config_schema, outputs?}` (object)
 */
export function buildCatalogNode({ kind, title, description, config_schema: configSchema, outputs }) {
  const catalogNode = { kind, title: title ?? kind, description: description ?? "", config_schema: configSchema ?? { type: "object" } };
  if (Array.isArray(outputs)) catalogNode.outputs = outputs;
  return catalogNode;
}

/**
 * Extracts `> **Warning:** ...` blockquotes from a plugin README so release pages
 * and the catalog carry the same warning users see in the setup guide.
 *
 * @param readmeText - README markdown (string)
 * @returns Warning blockquotes, each as markdown (string[])
 */
export function extractReadmeWarnings(readmeText) {
  const warnings = [];
  let currentQuote = null;
  const flushQuote = () => {
    if (currentQuote && /\*\*Warning/i.test(currentQuote[0])) warnings.push(currentQuote.join("\n"));
    currentQuote = null;
  };
  for (const line of readmeText.split("\n")) {
    if (line.startsWith(">")) {
      currentQuote ??= [];
      currentQuote.push(line);
      continue;
    }
    flushQuote();
  }
  flushQuote();
  return warnings;
}

/**
 * The catalog `warning`: the first README warning blockquote as one line of text,
 * without the quote markers and the `**Warning:**` label (inline markdown kept).
 *
 * @param readmeText - README markdown (string)
 * @returns The warning text, or null when the README has no warning blockquote (string|null)
 */
export function extractCatalogWarning(readmeText) {
  const [firstWarning] = extractReadmeWarnings(readmeText);
  if (!firstWarning) return null;
  const warningText = firstWarning
    .split("\n")
    .map((line) => line.replace(/^>\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/^\*\*Warning:?\*\*:?\s*/i, "");
  return warningText || null;
}

/**
 * Describes a published tarball from its own bytes: sha256, size, the shipped
 * manifest and README. The catalog is built from this, never from local sources,
 * so it matches what was released.
 *
 * @param tarballName - Asset name, e.g. `meta-api-0.1.0.tar.gz` (string)
 * @param tarballBytes - The tarball bytes (Buffer)
 * @returns `{tarballName, sha256, sizeBytes, manifest, readmeText}` (object)
 * @throws Error - When the tarball has no top-level `<name>/graphrt-plugin.json`
 */
export function describeTarballBytes(tarballName, tarballBytes) {
  const archiveEntries = readTarGz(tarballBytes);
  const findTopLevelFile = (fileName) =>
    archiveEntries.find((entry) => entry.type === "file" && entry.path.endsWith(`/${fileName}`) && entry.path.split("/").length === 2);
  const manifestEntry = findTopLevelFile(MANIFEST_FILE_NAME);
  if (!manifestEntry) throw new Error(`${tarballName}: tarball has no ${MANIFEST_FILE_NAME}`);
  const readmeEntry = findTopLevelFile(README_FILE_NAME);
  return {
    tarballName,
    sha256: sha256Hex(tarballBytes),
    sizeBytes: tarballBytes.length,
    manifest: JSON.parse(manifestEntry.content.toString("utf8")),
    readmeText: readmeEntry ? readmeEntry.content.toString("utf8") : null,
  };
}

/**
 * Lists how a rebuilt catalog differs from the previous one in what it must keep:
 * every previous plugin still listed, with the same version, sha256 and size.
 *
 * @param previousCatalog - The catalog currently published (object)
 * @param nextEntries - The rebuilt catalog entries (object[])
 * @returns Human-readable differences; empty when nothing was dropped or changed (string[])
 */
export function findCatalogRegressions(previousCatalog, nextEntries) {
  const nextByName = new Map(nextEntries.map((entry) => [entry.name, entry]));
  const regressions = [];
  for (const previousEntry of previousCatalog.plugins ?? []) {
    const nextEntry = nextByName.get(previousEntry.name);
    if (!nextEntry) {
      regressions.push(`${previousEntry.name}: missing from the rebuilt catalog`);
      continue;
    }
    for (const field of ["version", "sha256", "size_bytes", "tarball_url"]) {
      if (previousEntry[field] !== nextEntry[field]) regressions.push(`${previousEntry.name}: ${field} ${previousEntry[field]} -> ${nextEntry[field]}`);
    }
  }
  return regressions;
}

/** A plugin needs a browser when it depends on Playwright (detected from the checked-in package.json). */
function needsBrowser(releasedManifest) {
  const packageJsonPath = join(REPO_ROOT, releasedManifest.name, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  const dependencies = JSON.parse(readFileSync(packageJsonPath, "utf8")).dependencies ?? {};
  return Object.keys(dependencies).some((dependencyName) => dependencyName === "playwright" || dependencyName === "playwright-core");
}

/**
 * Builds the catalog document (`index.json`).
 *
 * @param catalogEntries - Entries from buildCatalogEntry (object[])
 * @param generatedAt - Generation time (Date)
 * @returns The catalog (object)
 */
export function buildCatalog(catalogEntries, generatedAt) {
  return {
    schema: CATALOG_SCHEMA_VERSION,
    generated_at: generatedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    plugins: [...catalogEntries].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Formats a `SHA256SUMS` file (the `sha256sum` format: `<hex>  <file name>`).
 *
 * @param fileHashes - `{fileName, sha256}` pairs (object[])
 * @returns File contents (string)
 */
export function formatSha256Sums(fileHashes) {
  return [...fileHashes]
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map(({ fileName, sha256 }) => `${sha256}  ${fileName}\n`)
    .join("");
}
