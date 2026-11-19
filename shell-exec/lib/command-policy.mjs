/**
 * Decides what may run, where, and with which environment.
 *
 * - The executable must be one of SHELL_EXEC_COMMANDS (absolute paths), named
 *   by that exact path or by its unique base name, and still be an executable
 *   regular file when the call starts.
 * - Tool calls also need a SHELL_EXEC_TOOL_RULES rule (see tool-rules.mjs), may
 *   not set environment variables, and may not run a program the plugin's
 *   user could replace.
 * - The working directory is realpath'd and must be inside
 *   SHELL_EXEC_ALLOWED_DIRS (separator-suffixed prefix).
 * - The child's environment is rebuilt from scratch: a fixed PATH, HOME, LANG
 *   and only what the workflow node passed, minus loader and interpreter
 *   start-up variables (LD_*, DYLD_*, NODE_OPTIONS, ...), which would let a
 *   node's env run code inside any program.
 */
import { constants as fileConstants } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { invalidInput, notFound, permissionDenied, setupRequired } from "./errors.mjs";
import { VARIABLES } from "./settings.mjs";

const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;
const MIN_REDACTABLE_LENGTH = 6;
const LOADER_PREFIX_PATTERN = /^(LD_|DYLD_)/;
const STARTUP_VARIABLES = new Set([
  "NODE_OPTIONS", "NODE_PATH", "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PERL5OPT", "PERL5LIB", "PERLLIB", "RUBYOPT", "RUBYLIB",
  "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_EXEC_PATH", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "LUA_INIT", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
]);

/**
 * Finds the allowlisted executable for a `command` argument.
 *
 * @param settings - From readShellExecSettings (object)
 * @param command - Base name or absolute path (string)
 * @returns `{path, name}` (object)
 * @throws PluginError kinds `setup_required` (empty allowlist), `permission_denied` (not allowlisted), `invalid_input` (ambiguous)
 */
export function findAllowedCommand(settings, command) {
  if (settings.commands.length === 0) throw setupRequired(`Set ${VARIABLES.commands} to the absolute paths of the executables this plugin may run (comma-separated)`);
  const matches = command.includes("/") ? settings.commands.filter((entry) => entry.path === command) : settings.commands.filter((entry) => entry.name === command);
  if (matches.length === 0) throw permissionDenied(`${JSON.stringify(command)} is not in ${VARIABLES.commands}`);
  if (matches.length > 1) throw invalidInput(`${JSON.stringify(command)} matches several entries of ${VARIABLES.commands}; use the absolute path`);
  return matches[0];
}

/**
 * For tool calls: refuses an executable whose real file, or the directory holding it, the plugin's user can write.
 * Such a file could be swapped by anything running as that user (for example a file-writing plugin an agent can
 * call), so an agent could choose what runs.
 *
 * @param fileSystem - fs promises API (object)
 * @param executablePath - Allowlisted path (string)
 * @throws PluginError kind `permission_denied`
 */
export async function assertNotUserWritable(fileSystem, executablePath) {
  const realPath = await fileSystem.realpath(executablePath);
  for (const candidate of [realPath, dirname(realPath)]) {
    const isWritable = await fileSystem.access(candidate, fileConstants.W_OK).then(() => true, () => false);
    if (isWritable) throw permissionDenied(`Agents may not run ${executablePath}: ${candidate} is writable by this user, so the program could be replaced; use a workflow node`);
  }
}

/**
 * Checks that the configured executable is still an executable regular file.
 *
 * @param fileSystem - fs promises API (object)
 * @param executablePath - Absolute path (string)
 * @throws PluginError kind `setup_required`
 */
export async function assertExecutable(fileSystem, executablePath) {
  const stats = await fileSystem.stat(executablePath).catch(() => null);
  if (!stats?.isFile() || (stats.mode & 0o111) === 0) throw setupRequired(`${executablePath} (from ${VARIABLES.commands}) is not an executable file`);
}

/**
 * Resolves the working directory inside the allowlist.
 *
 * @param client - `{settings, fileSystem}` (object)
 * @param requestedDirectory - Absolute, or relative to the first allowed directory (string, optional)
 * @returns Real directory path (Promise<string>)
 * @throws PluginError kinds `setup_required`, `not_found`
 */
export async function resolveWorkingDirectory({ settings, fileSystem }, requestedDirectory) {
  if (settings.allowedDirectories.length === 0) throw setupRequired(`Set ${VARIABLES.allowedDirs} to the directories commands may run in`);
  const roots = (await Promise.all(settings.allowedDirectories.map((directory) => fileSystem.realpath(directory).catch(() => null)))).filter(Boolean);
  if (roots.length === 0) throw setupRequired(`None of the ${VARIABLES.allowedDirs} directories exist`);
  if (typeof requestedDirectory === "string" && requestedDirectory.includes("\0")) throw invalidInput("`cwd` must not contain NUL characters");
  const givenPath = requestedDirectory === undefined ? roots[0] : isAbsolute(requestedDirectory) ? resolve(requestedDirectory) : resolve(roots[0], requestedDirectory);
  const realPath = await fileSystem.realpath(givenPath).catch(() => null);
  const isInside = realPath && roots.some((root) => realPath === root || realPath.startsWith(`${root}${sep}`));
  if (!isInside || !(await fileSystem.stat(realPath)).isDirectory()) throw notFound(`No directory at ${JSON.stringify(requestedDirectory)} inside ${VARIABLES.allowedDirs}`);
  return realPath;
}

/**
 * Builds the child's environment from scratch.
 *
 * @param settings - Settings (object)
 * @param nodeEnvironment - Variables from the workflow node (object, optional)
 * @returns Environment object (object)
 * @throws PluginError kind `invalid_input` - Bad names or values
 */
export function buildChildEnvironment(settings, nodeEnvironment = {}) {
  const childEnvironment = { PATH: SAFE_PATH, HOME: settings.homeDirectory, LANG: "en_US.UTF-8" };
  for (const [name, value] of Object.entries(nodeEnvironment)) {
    if (!ENV_NAME_PATTERN.test(name)) throw invalidInput(`Environment variable name ${JSON.stringify(name)} is not valid`);
    if (LOADER_PREFIX_PATTERN.test(name) || STARTUP_VARIABLES.has(name.toUpperCase())) throw invalidInput(`Environment variable ${name} is refused: loader and interpreter start-up variables can make any program run other code`);
    if (typeof value !== "string" || value.includes("\0")) throw invalidInput(`Environment variable ${name} must be a string without NUL characters`);
    childEnvironment[name] = value;
  }
  return childEnvironment;
}

/**
 * Creates a redactor for secret-looking variables of the plugin's own environment and of the child's.
 *
 * @param environments - Environment objects (object[])
 * @returns `(text) => text` with each secret value replaced by "[redacted]" (function)
 */
export function createSecretRedactor(environments) {
  const secrets = environments.flatMap((environment) => Object.entries(environment ?? {}))
    .filter(([name, value]) => SECRET_NAME_PATTERN.test(name) && typeof value === "string" && value.length >= MIN_REDACTABLE_LENGTH)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  return (text) => secrets.reduce((redactedText, secret) => redactedText.split(secret).join("[redacted]"), text);
}
