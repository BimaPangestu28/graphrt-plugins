/**
 * Validates community-plugins.json (schema, names that collide with this repo's directories, URLs, checksum,
 * lengths, status and ToS labels). It does not download anything: the tarball checks run at publish time, or on
 * demand with `node scripts/verify-plugins.mjs --community <name>`.
 *
 * Usage: node scripts/check-community-plugins.mjs   (exit 1 and a list of problems when the registry is invalid)
 */
import { COMMUNITY_PLUGINS_FILE_NAME, findCommunityPluginProblems, listRepoDirectoryNames, readCommunityPlugins } from "./lib/community-plugins.mjs";

let problems;
try {
  problems = findCommunityPluginProblems(readCommunityPlugins(), listRepoDirectoryNames());
} catch (error) {
  problems = [`cannot read ${COMMUNITY_PLUGINS_FILE_NAME}: ${error.message}`];
}
if (problems.length > 0) {
  console.error(`${COMMUNITY_PLUGINS_FILE_NAME} is invalid:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.error(`${COMMUNITY_PLUGINS_FILE_NAME} is valid.`);
