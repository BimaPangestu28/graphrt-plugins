/**
 * Verifies one plugin release tarball the way a host will use it (used by scripts/verify-plugins.mjs, the publish
 * and the community ingest): the strict reader (tar-archive.mjs) accepts it, every entry is a file or directory
 * with a safe path under one top-level `<name>/` directory, no forbidden files ship, `plugin.mjs` (or, for an MCP preset, its guide) is present and
 * pinned, every `checksums` entry matches, npm dependencies are installed and, with a graphrt binary,
 * `graphrt plugin install` and `graphrt plugin list` accept it.
 *
 * The archive is never extracted with the system `tar`: tar implementations disagree on duplicate entries, PAX
 * overrides and links, so the files checked here could differ from the files a host installs. Instead the parsed
 * entries (regular files and directories only) are written into a fresh mkdtemp, and the whole temporary root
 * is walked afterwards to refuse anything that is not a regular file or directory. `graphrt plugin install
 * --dir` writes into a second, separate mkdtemp, so nothing in the extracted tree can redirect it, and graphrt
 * runs with an isolated environment (isolated-environment.mjs).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { buildIsolatedEnvironment } from "./isolated-environment.mjs";
import { assertAllowedPath, assertEntrypointPinned, isMcpPreset, MANIFEST_FILE_NAME, sha256Hex } from "./plugin-package.mjs";
import { readTarGz } from "./tar-archive.mjs";

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
  const pluginName = assertSingleTopLevelDirectory(archiveEntries);
  const extractionRoot = mkdtempSync(join(tmpdir(), "graphrt-plugin-verify-"));
  try {
    writeArchiveEntries(archiveEntries, extractionRoot);
    assertOnlyFilesAndDirectories(extractionRoot);
    const pluginDirectory = join(extractionRoot, pluginName);
    assertShippableTree(pluginDirectory);
    const manifest = JSON.parse(readFileSync(join(pluginDirectory, MANIFEST_FILE_NAME), "utf8"));
    assertManifestMatchesTarball(manifest, pluginName, basename(tarballPath));
    assertChecksumsMatch(pluginDirectory, manifest.checksums ?? {});
    assertDependenciesInstalled(pluginDirectory);
    if (graphrtBinary) assertGraphrtAccepts(graphrtBinary, pluginDirectory, pluginName);
    return { name: pluginName, version: manifest.version, pinnedFiles: Object.keys(manifest.checksums).length };
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
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

/**
 * Writes strictly parsed archive entries (files and directories only) into an empty directory. A file is
 * created exclusively (`wx`), so it can never replace or write through anything already there.
 *
 * @param archiveEntries - Entries from readTarGz (object[])
 * @param extractionRoot - An empty directory this process created (string)
 * @throws Error - On an entry type other than file or directory, or a path that resolves outside the root
 */
export function writeArchiveEntries(archiveEntries, extractionRoot) {
  const rootPath = resolve(extractionRoot);
  for (const entry of archiveEntries) {
    const targetPath = resolve(rootPath, ...entry.path.split("/"));
    if (!targetPath.startsWith(`${rootPath}${sep}`)) throw new Error(`archive path \`${entry.path}\` resolves outside the extraction directory`);
    if (entry.type === "directory") {
      mkdirSync(targetPath, { recursive: true });
    } else if (entry.type === "file") {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, entry.content, { flag: "wx", mode: (entry.mode & 0o111) !== 0 ? 0o755 : 0o644 });
    } else {
      throw new Error(`refusing to extract \`${entry.path}\` of type ${entry.type}`);
    }
  }
}

/**
 * Walks a whole directory tree and refuses anything that is not a regular file or directory (symlinks, FIFOs,
 * sockets, devices), wherever it is.
 *
 * @param rootDirectory - Directory to walk (string)
 * @throws Error - Naming the first offending path, relative to rootDirectory
 */
export function assertOnlyFilesAndDirectories(rootDirectory) {
  for (const entry of readdirSync(rootDirectory, { withFileTypes: true, recursive: true })) {
    const relativePath = relative(rootDirectory, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`\`${relativePath}\` is a symlink`);
    if (!entry.isFile() && !entry.isDirectory()) throw new Error(`\`${relativePath}\` is not a regular file or directory`);
  }
}

function assertShippableTree(pluginDirectory) {
  for (const entry of readdirSync(pluginDirectory, { withFileTypes: true, recursive: true })) {
    const relativePath = relative(pluginDirectory, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (entry.isDirectory() && entry.name === ".bin") throw new Error(`\`${relativePath}\` must be dropped`);
    if (entry.isFile()) assertAllowedPath(relativePath);
  }
}

function assertManifestMatchesTarball(manifest, pluginName, tarballFileName) {
  if (manifest.name !== pluginName) throw new Error(`manifest name \`${manifest.name}\` does not match directory \`${pluginName}\``);
  if (tarballFileName !== `${manifest.name}-${manifest.version}.tar.gz`) {
    throw new Error(`tarball name \`${tarballFileName}\` does not match ${manifest.name} ${manifest.version}`);
  }
  if (isMcpPreset(manifest)) {
    assertEntrypointPinned(manifest, manifest.checksums ?? {});
  } else if (!manifest.checksums?.["plugin.mjs"]) {
    throw new Error("the entrypoint plugin.mjs is not pinned in checksums");
  }
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

/**
 * `graphrt plugin install/list` may start the plugin, so they run with an isolated environment (no tokens, a
 * temporary HOME, only PATH and a few locale variables) in their own temporary directory.
 */
function assertGraphrtAccepts(graphrtBinary, pluginDirectory, pluginName) {
  const installRoot = mkdtempSync(join(tmpdir(), "graphrt-plugin-install-"));
  try {
    const installDirectory = join(installRoot, "plugins");
    const commandOptions = { encoding: "utf8", env: buildIsolatedEnvironment(join(installRoot, "home")), cwd: installRoot };
    const installResult = spawnSync(graphrtBinary, ["plugin", "install", pluginDirectory, "--dir", installDirectory], commandOptions);
    if (installResult.status !== 0) throw new Error(`graphrt plugin install failed: ${installResult.stderr || installResult.stdout}`);
    const listResult = spawnSync(graphrtBinary, ["plugin", "list", "--json", "--no-default-plugins", "--plugins", installDirectory], commandOptions);
    if (listResult.status !== 0) throw new Error(`graphrt plugin list failed: ${listResult.stderr || listResult.stdout}`);
    const listedPlugin = JSON.parse(listResult.stdout).find((summary) => summary.name === pluginName);
    if (!listedPlugin) throw new Error(`graphrt plugin list does not show ${pluginName}`);
    if (listedPlugin.error) throw new Error(`graphrt reports a load error: ${listedPlugin.error}`);
    const expectedNodeCount = JSON.parse(readFileSync(join(pluginDirectory, MANIFEST_FILE_NAME), "utf8")).nodes?.length ?? 0;
    if (listedPlugin.nodes.length !== expectedNodeCount) {
      throw new Error(`graphrt lists ${listedPlugin.nodes.length} nodes, the manifest declares ${expectedNodeCount}`);
    }
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
}
