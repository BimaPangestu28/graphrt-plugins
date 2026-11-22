/**
 * Environments for commands that may run code we did not write (community plugin rebuilds, `graphrt plugin
 * install/list`, plugin test suites): nothing of the maintainer's environment reaches them except PATH. No
 * GH_TOKEN or other secrets, no gh/git/npm user configuration (HOME and XDG_CONFIG_HOME point at a temporary
 * directory, git and npm are told to skip their global and system files), and no terminal prompts.
 *
 * This limits what leaks by accident; it is not a sandbox. Untrusted code still runs as the current user with
 * network access, which is why the graphrt check of community tarballs is opt-in and belongs in a VM or a
 * container (docs/community-plugins.md).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Variables passed through unchanged when they are set: needed to find tools and run, never secrets. */
const PASSED_THROUGH_VARIABLES = ["PATH", "TMPDIR", "CI", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "PLAYWRIGHT_BROWSERS_PATH"];

/**
 * Builds the environment of an isolated command.
 *
 * @param homeDirectory - Temporary directory used as HOME (it and its `.config` are created) (string)
 * @param extraVariables - More variables to set, e.g. `{CI: "1"}` (object, default {})
 * @returns The environment (object)
 *
 * @example
 * const environment = buildIsolatedEnvironment(mkdtempSync(join(tmpdir(), "isolated-home-")));
 * spawnSync("npm", ["ci", "--ignore-scripts"], { env: environment });
 */
export function buildIsolatedEnvironment(homeDirectory, extraVariables = {}) {
  const configDirectory = join(homeDirectory, ".config");
  mkdirSync(configDirectory, { recursive: true });
  const passedThrough = Object.fromEntries(PASSED_THROUGH_VARIABLES.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  return {
    ...passedThrough,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    XDG_CONFIG_HOME: configDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_userconfig: join(homeDirectory, ".npmrc"),
    npm_config_globalconfig: join(homeDirectory, "npmrc-global"),
    npm_config_update_notifier: "false",
    ...extraVariables,
  };
}
