/**
 * shell-exec plugin definition: run allowlisted local executables.
 *
 * THE MOST DANGEROUS PLUGIN IN THIS COLLECTION. A program run here can do
 * anything its arguments let it do, with your user's rights. It is meant for
 * workflow nodes: an agent tool call is refused unless the command is listed
 * allowed by SHELL_EXEC_TOOL_RULES. graphrt manifests are static, so `run_command`
 * is still declared as a tool; with that variable unset every tool call is
 * `permission_denied`. No shell is ever used.
 */
import { promises as defaultFileSystem } from "node:fs";
import { createCommandRunner } from "./lib/command-runner.mjs";
import { CALL_TIMEOUT_MS, readShellExecSettings, VARIABLES } from "./lib/settings.mjs";
import { runCommandOperation } from "./operations/run-command.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{runCommand, fileSystem}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  const runCommand = dependencies.runCommand ?? createCommandRunner();
  return {
    name: "shell-exec",
    version: "0.1.0",
    description: "DANGEROUS: run allowlisted local executables with argument arrays (never a shell) in allowed directories, with a clean environment, timeouts that kill the process group, output caps and secret redaction; agents only for what SHELL_EXEC_TOOL_RULES allows",
    extraEnv: Object.values(VARIABLES),
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 4 },
    createClient: ({ environment }) => ({
      settings: readShellExecSettings(environment),
      fileSystem: dependencies.fileSystem ?? defaultFileSystem,
      runCommand,
    }),
    operations: [runCommandOperation],
  };
}

export const pluginDefinition = createPluginDefinition();
