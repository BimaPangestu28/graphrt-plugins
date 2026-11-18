/**
 * Renders the GitHub release notes for one plugin release.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";
import { RELEASE_REPOSITORY, releaseAssetUrl } from "./plugin-package.mjs";

/**
 * Extracts `> **Warning:** ...` blockquotes from a plugin README so the release
 * page carries the same warning users see in the setup guide.
 *
 * @param readmeText - README markdown (string)
 * @returns Warning blockquotes, each as markdown (string[])
 */
export function extractReadmeWarnings(readmeText) {
  const warnings = [];
  let currentQuote = null;
  for (const line of readmeText.split("\n")) {
    if (line.startsWith(">")) {
      currentQuote ??= [];
      currentQuote.push(line);
      continue;
    }
    if (currentQuote && /\*\*Warning/i.test(currentQuote[0])) warnings.push(currentQuote.join("\n"));
    currentQuote = null;
  }
  if (currentQuote && /\*\*Warning/i.test(currentQuote[0])) warnings.push(currentQuote.join("\n"));
  return warnings;
}

/**
 * Renders release notes: description, operation count, setup link, permissions,
 * browser requirement, README warnings and the tarball checksum.
 *
 * @param packed - A packPlugin result ({name, version, tag, tarballName, sha256, sizeBytes, manifest}) (object)
 * @returns Markdown (string)
 */
export function renderReleaseNotes(packed) {
  const { manifest } = packed;
  const permissions = manifest.permissions ?? {};
  const readmePath = join(REPO_ROOT, packed.name, "README.md");
  const warnings = existsSync(readmePath) ? extractReadmeWarnings(readFileSync(readmePath, "utf8")) : [];
  const playwrightVersion = readLockedVersion(packed.name, "playwright");
  const lines = [
    manifest.description ?? "",
    "",
    ...warnings.flatMap((warning) => [warning, ""]),
    `- **Operations:** ${manifest.nodes.length} (nodes \`${packed.name}.<operation>\`; ${manifest.tools?.length ?? 0} agent tools)`,
    `- **Setup:** https://github.com/${RELEASE_REPOSITORY}/blob/${packed.tag}/${packed.name}/README.md`,
    `- **Permissions:** network: ${Boolean(permissions.network)}, secrets: ${Boolean(permissions.secrets)}` +
      (permissions.env?.length ? `, env: ${permissions.env.map((name) => `\`${name}\``).join(", ")}` : ", env: none"),
    `- **Requires:** Node.js >= 20${playwrightVersion ? `; Chromium for the bundled Playwright ${playwrightVersion} (not included: after installing, run \`node node_modules/playwright/cli.js install chromium\` inside the installed plugin directory)` : ""}`,
    "",
    "## Install",
    "```bash",
    `curl -LO ${releaseAssetUrl(packed.tag, packed.tarballName)}`,
    `echo "${packed.sha256}  ${packed.tarballName}" | shasum -a 256 -c`,
    `tar -xzf ${packed.tarballName}`,
    `graphrt plugin install ./${packed.name}`,
    "```",
    "",
    `\`${packed.tarballName}\` sha256 \`${packed.sha256}\` (${packed.sizeBytes} bytes). Every \`.mjs\`/\`.js\`/\`.cjs\`/\`.json\` file outside \`node_modules\` is pinned in the manifest's \`checksums\`.`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Reads the version of a dependency pinned in the plugin's package-lock.json.
 *
 * @param pluginName - Plugin directory name (string)
 * @param dependencyName - npm package name (string)
 * @returns The locked version, or null when the plugin does not depend on it (string|null)
 */
export function readLockedVersion(pluginName, dependencyName) {
  const lockPath = join(REPO_ROOT, pluginName, "package-lock.json");
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, "utf8")).packages?.[`node_modules/${dependencyName}`]?.version ?? null;
}
