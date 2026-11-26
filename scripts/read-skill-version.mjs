/**
 * Prints the `metadata.version` of one skill's SKILL.md, for the release workflow (which compares it with a
 * pushed `skill-<name>-v<version>` tag). The skill name comes from a git tag, so it is validated and the file is
 * read with fs: nothing is interpolated into code.
 *
 * Usage: node scripts/read-skill-version.mjs <skill-name>
 *   exit 0 and the version on stdout, or exit 1 and an error on stderr
 */
import { readSkillVersion } from "./lib/skill-release.mjs";

try {
  if (process.argv.length !== 3) throw new Error("usage: node scripts/read-skill-version.mjs <skill-name>");
  console.log(readSkillVersion(process.argv[2]));
} catch (error) {
  console.error(`read-skill-version: ${error.message}`);
  process.exit(1);
}
