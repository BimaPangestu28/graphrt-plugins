/**
 * The community plugin registry (`community-plugins.json` at the repo root): third-party plugins that live in
 * their developers' own GitHub repositories and are listed in the official catalog after review.
 *
 * Each entry pins one reviewed release by its tag and the sha256 of its tarball:
 *
 * ```json
 * "acme-crm": {
 *   "repository_url": "https://github.com/acme/graphrt-acme-crm",
 *   "tag": "v1.2.0",
 *   "tarball_url": "https://github.com/acme/graphrt-acme-crm/releases/download/v1.2.0/acme-crm-1.2.0.tar.gz",
 *   "tarball_sha256": "<64 hex>",
 *   "publisher": "Acme Inc.", "display_name": "Acme CRM",
 *   "status": "beta", "status_reason": "...", "tos_risk": "none",
 *   "reviewed_by": "<maintainer GitHub login>", "reviewed_at": "YYYY-MM-DD"
 * }
 * ```
 *
 * The plugin version is the tag without its leading `v`. Publishing mirrors a canonical repack of the reviewed tarball into a
 * release of this repo (`community-<name>-v<version>`), so the catalog never links to the developer's repo for
 * a download. docs/community-plugins.md describes the process; community-ingest.mjs does the mirroring.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";
import { MAX_DISPLAY_NAME_LENGTH } from "./plugin-names.mjs";
import { findStatusFieldProblems } from "./plugin-status.mjs";

export const COMMUNITY_PLUGINS_FILE_NAME = "community-plugins.json";
/** Longest plugin name; a release tag `community-<name>-v<version>` must stay readable. */
export const MAX_COMMUNITY_NAME_LENGTH = 64;
/** Longest `publisher` the desktop app shows (catalog spec: <= 60 characters). */
export const MAX_PUBLISHER_LENGTH = 60;
export const MAX_URL_LENGTH = 300;
export const MAX_TAG_LENGTH = 64;
export const MAX_STATUS_REASON_LENGTH = 500;
export const MAX_TOS_NOTES_LENGTH = 2000;
/** GitHub logins are at most 39 characters. */
export const MAX_REVIEWER_LENGTH = 39;

const REQUIRED_FIELDS = [
  "repository_url", "tag", "tarball_url", "tarball_sha256", "publisher", "display_name", "status", "status_reason", "tos_risk",
  "reviewed_by", "reviewed_at",
];
const OPTIONAL_FIELDS = ["tos_notes"];
const KNOWN_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
const STRING_LIMITS = {
  repository_url: MAX_URL_LENGTH, tag: MAX_TAG_LENGTH, tarball_url: MAX_URL_LENGTH, tarball_sha256: 64, publisher: MAX_PUBLISHER_LENGTH,
  display_name: MAX_DISPLAY_NAME_LENGTH, status: 20, status_reason: MAX_STATUS_REASON_LENGTH, tos_risk: 20, tos_notes: MAX_TOS_NOTES_LENGTH,
  reviewed_by: MAX_REVIEWER_LENGTH, reviewed_at: 10,
};
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";
const TAG_PATTERN = new RegExp(`^v?(${SEMVER_PATTERN})$`);
const GITHUB_REPOSITORY_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// Control characters, and bidi overrides that could make a publisher or name read differently than it is.
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
/** Value of `reviewed_by` / `reviewed_at` in a contributor's PR until the reviewing maintainer fills them in. */
export const PENDING_REVIEW = "pending";
// Names a third party must not present itself as.
const RESERVED_PUBLISHER_PATTERN = /graphrt/i;

/**
 * Reads `community-plugins.json`.
 *
 * @param filePath - File to read (string, default: the repo root file)
 * @returns Plugin name to registry entry (object)
 * @throws Error - When the file is missing, not valid JSON or not a JSON object
 */
export function readCommunityPlugins(filePath = join(REPO_ROOT, COMMUNITY_PLUGINS_FILE_NAME)) {
  const registry = JSON.parse(readFileSync(filePath, "utf8"));
  if (registry === null || typeof registry !== "object" || Array.isArray(registry)) throw new Error(`${COMMUNITY_PLUGINS_FILE_NAME} must hold a JSON object`);
  return registry;
}

/**
 * Top-level directories of this repo (every official plugin, plus `shared`, `scripts`, `docs`, ...): a community
 * plugin name must not collide with any of them.
 *
 * @param repositoryRoot - Repository root (string, default: this repo)
 * @returns Directory names (string[])
 */
export function listRepoDirectoryNames(repositoryRoot = REPO_ROOT) {
  return readdirSync(repositoryRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** @returns Tag of the mirror release of a community plugin version, e.g. `community-acme-crm-v1.2.0` (string) */
export function communityReleaseTagFor(pluginName, pluginVersion) {
  return `community-${pluginName}-v${pluginVersion}`;
}

/**
 * The plugin version a registry tag names.
 *
 * @param tag - Registry `tag`, e.g. `v1.2.0` or `1.2.0` (string)
 * @returns The version, e.g. `1.2.0`, or null when the tag is not `v<semver>` / `<semver>` (string|null)
 */
export function versionFromTag(tag) {
  return TAG_PATTERN.exec(tag ?? "")?.[1] ?? null;
}

/**
 * The only tarball URL an entry may name: the release asset `<name>-<version>.tar.gz` of `tag` in
 * `repository_url`.
 *
 * @param pluginName - Plugin name (string)
 * @param registryEntry - `{repository_url, tag}` (object)
 * @returns The expected URL, or null when the tag carries no version (string|null)
 */
export function expectedTarballUrl(pluginName, { repository_url: repositoryUrl, tag }) {
  const version = versionFromTag(tag);
  if (!version) return null;
  return `${repositoryUrl}/releases/download/${tag}/${pluginName}-${version}.tar.gz`;
}

/**
 * Lists every problem in the registry.
 *
 * @param registry - Plugin name to registry entry (object)
 * @param officialPluginNames - Top-level directories of this repo (plugins and others such as `shared`) (string[])
 * @returns Human-readable problems, each prefixed with the plugin name; empty when the registry is valid (string[])
 */
export function findCommunityPluginProblems(registry, officialPluginNames) {
  if (registry === null || typeof registry !== "object" || Array.isArray(registry)) return [`${COMMUNITY_PLUGINS_FILE_NAME} must hold a JSON object`];
  return Object.entries(registry).flatMap(([pluginName, registryEntry]) => findCommunityEntryProblems(pluginName, registryEntry, officialPluginNames));
}

/**
 * Lists the problems of one registry entry.
 *
 * @param pluginName - The entry's key (string)
 * @param registryEntry - The entry (object)
 * @param officialPluginNames - Top-level directories of this repo (string[])
 * @returns Human-readable problems; empty when the entry is valid (string[])
 */
export function findCommunityEntryProblems(pluginName, registryEntry, officialPluginNames) {
  const nameProblems = findNameProblems(pluginName, officialPluginNames);
  if (registryEntry === null || typeof registryEntry !== "object" || Array.isArray(registryEntry)) return [...nameProblems, `${pluginName}: entry must be an object`];
  const fieldProblems = findFieldShapeProblems(pluginName, registryEntry);
  if (fieldProblems.length > 0) return [...nameProblems, ...fieldProblems];
  return [
    ...nameProblems,
    ...findSourceProblems(pluginName, registryEntry),
    ...findListingProblems(pluginName, registryEntry),
    ...findStatusFieldProblems(pluginName, { ...registryEntry, reason: registryEntry.status_reason }),
  ];
}

function findNameProblems(pluginName, officialPluginNames) {
  const problems = [];
  if (pluginName.length > MAX_COMMUNITY_NAME_LENGTH || !PLUGIN_NAME_PATTERN.test(pluginName)) {
    problems.push(`${pluginName}: name must be lowercase letters, digits and single hyphens (at most ${MAX_COMMUNITY_NAME_LENGTH} characters)`);
  }
  if (officialPluginNames.includes(pluginName)) problems.push(`${pluginName}: name collides with an official plugin or directory of this repo`);
  // An official `community-<name>` would publish to the same release tag as this entry's mirror.
  if (officialPluginNames.includes(`community-${pluginName}`)) problems.push(`${pluginName}: name collides with the official plugin community-${pluginName}`);
  return problems;
}

/** Required fields are present, every field is known, and every value is a bounded, printable string. */
function findFieldShapeProblems(pluginName, registryEntry) {
  const problems = [];
  for (const fieldName of REQUIRED_FIELDS) {
    if (!Object.hasOwn(registryEntry, fieldName)) problems.push(`${pluginName}: missing \`${fieldName}\``);
  }
  for (const [fieldName, fieldValue] of Object.entries(registryEntry)) {
    if (!KNOWN_FIELDS.has(fieldName)) problems.push(`${pluginName}: unknown field \`${fieldName}\``);
    else if (typeof fieldValue !== "string") problems.push(`${pluginName}: \`${fieldName}\` must be a string`);
    else if (fieldValue.trim() === "" || fieldValue !== fieldValue.trim()) problems.push(`${pluginName}: \`${fieldName}\` must be non-empty without surrounding whitespace`);
    else if (fieldValue.length > STRING_LIMITS[fieldName]) problems.push(`${pluginName}: \`${fieldName}\` is longer than ${STRING_LIMITS[fieldName]} characters`);
    else if (UNSAFE_TEXT_PATTERN.test(fieldValue)) problems.push(`${pluginName}: \`${fieldName}\` holds control or bidi characters`);
  }
  return problems;
}

/** Repository, tag, tarball URL and checksum. */
function findSourceProblems(pluginName, registryEntry) {
  const problems = [];
  const repositoryMatch = GITHUB_REPOSITORY_URL_PATTERN.exec(registryEntry.repository_url);
  if (!repositoryMatch || [".", ".."].includes(repositoryMatch[2]) || repositoryMatch[2].endsWith(".git")) {
    problems.push(`${pluginName}: repository_url must be https://github.com/<owner>/<repo> (no .git suffix, no trailing slash)`);
  }
  if (!versionFromTag(registryEntry.tag)) problems.push(`${pluginName}: tag \`${registryEntry.tag}\` must be v<semver> or <semver>, e.g. v1.2.0`);
  const tarballUrl = expectedTarballUrl(pluginName, registryEntry);
  if (repositoryMatch && tarballUrl && registryEntry.tarball_url !== tarballUrl) {
    problems.push(`${pluginName}: tarball_url must be the release asset of the tag in repository_url: ${tarballUrl}`);
  }
  if (!registryEntry.tarball_url.startsWith("https://")) problems.push(`${pluginName}: tarball_url must be https`);
  if (!SHA256_PATTERN.test(registryEntry.tarball_sha256)) problems.push(`${pluginName}: tarball_sha256 must be 64 lowercase hex characters`);
  return problems;
}

/** Publisher, display name and review record. */
function findListingProblems(pluginName, registryEntry) {
  const problems = [];
  if (RESERVED_PUBLISHER_PATTERN.test(registryEntry.publisher)) problems.push(`${pluginName}: publisher must not name graphrt (official plugins only)`);
  if (registryEntry.reviewed_by === PENDING_REVIEW || registryEntry.reviewed_at === PENDING_REVIEW) {
    problems.push(`${pluginName}: not reviewed yet (a maintainer sets reviewed_by and reviewed_at before merging)`);
    return problems;
  }
  if (!GITHUB_LOGIN_PATTERN.test(registryEntry.reviewed_by)) problems.push(`${pluginName}: reviewed_by must be the reviewing maintainer's GitHub login`);
  if (!isCalendarDate(registryEntry.reviewed_at)) problems.push(`${pluginName}: reviewed_at \`${registryEntry.reviewed_at}\` must be a date, YYYY-MM-DD`);
  return problems;
}

/**
 * A copy of an entry whose review fields are still `pending`, with stand-ins that pass validation, so a
 * contributor can run every other check (`verify-plugins.mjs --community`) before the review. Never used when
 * publishing.
 *
 * @param registryEntry - Registry entry (object)
 * @returns The entry, or a copy with stand-in review fields (object)
 */
export function withPendingReviewStandIns(registryEntry) {
  if (registryEntry?.reviewed_by !== PENDING_REVIEW && registryEntry?.reviewed_at !== PENDING_REVIEW) return registryEntry;
  return { ...registryEntry, reviewed_by: "pending-review", reviewed_at: new Date().toISOString().slice(0, 10) };
}

function isCalendarDate(dateText) {
  const dateMatch = DATE_PATTERN.exec(dateText);
  if (!dateMatch) return false;
  const parsedDate = new Date(`${dateText}T00:00:00Z`);
  return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().startsWith(dateText);
}
