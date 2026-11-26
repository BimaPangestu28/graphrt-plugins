/**
 * Packs agent skills into release archives, to look at what a publish would ship (see docs/skills.md).
 *
 * Usage: node scripts/pack-skills.mjs [skill-name...] [--out <dir>]
 *   skill-name  skills to pack (default: every directory under `skills/`)
 *   --out       output directory (default: dist/skills)
 *
 * Writes `<out>/skill-<name>-<version>.tar.gz` per skill (one directory `<name>/` with the files git tracks),
 * reads each archive back with the checks a publish runs, and prints its sha256 and catalog entry. Packing
 * copies text into an archive: no dependency is installed and nothing of a skill is run.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./plugins.mjs";
import { buildSkillCatalogEntry, describeSkillTarballBytes, listSkillNames, packSkill } from "./lib/skill-package.mjs";

/**
 * Parses command line arguments.
 *
 * @param argumentList - process.argv without node and the script (string[])
 * @param knownSkills - Skill names of the repository (string[])
 * @returns `{skillNames, outputDirectory}` (object)
 * @throws Error - On an unknown skill name or option
 */
export function parsePackSkillArguments(argumentList, knownSkills) {
  let outputDirectory = resolve(REPO_ROOT, "dist", "skills");
  const skillNames = [];
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === "--out") outputDirectory = resolve(argumentList[++index] ?? "");
    else if (argument.startsWith("-")) throw new Error(`unknown option ${argument}`);
    else if (!knownSkills.includes(argument)) throw new Error(`unknown skill \`${argument}\` (known: ${knownSkills.join(", ")})`);
    else skillNames.push(argument);
  }
  return { skillNames: skillNames.length > 0 ? skillNames : knownSkills, outputDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { skillNames, outputDirectory } = parsePackSkillArguments(process.argv.slice(2), listSkillNames());
    for (const skillName of skillNames) {
      const packed = packSkill(skillName, { outputDirectory });
      const described = describeSkillTarballBytes(packed.tarballName, readFileSync(packed.tarballPath));
      console.log(`${packed.sha256}  ${packed.tarballName}  (${packed.sizeBytes} bytes)`);
      console.log(JSON.stringify(buildSkillCatalogEntry(described)));
    }
  } catch (error) {
    console.error(`pack-skills: ${error.message}`);
    process.exit(1);
  }
}
