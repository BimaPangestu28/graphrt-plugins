/**
 * Validates the agent skills under `skills/` (see docs/skills.md): each `SKILL.md` frontmatter and its limits,
 * the directory name, the allowed file types and sizes, tool requests against the plugins of this repo, and the
 * wording graphrt's install-time scan would flag. It reads files only: nothing of a skill is run.
 *
 * Usage: node scripts/check-skills.mjs [--lenient] [--root <dir>]
 *   (default)   strict, for pull requests (`npm run check`, ci.yml): exit 1 and a list of problems when invalid
 *   --lenient   for the release flow (`npm run check:release`): print each problem as a GitHub error annotation
 *               and exit 0, because the publish skips an invalid skill and must still release plugins
 *   --root      repository to check instead of this one (tests); the community name check is then left out
 */
import { COMMUNITY_PLUGINS_FILE_NAME, readCommunityPlugins } from "./lib/community-plugins.mjs";
import { SKILLS_DIRECTORY_NAME, findSkillsDirectoryProblems, readCatalogTools } from "./lib/skill-package.mjs";

const argumentList = process.argv.slice(2);
const lenient = argumentList.includes("--lenient");
const rootFlagIndex = argumentList.indexOf("--root");
const repositoryRoot = rootFlagIndex === -1 ? undefined : argumentList[rootFlagIndex + 1];

let problems;
let skills = [];
try {
  const catalogTools = readCatalogTools(repositoryRoot);
  let communityNames = [];
  try {
    if (repositoryRoot === undefined) communityNames = Object.keys(readCommunityPlugins());
  } catch {
    // An unreadable registry is check-community-plugins.mjs's finding, not a skill problem.
    console.error(`cannot read ${COMMUNITY_PLUGINS_FILE_NAME}; skipping the community name check`);
  }
  ({ problems, skills } = findSkillsDirectoryProblems(repositoryRoot, { catalogTools, reservedNameCandidates: [...catalogTools.keys(), ...communityNames] }));
} catch (error) {
  problems = [{ skill: null, message: `cannot read ${SKILLS_DIRECTORY_NAME}/: ${error.message}` }];
}
const describeProblem = ({ skill, message }) => (skill ? `${SKILLS_DIRECTORY_NAME}/${skill}: ${message}` : message);
if (problems.length === 0) {
  console.error(`${skills.length} skill(s) under ${SKILLS_DIRECTORY_NAME}/ are valid.`);
} else if (lenient) {
  for (const problem of problems) console.log(`::error title=${problem.skill ? `skill ${problem.skill}` : SKILLS_DIRECTORY_NAME}::${describeProblem(problem).replace(/[\r\n%]/g, " ")} (the publish skips an invalid skill)`);
  console.error(`${SKILLS_DIRECTORY_NAME}/ has ${problems.length} problem(s); continuing because the publish skips invalid skills.`);
} else {
  console.error(`${SKILLS_DIRECTORY_NAME}/ is invalid:\n  ${problems.map(describeProblem).join("\n  ")}`);
  process.exit(1);
}
