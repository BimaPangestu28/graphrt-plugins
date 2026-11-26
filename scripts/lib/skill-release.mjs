/**
 * Releases the agent skills of `skills/` the way plugins are released (publish-plugins.mjs runs this with gh):
 * each skill version gets its own release `skill-<name>-v<version>` with the asset
 * `skill-<name>-<version>.tar.gz`, created once and never modified, and the catalog entry is built from the
 * published archive's own bytes.
 *
 * A skill that fails its own checks (invalid sources, uncommitted changes, a published archive that no longer
 * passes) is skipped with its reason and never fails the plugin publish; pull requests get the strict check
 * (`npm run check`, scripts/check-skills.mjs), so `main` should hold only valid skills. A failure of the GitHub
 * side (reading, creating or uploading a release) is not caught: like for plugins it stops the publish, so a
 * network error can never silently drop a listed skill from the catalog.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";
import { SKILL_FILE_NAME, parseSkillFile } from "./skill-frontmatter.mjs";
import {
  SKILLS_DIRECTORY_NAME, buildSkillCatalogEntry, describeSkillTarballBytes, isValidSkillName, listSkillNames, packSkill, skillReleaseTagFor, skillTarballNameFor,
} from "./skill-package.mjs";

/** `kind` of a skipped skill in the publish summary (skipped plugins carry none, community plugins a `source`). */
export const SKILL_KIND = "skill";

/**
 * Reads the version of a skill from its `SKILL.md` (`metadata.version`).
 *
 * @param skillName - Skill directory name (string)
 * @param repositoryRoot - Repository root (string, default: this repo)
 * @returns The version (string)
 * @throws Error - When the name is not a skill name, or `SKILL.md` is missing, unreadable or has no version
 */
export function readSkillVersion(skillName, repositoryRoot = REPO_ROOT) {
  if (!isValidSkillName(skillName)) throw new Error(`\`${skillName}\` is not a skill name`);
  const { frontmatter } = parseSkillFile(readFileSync(join(repositoryRoot, SKILLS_DIRECTORY_NAME, skillName, SKILL_FILE_NAME), "utf8"));
  const version = frontmatter.metadata.version;
  if (typeof version !== "string" || version === "") throw new Error(`${SKILLS_DIRECTORY_NAME}/${skillName}/${SKILL_FILE_NAME} has no metadata.version`);
  return version;
}

/**
 * Renders the notes of a skill release.
 *
 * @param packed - A packed skill from packSkill (object)
 * @returns Markdown (string)
 */
export function renderSkillReleaseNotes({ skill, tarballName, sha256, sizeBytes }) {
  const toolLines = skill.allowedTools.length > 0
    ? ["Tools it asks for (none is granted until the person installing it ticks it):", "", ...skill.allowedTools.map((tool) => `- \`${tool}\``)]
    : ["It asks for no tools."];
  return [
    `Agent skill **${skill.displayName}** (\`${skill.name}\`) ${skill.version}.`,
    "",
    skill.description,
    "",
    ...toolLines,
    "",
    `- Archive: \`${tarballName}\` (${sizeBytes} bytes), one directory \`${skill.name}/\` with \`${SKILL_FILE_NAME}\` and its reference files. Text only: nothing in it is run.`,
    `- sha256: \`${sha256}\``,
    "",
    "Install it from the catalog in Graphrt Desktop (Skills), or extract it and run `graphrt skill install ./" + skill.name + "`.",
    "",
  ].join("\n");
}

/**
 * Releases every skill that has no release for its version yet, and returns what the catalog lists.
 *
 * @param options - Release options
 * @param options.outputDirectory - Where archives are written (string)
 * @param options.dryRun - Pack and check only; create and upload nothing (boolean)
 * @param options.catalogOnly - List only what is already published; pack and create nothing (boolean)
 * @param options.releases - The GitHub side (object):
 *   `planAction(tag, assetName)` returns "create", "upload" (the release exists without the asset) or "exists";
 *   `downloadAsset(tag, assetName)` returns the published bytes (Buffer);
 *   `createRelease(packed, notes)` creates the release with the archive; `uploadAsset(tag, path)` adds the
 *   missing archive to a half-created release
 * @param options.assertCommitted - Throws when `skills/<name>` differs from the commit being released
 *   (function of the repository-relative path)
 * @param options.skillNames - Skills to consider (string[], default: every directory under `skills/`)
 * @param options.repositoryRoot - Repository root (string, default: this repo)
 * @param options.log - Progress output (function, default: console.error)
 * @throws Error - Whatever `options.releases` throws
 * @returns `{released, skipped}`: released holds `{name, version, tarballName, sha256, sizeBytes, catalogEntry}`
 *   per listed skill, skipped `{name, kind: "skill", reason}` (object)
 */
export function releaseSkills({ outputDirectory, dryRun = false, catalogOnly = false, releases, assertCommitted = () => {}, skillNames = undefined, repositoryRoot = REPO_ROOT, log = console.error }) {
  const released = [];
  const skipped = [];
  const skip = (skillName, error) => {
    log(`skill ${skillName}: skipped: ${error.message}`);
    skipped.push({ name: skillName, kind: SKILL_KIND, reason: error.message });
  };
  const list = (described) => released.push({ name: described.skill.name, version: described.skill.version, tarballName: described.tarballName, sha256: described.sha256, sizeBytes: described.sizeBytes, catalogEntry: buildSkillCatalogEntry(described) });
  // The download is not caught (see the module comment); a published archive that fails the checks skips the skill.
  const listPublished = (skillName, tag, tarballName, describeStatus = () => {}) => {
    const publishedBytes = releases.downloadAsset(tag, tarballName);
    try {
      const published = describeSkillTarballBytes(tarballName, publishedBytes);
      if (published.skill.name !== skillName) throw new Error(`${tag}: the published archive holds the skill ${published.skill.name}`);
      describeStatus(published);
      list(published);
    } catch (error) {
      skip(skillName, error);
    }
  };
  for (const skillName of skillNames ?? listSkillNames(repositoryRoot)) {
    if (catalogOnly) {
      let version;
      try {
        version = readSkillVersion(skillName, repositoryRoot);
      } catch (error) {
        skip(skillName, error);
        continue;
      }
      const [tag, tarballName] = [skillReleaseTagFor(skillName, version), skillTarballNameFor(skillName, version)];
      const releaseAction = releases.planAction(tag, tarballName);
      if (releaseAction === "upload") log(`${tag}: release exists without its archive; a publish resumes it`);
      if (releaseAction === "exists") listPublished(skillName, tag, tarballName);
      continue;
    }
    let packed;
    let verified;
    try {
      assertCommitted(`${SKILLS_DIRECTORY_NAME}/${skillName}`);
      packed = packSkill(skillName, { outputDirectory, repositoryRoot });
      // Read the archive back the way a reader will: what is listed is what the strict reader and the validator accept.
      verified = describeSkillTarballBytes(packed.tarballName, readFileSync(packed.tarballPath));
    } catch (error) {
      skip(skillName, error);
      continue;
    }
    const releaseAction = releases.planAction(packed.tag, packed.tarballName);
    if (releaseAction === "exists") {
      listPublished(skillName, packed.tag, packed.tarballName, (published) => {
        log(`${packed.tag}: already published, ${published.sha256 === packed.sha256 ? "unchanged" : "differs from the local build (bump metadata.version to ship changes)"}`);
      });
      continue;
    }
    if (releaseAction === "upload") {
      log(`${packed.tag}: release exists without ${packed.tarballName}; ${dryRun ? "would upload" : "uploading"} it (${packed.sha256})`);
      if (!dryRun) releases.uploadAsset(packed.tag, packed.tarballPath);
    } else {
      log(`${packed.tag}: ${dryRun ? "would create" : "creating"} release (${packed.sha256})`);
      if (!dryRun) releases.createRelease(packed, renderSkillReleaseNotes(packed));
    }
    list(verified);
  }
  return { released, skipped };
}
