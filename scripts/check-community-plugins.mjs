/**
 * Validates community-plugins.json (schema, names that collide with this repo's directories, URLs, checksum,
 * lengths, status and ToS labels). It does not download anything: the tarball checks run at publish time, or on
 * demand with `node scripts/verify-plugins.mjs --community <name>`.
 *
 * Usage: node scripts/check-community-plugins.mjs [--lenient] [--registry <file>]
 *   (default)   strict, for pull requests (`npm run check`, ci.yml): exit 1 and a list of problems when invalid
 *   --lenient   for the release flow (`npm run check:release`): print each problem as a GitHub error annotation
 *               and exit 0, because the publish skips invalid entries and must still release official plugins
 *   --registry  file to check instead of the repo's community-plugins.json (tests)
 */
import { COMMUNITY_PLUGINS_FILE_NAME, findCommunityPluginProblems, listRepoDirectoryNames, readCommunityPlugins } from "./lib/community-plugins.mjs";

const argumentList = process.argv.slice(2);
const lenient = argumentList.includes("--lenient");
const registryFlagIndex = argumentList.indexOf("--registry");
const registryPath = registryFlagIndex === -1 ? undefined : argumentList[registryFlagIndex + 1];

let problems;
try {
  problems = findCommunityPluginProblems(readCommunityPlugins(registryPath), listRepoDirectoryNames());
} catch (error) {
  problems = [`cannot read ${COMMUNITY_PLUGINS_FILE_NAME}: ${error.message}`];
}
if (problems.length === 0) {
  console.error(`${COMMUNITY_PLUGINS_FILE_NAME} is valid.`);
} else if (lenient) {
  for (const problem of problems) console.log(`::error title=${COMMUNITY_PLUGINS_FILE_NAME}::${problem.replace(/[\r\n%]/g, " ")} (the publish skips this entry)`);
  console.error(`${COMMUNITY_PLUGINS_FILE_NAME} has ${problems.length} problem(s); continuing because the publish skips invalid entries.`);
} else {
  console.error(`${COMMUNITY_PLUGINS_FILE_NAME} is invalid:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
