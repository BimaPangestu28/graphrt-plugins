/**
 * Agent skills of the catalog: validation, packing and the `skills[]` entries of the signed `index-v2.json`.
 *
 * A skill is a directory `skills/<name>/` with a `SKILL.md` (Agent Skills specification) and optional reference
 * text files. It is published like a plugin, through the same strict tar writer and reader, as the asset
 * `skill-<name>-<version>.tar.gz` of the release `skill-<name>-v<version>`; the archive holds one top-level
 * directory `<name>/`. The catalog entry is derived from the published bytes, never from local sources.
 *
 * The rules are those of graphrt's skill runtime (crate graphrt-skill: name, description, sizes, file names, the
 * install-time scan) and of graphrt-builder-desktop's catalog reader (version, display name, archive size), plus
 * a stricter catalog policy: text files of a few known types only, no `scripts/`, no executable files, a tool
 * request must name a tool of a plugin in this repo, and nothing the install-time scan would warn about.
 * Packing copies bytes into an archive and runs nothing: no npm, no hooks, no file of the skill is executed.
 *
 * One validator (findSkillProblems) checks both the sources and the entries of a published archive.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";
import {
  MANIFEST_FILE_NAME, OFFICIAL_PUBLISHER, assertAllowedPath, lastCommitTime, listPluginNames, releaseAssetUrl, sha256Hex,
} from "./plugin-package.mjs";
import { MAX_DISPLAY_NAME_LENGTH } from "./plugin-names.mjs";
import { SKILL_FILE_NAME, parseSkillFile } from "./skill-frontmatter.mjs";
import { createTarGz, readTarGz } from "./tar-archive.mjs";
import { assertSingleTopLevelDirectory } from "./tarball-verification.mjs";

export { SKILL_FILE_NAME };
/** Directory at the repository root that holds one directory per skill. */
export const SKILLS_DIRECTORY_NAME = "skills";
/** Prefix of a skill's release tag and archive name; no plugin name may start with it. */
export const SKILL_RELEASE_PREFIX = "skill-";
/** Longest skill name (specification and graphrt-skill). */
export const MAX_SKILL_NAME_LENGTH = 64;
/** Longest description, in characters (specification and graphrt-skill). */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
/** Longest `compatibility`, in characters (specification and graphrt-skill). */
export const MAX_SKILL_COMPATIBILITY_LENGTH = 500;
/** Longest license or metadata value, in characters (graphrt-skill cuts longer ones). */
export const MAX_SKILL_LABEL_LENGTH = 300;
/** Longest version (the desktop app's `is_safe_version`). */
export const MAX_SKILL_VERSION_LENGTH = 64;
/** Most `allowed-tools` entries (graphrt-skill reads no more). */
export const MAX_SKILL_TOOL_REQUESTS = 64;
/**
 * Longest `SKILL.md`, in characters. graphrt accepts 256 KiB, but an agent gets the instructions as one tool
 * result, cut at 32,000 characters by default: longer instructions belong in reference files.
 */
export const MAX_SKILL_FILE_CHARACTERS = 24_000;
/** Most files in a catalog skill, `SKILL.md` included (graphrt accepts 256). */
export const MAX_SKILL_FILES = 32;
/** Largest single file of a catalog skill (graphrt accepts 1 MiB). */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
/** Largest sum of all files of a catalog skill (graphrt accepts 8 MiB). */
export const MAX_SKILL_TOTAL_BYTES = 1024 * 1024;
/** Deepest directory nesting below the skill directory (graphrt-skill). */
export const MAX_SKILL_DIRECTORY_DEPTH = 5;
/** Longest file or directory name, in bytes (graphrt-skill). */
export const MAX_SKILL_PATH_COMPONENT_BYTES = 128;
/** Largest skill archive the desktop app downloads (`MAX_SKILL_ARCHIVE_BYTES`). */
export const MAX_SKILL_ARCHIVE_BYTES = 8 * 1024 * 1024;
/** Most bytes a skill archive may unpack to: the files plus tar headers and padding. */
export const MAX_SKILL_UNPACKED_BYTES = 2 * MAX_SKILL_TOTAL_BYTES;
/** File types a catalog skill may hold: instructions and reference text, nothing that is run. */
export const SKILL_FILE_EXTENSIONS = [".md", ".txt", ".csv", ".json"];

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_VERSION_PATTERN = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const TOOL_REFERENCE_PART_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Names of other package formats (Agent Plugins, npm, graphrt plugins): a catalog skill is a plain skill directory. */
const FORBIDDEN_FILE_NAMES = new Set(["package.json", "package-lock.json", "plugin.json", "hooks.json", "mcp.json", MANIFEST_FILE_NAME]);
/** Directory that holds executable code in the specification. graphrt never runs it; the catalog does not ship it. */
const SCRIPTS_DIRECTORY_NAME = "scripts";
const WINDOWS_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
const UNSAFE_FILE_NAME_CHARACTER_PATTERN = /[\p{Cc}/\\:*?"<>|]/u;
/**
 * Characters a reader cannot see or that reorder the text around them (graphrt-skill `hidden_character`, widened
 * to every Unicode format character): control characters other than tab and line feed, zero-width and
 * bidirectional formatting, the Unicode tag block. A carriage return counts too: catalog skills use LF line endings.
 */
const HIDDEN_CHARACTER_PATTERN = /(?![\t\n])[\p{Cc}\p{Cf}\u{E0000}-\u{E007F}]/u;
/** Something shaped like a markup tag (graphrt-skill `looks_like_markup`): `<name`, `</`, `<!` or `<?`. */
const MARKUP_PATTERN = /<[A-Za-z/!?]/;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The install-time scan of graphrt-skill (scan.rs), "stop" and "warn" findings: a catalog skill must have none,
 * so that the review screen of the desktop app has nothing to flag. Phrases are matched per line, in lowercase.
 */
const SCAN_PHRASE_RULES = [
  { code: "overrides_instructions", phrases: [
    "ignore previous instructions", "ignore all previous", "ignore prior instructions", "ignore the above", "ignore your instructions",
    "disregard previous", "disregard all previous", "disregard your instructions", "disregard the above", "forget your instructions",
    "forget all previous", "override your instructions", "new system prompt", "developer mode",
  ] },
  { code: "hides_from_user", phrases: [
    "do not tell the user", "don't tell the user", "never tell the user", "without telling the user", "without informing the user",
    "without the user's knowledge", "without the user knowing", "do not mention this to", "don't mention this to", "do not reveal this", "secretly",
  ] },
  { code: "skips_approval", phrases: [
    "without asking for approval", "without approval", "without confirmation", "without asking the user", "do not ask for confirmation",
    "don't ask for confirmation", "do not ask for approval", "skip the approval", "skip approval", "always approve", "auto-approve",
  ] },
  { code: "touches_credentials", phrases: [
    ".aws/credentials", ".ssh/", "id_rsa", "id_ed25519", "/etc/passwd", "/etc/shadow", ".netrc", "wallet.dat", "seed phrase", "private key",
  ] },
];
const SCAN_DOWNLOADERS = ["curl ", "wget ", "invoke-webrequest", "iwr ", "base64 -d", "base64 --decode"];
const SCAN_RUNNERS = ["| sh", "|sh", "| bash", "|bash", "| zsh", "|zsh", "| python", "|python", "| node", "| iex", "|iex", "| source", "| sudo"];

/** @returns Tag of a skill release, e.g. `skill-refund-policy-v1.0.0` (string) */
export function skillReleaseTagFor(skillName, skillVersion) {
  return `${SKILL_RELEASE_PREFIX}${skillName}-v${skillVersion}`;
}

/** @returns Asset name of a skill archive, e.g. `skill-refund-policy-1.0.0.tar.gz` (string) */
export function skillTarballNameFor(skillName, skillVersion) {
  return `${SKILL_RELEASE_PREFIX}${skillName}-${skillVersion}.tar.gz`;
}

/**
 * Says whether a name follows the specification: 1 to 64 of `a-z`, `0-9` and `-`, no hyphen at either end and
 * no two in a row.
 *
 * @param skillName - Candidate name (unknown)
 * @returns True for a valid skill name (boolean)
 */
export function isValidSkillName(skillName) {
  return typeof skillName === "string" && skillName.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_PATTERN.test(skillName);
}

/**
 * Finds the first hidden character of a text.
 *
 * @param text - Text to check (string)
 * @returns `{line, codePoint}` (1-based line, `U+XXXX`) or null when every character is visible (object|null)
 */
export function findHiddenCharacter(text) {
  const match = HIDDEN_CHARACTER_PATTERN.exec(text);
  if (!match) return null;
  const line = text.slice(0, match.index).split("\n").length;
  return { line, codePoint: `U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}` };
}

/**
 * Runs the "stop" and "warn" checks of graphrt's install-time scan on one text file.
 *
 * @param filePath - Path inside the skill, for the messages (string)
 * @param text - The file's text (string)
 * @returns One message per finding (string[])
 */
export function scanSkillText(filePath, text) {
  const findings = [];
  const hidden = findHiddenCharacter(text);
  if (hidden) findings.push(`${filePath} line ${hidden.line}: invisible character ${hidden.codePoint} (hidden_characters)`);
  const reported = new Set();
  text.split("\n").forEach((rawLine, lineIndex) => {
    const line = rawLine.toLowerCase();
    const report = (code) => {
      if (reported.has(code)) return;
      reported.add(code);
      findings.push(`${filePath} line ${lineIndex + 1}: wording the install-time scan flags (${code})`);
    };
    if (SCAN_DOWNLOADERS.some((downloader) => line.includes(downloader)) && SCAN_RUNNERS.some((runner) => line.includes(runner))) report("download_and_run");
    for (const { code, phrases } of SCAN_PHRASE_RULES) {
      if (phrases.some((phrase) => line.includes(phrase))) report(code);
    }
  });
  return findings;
}

/**
 * Says whether an `allowed-tools` entry is a graphrt tool reference: `provider/tool` or `provider/*`.
 *
 * @param entry - One `allowed-tools` entry (string)
 * @returns True when graphrt can grant it (boolean)
 */
export function isToolReference(entry) {
  const separatorIndex = entry.indexOf("/");
  if (separatorIndex === -1) return false;
  const provider = entry.slice(0, separatorIndex);
  const tool = entry.slice(separatorIndex + 1);
  return TOOL_REFERENCE_PART_PATTERN.test(provider) && (tool === "*" || TOOL_REFERENCE_PART_PATTERN.test(tool));
}

/**
 * Reads the tools every plugin of this repo offers, for the `allowed-tools` check.
 *
 * @param repositoryRoot - Repository root (string, default: this repo)
 * @returns Plugin name to its tool names (Map<string, Set<string>>)
 */
export function readCatalogTools(repositoryRoot = REPO_ROOT) {
  const pluginNames = repositoryRoot === REPO_ROOT
    ? listPluginNames()
    : readdirSync(repositoryRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(repositoryRoot, entry.name, MANIFEST_FILE_NAME))).map((entry) => entry.name);
  return new Map(pluginNames.map((pluginName) => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, pluginName, MANIFEST_FILE_NAME), "utf8"));
    return [pluginName, new Set((manifest.tools ?? []).map((tool) => tool.name))];
  }));
}

/**
 * Validates one skill from its files, in memory. Used for the sources (`skills/<name>/`) and for the entries of
 * a published archive, so both are held to the same rules.
 *
 * @param skillName - The directory name the skill must carry (string)
 * @param skillFiles - `{path, content, executable?, regularFile?}` per file; `path` is `/`-separated and relative
 *   to the skill directory, `content` a Buffer, `regularFile` false for a link or special file (object[])
 * @param options - Validation options
 * @param options.catalogTools - Plugin name to tool names (Map, from readCatalogTools): every tool request must
 *   name one of them. null skips that check (a published archive is not re-judged against today's plugins)
 * @returns `{problems, skill}`: problems is empty for a valid skill; skill is `{name, version, displayName,
 *   description, allowedTools}` when `SKILL.md` could be read, else null (object)
 */
export function findSkillProblems(skillName, skillFiles, { catalogTools = null } = {}) {
  const problems = [];
  if (!isValidSkillName(skillName)) {
    problems.push(`the directory name \`${skillName}\` is not a valid skill name (1 to ${MAX_SKILL_NAME_LENGTH} of a-z, 0-9 and single hyphens)`);
  }
  problems.push(...findSkillFileProblems(skillFiles));
  const skillFile = skillFiles.find((file) => file.path === SKILL_FILE_NAME);
  if (!skillFile) return { problems: [...problems, `there is no ${SKILL_FILE_NAME}`], skill: null };
  const skillText = decodeText(skillFile.content);
  // A file that is not UTF-8 is already reported by findSkillFileProblems.
  if (skillText === null) return { problems, skill: null };
  if ([...skillText].length > MAX_SKILL_FILE_CHARACTERS) {
    problems.push(`${SKILL_FILE_NAME} is ${[...skillText].length} characters; keep it within ${MAX_SKILL_FILE_CHARACTERS} and move detail into reference files`);
  }
  let parsed;
  try {
    parsed = parseSkillFile(skillText);
  } catch (error) {
    return { problems: [...problems, error.message], skill: null };
  }
  const { frontmatter, body } = parsed;
  problems.push(...findFrontmatterProblems(skillName, frontmatter, catalogTools));
  if (body === "") problems.push(`${SKILL_FILE_NAME} has no instructions after the frontmatter`);
  const skill = {
    name: frontmatter.name,
    version: frontmatter.metadata.version,
    displayName: frontmatter.metadata.display_name?.trim(),
    description: frontmatter.description,
    allowedTools: frontmatter.allowedTools,
  };
  return { problems, skill };
}

function findFrontmatterProblems(skillName, frontmatter, catalogTools) {
  const problems = [];
  const { name, description, license, compatibility, metadata, allowedTools } = frontmatter;
  if (name === undefined) problems.push("the frontmatter needs a `name`");
  else if (!isValidSkillName(name)) problems.push(`\`name\` \`${name}\` is not valid (1 to ${MAX_SKILL_NAME_LENGTH} of a-z, 0-9 and single hyphens)`);
  else if (name !== skillName) problems.push(`\`name\` \`${name}\` must match the directory \`${skillName}\``);
  if (description === undefined) problems.push("the frontmatter needs a `description`");
  else problems.push(...findPromptTextProblems("description", description, MAX_SKILL_DESCRIPTION_LENGTH));
  if (compatibility !== undefined) problems.push(...findPromptTextProblems("compatibility", compatibility, MAX_SKILL_COMPATIBILITY_LENGTH));
  for (const [label, value] of [["license", license], ...Object.entries(metadata).map(([key, metadataValue]) => [`metadata \`${key}\``, metadataValue])]) {
    if (value !== undefined && [...value].length > MAX_SKILL_LABEL_LENGTH) problems.push(`${label} is longer than ${MAX_SKILL_LABEL_LENGTH} characters`);
  }
  const { version, display_name: displayName } = metadata;
  if (version === undefined) problems.push('the frontmatter needs `metadata.version` (semver, quoted: `version: "1.0.0"`)');
  else if (!SKILL_VERSION_PATTERN.test(version) || version.length > MAX_SKILL_VERSION_LENGTH) problems.push(`\`metadata.version\` \`${version}\` must be semver, e.g. "1.0.0"`);
  if (displayName === undefined) problems.push("the frontmatter needs `metadata.display_name` (the name people see)");
  else if (displayName.trim() === "" || [...displayName.trim()].length > MAX_DISPLAY_NAME_LENGTH) problems.push(`\`metadata.display_name\` must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters`);
  if (allowedTools.length > MAX_SKILL_TOOL_REQUESTS) problems.push(`\`allowed-tools\` lists ${allowedTools.length} tools (at most ${MAX_SKILL_TOOL_REQUESTS})`);
  if (new Set(allowedTools).size !== allowedTools.length) problems.push("`allowed-tools` lists a tool twice");
  for (const toolRequest of allowedTools) problems.push(...findToolRequestProblems(toolRequest, catalogTools));
  return problems;
}

/** The rules graphrt-skill applies to text placed in a system prompt: bounded, visible, nothing shaped like a tag. */
function findPromptTextProblems(field, text, maxCharacters) {
  const problems = [];
  if ([...text].length > maxCharacters) problems.push(`\`${field}\` is longer than ${maxCharacters} characters`);
  if (MARKUP_PATTERN.test(text)) problems.push(`\`${field}\` must not contain markup tags such as \`<tag>\``);
  return problems;
}

function findToolRequestProblems(toolRequest, catalogTools) {
  if (!isToolReference(toolRequest)) return [`\`allowed-tools\` entry \`${toolRequest}\` is not a graphrt tool (\`plugin/tool\` or \`plugin/*\`)`];
  if (!catalogTools) return [];
  const [pluginName, toolName] = [toolRequest.slice(0, toolRequest.indexOf("/")), toolRequest.slice(toolRequest.indexOf("/") + 1)];
  const pluginTools = catalogTools.get(pluginName);
  if (!pluginTools) return [`\`allowed-tools\` entry \`${toolRequest}\`: there is no plugin \`${pluginName}\` in this catalog`];
  if (toolName === "*") return pluginTools.size > 0 ? [] : [`\`allowed-tools\` entry \`${toolRequest}\`: plugin \`${pluginName}\` offers no tools`];
  return pluginTools.has(toolName) ? [] : [`\`allowed-tools\` entry \`${toolRequest}\`: plugin \`${pluginName}\` has no tool \`${toolName}\``];
}

function findSkillFileProblems(skillFiles) {
  const problems = [];
  if (skillFiles.length > MAX_SKILL_FILES) problems.push(`${skillFiles.length} files (at most ${MAX_SKILL_FILES})`);
  const totalBytes = skillFiles.reduce((sum, file) => sum + file.content.length, 0);
  if (totalBytes > MAX_SKILL_TOTAL_BYTES) problems.push(`the files add up to ${totalBytes} bytes (at most ${MAX_SKILL_TOTAL_BYTES})`);
  const seenLowercasePaths = new Set();
  for (const file of skillFiles) {
    const pathProblems = findSkillPathProblems(file.path);
    problems.push(...pathProblems);
    if (seenLowercasePaths.has(file.path.toLowerCase())) problems.push(`\`${file.path}\` differs from another file only in letter case`);
    seenLowercasePaths.add(file.path.toLowerCase());
    if (file.regularFile === false) {
      problems.push(`\`${file.path}\` is a link or a special file`);
      continue;
    }
    if (file.executable) problems.push(`\`${file.path}\` is executable; a skill holds text only`);
    if (file.content.length > MAX_SKILL_FILE_BYTES) problems.push(`\`${file.path}\` is ${file.content.length} bytes (at most ${MAX_SKILL_FILE_BYTES})`);
    const text = decodeText(file.content);
    if (text === null) problems.push(`\`${file.path}\` is not UTF-8 text`);
    else if (pathProblems.length === 0) problems.push(...scanSkillText(file.path, text));
  }
  return problems;
}

function findSkillPathProblems(filePath) {
  const problems = [];
  const segments = filePath.split("/");
  const fileName = segments.at(-1);
  if (segments.length - 1 > MAX_SKILL_DIRECTORY_DEPTH) problems.push(`\`${filePath}\` nests deeper than ${MAX_SKILL_DIRECTORY_DEPTH} directories`);
  for (const segment of segments) {
    const segmentProblem = findPathComponentProblem(segment);
    if (segmentProblem) problems.push(`\`${filePath}\`: ${segmentProblem}`);
  }
  try {
    assertAllowedPath(filePath);
  } catch (error) {
    problems.push(error.message);
  }
  if (segments[0] === SCRIPTS_DIRECTORY_NAME && segments.length > 1) problems.push(`\`${filePath}\`: catalog skills ship no \`${SCRIPTS_DIRECTORY_NAME}/\` (graphrt never runs them)`);
  if (FORBIDDEN_FILE_NAMES.has(fileName.toLowerCase())) problems.push(`\`${filePath}\`: \`${fileName}\` belongs to another package format`);
  if (!SKILL_FILE_EXTENSIONS.some((extension) => fileName.toLowerCase().endsWith(extension))) {
    problems.push(`\`${filePath}\`: only ${SKILL_FILE_EXTENSIONS.join(", ")} files are allowed`);
  }
  return problems;
}

/** The file name rules of graphrt-skill (`check_component`), plus no dotfiles. */
function findPathComponentProblem(component) {
  if (component === "" || component === "." || component === "..") return "empty and relative path segments are not allowed";
  if (component.startsWith(".")) return "hidden files and directories are not allowed";
  if (Buffer.byteLength(component) > MAX_SKILL_PATH_COMPONENT_BYTES) return "a file or directory name is too long";
  if (UNSAFE_FILE_NAME_CHARACTER_PATTERN.test(component) || findHiddenCharacter(component)) return "a name contains a character that is not allowed in file names";
  if (component.endsWith(".") || component.endsWith(" ") || component.startsWith(" ")) return "a name starts or ends with a space or ends with a dot";
  if (WINDOWS_DEVICE_NAMES.has(component.split(".")[0].toLowerCase())) return "a name is reserved on Windows";
  return null;
}

function decodeText(bytes) {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Lists the files of the `skills/` directory by skill, from git, so that local state git ignores can never reach
 * a release (as for plugins).
 *
 * @param repositoryRoot - Repository root (string, default: this repo)
 * @param options - Listing options
 * @param options.includeUntracked - Also list files git does not track yet and does not ignore (boolean, default
 *   false). The validator sets it so that a new skill is checked before its first commit; packing never does
 * @param options.commandEnvironment - Environment of git (object, default: process.env)
 * @returns `{pathsBySkill, strayPaths}`: skill directory name to the sorted `/`-separated paths inside it, and
 *   the files directly under `skills/` (Map<string, string[]>, string[])
 * @throws Error - When git fails (the repository root must be a git work tree)
 */
export function listSkillSourcePaths(repositoryRoot = REPO_ROOT, { includeUntracked = false, commandEnvironment = process.env } = {}) {
  const gitArguments = ["ls-files", "-z", "--cached", ...(includeUntracked ? ["--others", "--exclude-standard"] : []), "--", SKILLS_DIRECTORY_NAME];
  const gitResult = spawnSync("git", gitArguments, { cwd: repositoryRoot, encoding: "utf8", env: commandEnvironment });
  if (gitResult.status !== 0) throw new Error(`git ls-files failed in ${repositoryRoot}: ${gitResult.stderr}`);
  const pathsBySkill = new Map();
  const strayPaths = [];
  for (const repositoryPath of [...new Set(gitResult.stdout.split("\0").filter(Boolean))].sort()) {
    // A tracked file deleted from the work tree (not yet committed) is no longer part of the skill.
    if (!existsSync(join(repositoryRoot, repositoryPath))) continue;
    const [, skillName, ...rest] = repositoryPath.split("/");
    if (rest.length === 0) {
      strayPaths.push(repositoryPath);
      continue;
    }
    if (!pathsBySkill.has(skillName)) pathsBySkill.set(skillName, []);
    pathsBySkill.get(skillName).push(rest.join("/"));
  }
  return { pathsBySkill, strayPaths };
}

/**
 * Lists the skills of the repository.
 *
 * @param repositoryRoot - Repository root (string, default: this repo)
 * @returns Names of the directories under `skills/` that git tracks files in, sorted (string[])
 */
export function listSkillNames(repositoryRoot = REPO_ROOT) {
  return [...listSkillSourcePaths(repositoryRoot).pathsBySkill.keys()].sort();
}

/**
 * Reads the files of one skill directory for findSkillProblems.
 *
 * @param skillDirectory - The skill's directory (string)
 * @param relativePaths - `/`-separated paths inside it, from listSkillSourcePaths (string[])
 * @returns `{path, content, executable, regularFile}` per path; a link or special file has an empty content and
 *   `regularFile: false` (object[])
 */
export function readSkillFiles(skillDirectory, relativePaths) {
  return relativePaths.map((relativePath) => {
    const filePath = join(skillDirectory, ...relativePath.split("/"));
    const fileStatus = lstatSync(filePath);
    if (!fileStatus.isFile()) return { path: relativePath, content: Buffer.alloc(0), executable: false, regularFile: false };
    return { path: relativePath, content: readFileSync(filePath), executable: (fileStatus.mode & 0o111) !== 0, regularFile: true };
  });
}

/**
 * Validates the `skills/` directory of a repository: every skill, no file outside a skill directory, and no
 * plugin or community plugin whose name would collide with the skill release names.
 *
 * @param repositoryRoot - Repository root (string, default: this repo)
 * @param options - Validation options
 * @param options.catalogTools - As for findSkillProblems (Map, default: the repository's plugins)
 * @param options.reservedNameCandidates - Plugin and community plugin names to check against the `skill-` prefix
 *   (string[], default: the repository's plugin directories)
 * @returns `{problems, skills}`: problems holds `{skill, message}` (skill is null for a problem of the directory
 *   itself), skills the `{name, version, displayName, description, allowedTools}` of every valid skill (object)
 */
export function findSkillsDirectoryProblems(repositoryRoot = REPO_ROOT, { catalogTools = readCatalogTools(repositoryRoot), reservedNameCandidates = [...catalogTools.keys()] } = {}) {
  const problems = [];
  const skills = [];
  const { pathsBySkill, strayPaths } = listSkillSourcePaths(repositoryRoot, { includeUntracked: true });
  for (const strayPath of strayPaths) problems.push({ skill: null, message: `\`${strayPath}\`: only skill directories belong in ${SKILLS_DIRECTORY_NAME}/ (documentation is docs/skills.md)` });
  for (const pluginName of reservedNameCandidates.filter((name) => name.startsWith(SKILL_RELEASE_PREFIX))) {
    problems.push({ skill: null, message: `plugin \`${pluginName}\`: names starting with \`${SKILL_RELEASE_PREFIX}\` are reserved for skill releases` });
  }
  for (const [skillName, relativePaths] of [...pathsBySkill].sort(([left], [right]) => left.localeCompare(right))) {
    const skillFiles = readSkillFiles(join(repositoryRoot, SKILLS_DIRECTORY_NAME, skillName), relativePaths);
    const { problems: skillProblems, skill } = findSkillProblems(skillName, skillFiles, { catalogTools });
    problems.push(...skillProblems.map((message) => ({ skill: skillName, message })));
    if (skillProblems.length === 0) skills.push(skill);
  }
  return { problems, skills };
}

/**
 * Packs one skill into `<outputDirectory>/skill-<name>-<version>.tar.gz`. The archive holds the directory
 * `<name>/` with the files git tracks, written by the deterministic tar writer with the time of the skill's last
 * commit. Nothing is installed or run.
 *
 * @param skillName - Skill directory name (string)
 * @param options - Packing options
 * @param options.outputDirectory - Where the archive is written (string)
 * @param options.repositoryRoot - Repository root (string, default: this repo)
 * @param options.catalogTools - As for findSkillProblems (Map, default: the repository's plugins)
 * @param options.commandEnvironment - Environment of git (object, default: process.env)
 * @returns `{name, version, tag, tarballName, tarballPath, sha256, sizeBytes, skill}` (object)
 * @throws Error - When the skill is not tracked by git, fails validation or packs to more than the desktop app downloads
 */
export function packSkill(skillName, { outputDirectory, repositoryRoot = REPO_ROOT, catalogTools = readCatalogTools(repositoryRoot), commandEnvironment = process.env }) {
  const skillDirectory = join(repositoryRoot, SKILLS_DIRECTORY_NAME, skillName);
  const relativePaths = listSkillSourcePaths(repositoryRoot, { commandEnvironment }).pathsBySkill.get(skillName);
  if (!relativePaths) throw new Error(`skill ${skillName}: ${SKILLS_DIRECTORY_NAME}/${skillName} holds no file tracked by git`);
  const skillFiles = readSkillFiles(skillDirectory, relativePaths);
  const { problems, skill } = findSkillProblems(skillName, skillFiles, { catalogTools });
  if (problems.length > 0) throw new Error(`skill ${skillName} is invalid:\n  ${problems.join("\n  ")}`);
  const tarballBytes = createTarGz(buildSkillArchiveEntries(skillName, skillFiles), { mtimeSeconds: lastCommitTime(skillDirectory, commandEnvironment) });
  if (tarballBytes.length > MAX_SKILL_ARCHIVE_BYTES) throw new Error(`skill ${skillName}: the archive is ${tarballBytes.length} bytes; the desktop app downloads at most ${MAX_SKILL_ARCHIVE_BYTES}`);
  const tarballName = skillTarballNameFor(skillName, skill.version);
  const tarballPath = join(outputDirectory, tarballName);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(tarballPath, tarballBytes);
  return { name: skillName, version: skill.version, tag: skillReleaseTagFor(skillName, skill.version), tarballName, tarballPath, sha256: sha256Hex(tarballBytes), sizeBytes: tarballBytes.length, skill };
}

function buildSkillArchiveEntries(skillName, skillFiles) {
  const directoryPaths = new Set([skillName]);
  for (const { path } of skillFiles) {
    const segments = path.split("/").slice(0, -1);
    segments.forEach((_, index) => directoryPaths.add(`${skillName}/${segments.slice(0, index + 1).join("/")}`));
  }
  return [
    ...[...directoryPaths].map((directoryPath) => ({ path: directoryPath, type: "directory" })),
    ...skillFiles.map(({ path, content }) => ({ path: `${skillName}/${path}`, type: "file", content, executable: false })),
  ];
}

/**
 * Describes a skill archive from its own bytes, after checking it the way a reader will use it: within the
 * download limit, accepted by the strict tar reader, one top-level directory named like the skill, every file
 * valid (findSkillProblems), and an asset name that matches the name and version inside.
 *
 * @param tarballName - Asset name, e.g. `skill-refund-policy-1.0.0.tar.gz` (string)
 * @param tarballBytes - The archive bytes (Buffer)
 * @returns `{tarballName, sha256, sizeBytes, skill}`; skill is `{name, version, displayName, description, allowedTools}` (object)
 * @throws Error - On the first failed check
 */
export function describeSkillTarballBytes(tarballName, tarballBytes) {
  if (tarballBytes.length > MAX_SKILL_ARCHIVE_BYTES) throw new Error(`${tarballName}: ${tarballBytes.length} bytes; the desktop app downloads at most ${MAX_SKILL_ARCHIVE_BYTES}`);
  let archiveEntries;
  let skillName;
  try {
    archiveEntries = readTarGz(tarballBytes, { maxUnpackedBytes: MAX_SKILL_UNPACKED_BYTES });
    skillName = assertSingleTopLevelDirectory(archiveEntries);
  } catch (error) {
    throw new Error(`${tarballName}: ${error.message}`);
  }
  const skillFiles = archiveEntries
    .filter((entry) => entry.type === "file")
    .map((entry) => ({ path: entry.path.slice(skillName.length + 1), content: entry.content, executable: (entry.mode & 0o111) !== 0, regularFile: true }));
  const directoryProblems = archiveEntries
    .filter((entry) => entry.type === "directory")
    .flatMap((entry) => entry.path.split("/").slice(1).map((segment) => findPathComponentProblem(segment)).filter(Boolean).map((problem) => `\`${entry.path}/\`: ${problem}`));
  const { problems: fileProblems, skill } = findSkillProblems(skillName, skillFiles);
  const problems = [...directoryProblems, ...fileProblems];
  if (problems.length > 0) throw new Error(`${tarballName}: the skill inside is invalid:\n  ${problems.join("\n  ")}`);
  if (tarballName !== skillTarballNameFor(skill.name, skill.version)) throw new Error(`${tarballName}: the archive holds ${skill.name} ${skill.version}; expected the name ${skillTarballNameFor(skill.name, skill.version)}`);
  return { tarballName, sha256: sha256Hex(tarballBytes), sizeBytes: tarballBytes.length, skill };
}

/**
 * Builds one `skills[]` entry of the signed `index-v2.json`, in the format graphrt-builder-desktop reads
 * (`plugins/models.rs`, `CatalogSkill`).
 *
 * @param described - A published archive from describeSkillTarballBytes (or packSkill) (object)
 * @returns `{name, display_name, version, description, tarball_url, sha256, size_bytes, publisher}` (object)
 */
export function buildSkillCatalogEntry({ skill, sha256, sizeBytes }) {
  return {
    name: skill.name,
    display_name: skill.displayName,
    version: skill.version,
    description: skill.description,
    tarball_url: releaseAssetUrl(skillReleaseTagFor(skill.name, skill.version), skillTarballNameFor(skill.name, skill.version)),
    sha256,
    size_bytes: sizeBytes,
    publisher: OFFICIAL_PUBLISHER,
  };
}

/**
 * Lists how rebuilt skill entries differ from the live catalog in what they must keep: every listed skill still
 * there, with the same version, sha256, size and URL (as findCatalogRegressions does for plugins).
 *
 * @param previousCatalog - The catalog currently published (object)
 * @param nextSkillEntries - The rebuilt `skills[]` entries (object[])
 * @returns Human-readable differences; empty when nothing was dropped or changed (string[])
 */
export function findSkillCatalogRegressions(previousCatalog, nextSkillEntries) {
  const nextByName = new Map(nextSkillEntries.map((entry) => [entry.name, entry]));
  const regressions = [];
  for (const previousEntry of Array.isArray(previousCatalog.skills) ? previousCatalog.skills : []) {
    const nextEntry = nextByName.get(previousEntry.name);
    if (!nextEntry) {
      regressions.push(`skill ${previousEntry.name}: missing from the rebuilt catalog`);
      continue;
    }
    for (const field of ["version", "sha256", "size_bytes", "tarball_url"]) {
      if (previousEntry[field] !== nextEntry[field]) regressions.push(`skill ${previousEntry.name}: ${field} ${previousEntry[field]} -> ${nextEntry[field]}`);
    }
  }
  return regressions;
}
