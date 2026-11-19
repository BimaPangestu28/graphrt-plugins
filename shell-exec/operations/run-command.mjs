/**
 * run_command: runs one allowlisted executable with an argument array.
 * This is the most dangerous operation in the collection; see the README.
 */
import { operationFailed, invalidInput } from "../lib/errors.mjs";
import { assertExecutable, assertNotUserWritable, buildChildEnvironment, createSecretRedactor, findAllowedCommand, resolveWorkingDirectory } from "../lib/command-policy.mjs";
import { assertToolMayRun } from "../lib/tool-rules.mjs";

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_LENGTH = 32768;
const MAX_STDIN_BYTES = 1024 * 1024;

function validateCommandInput(args) {
  if (args.command.includes("\0")) throw invalidInput("`command` must not contain NUL characters");
  if (args.args.length > MAX_ARGUMENTS) throw invalidInput(`At most ${MAX_ARGUMENTS} arguments`);
  for (const argument of args.args) {
    if (argument.includes("\0")) throw invalidInput("Arguments must not contain NUL characters");
    if (argument.length > MAX_ARGUMENT_LENGTH) throw invalidInput(`Each argument must be at most ${MAX_ARGUMENT_LENGTH} characters`);
  }
  if (args.stdin !== undefined && Buffer.byteLength(args.stdin) > MAX_STDIN_BYTES) throw invalidInput(`\`stdin\` must be at most ${MAX_STDIN_BYTES} bytes`);
  if (args.env !== undefined && (typeof args.env !== "object" || Array.isArray(args.env))) throw invalidInput("`env` must be an object of strings");
}

function describeResult(result, { allowedCommand, args, cwd, redact }) {
  return {
    command: allowedCommand.path,
    args: args.args.map(redact),
    cwd,
    exit_code: result.exitCode,
    signal: result.signal,
    stdout: redact(result.stdout.toString("utf8")),
    stdout_truncated: result.stdoutTruncated,
    stderr: redact(result.stderr.toString("utf8")),
    stderr_truncated: result.stderrTruncated,
    duration_ms: result.durationMs,
  };
}

export const runCommandOperation = {
  name: "run_command",
  title: "Run an allowlisted command",
  description: "Runs one executable from SHELL_EXEC_COMMANDS with an argument array (no shell, no globbing, no variable expansion) in an allowed directory, with a clean environment, a timeout and output caps. Agents may only run what SHELL_EXEC_TOOL_RULES allows (exact path, fixed argument prefix, per-argument pattern)",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Base name or absolute path of an executable in SHELL_EXEC_COMMANDS, e.g. git" },
      args: { type: "array", items: { type: "string" }, default: [], description: "Arguments, each passed as-is (no shell)" },
      cwd: { type: "string", description: "Working directory inside SHELL_EXEC_ALLOWED_DIRS (default: the first one); relative paths start there" },
      env: { type: "object", description: "Extra environment variables (workflow nodes only); the child otherwise gets only PATH, HOME and LANG" },
      stdin: { type: "string", description: "Text written to the program's standard input (at most 1 MiB)" },
      command_timeout_ms: { type: "integer", minimum: 100, description: "Time limit (default and maximum: SHELL_EXEC_TIMEOUT_MS); the whole process group is killed when it passes" },
      fail_on_error: { type: "boolean", default: false, description: "Fail the call when the exit code is not 0 (otherwise the exit code is part of the result)" },
    },
    required: ["command"],
  },
  run: async ({ client, args, signal, source }) => {
    validateCommandInput(args);
    const allowedCommand = findAllowedCommand(client.settings, args.command);
    if (source !== "node") assertToolMayRun(client.settings, allowedCommand, args);
    await assertExecutable(client.fileSystem, allowedCommand.path);
    if (source !== "node") await assertNotUserWritable(client.fileSystem, allowedCommand.path);
    const cwd = await resolveWorkingDirectory(client, args.cwd);
    const env = buildChildEnvironment(client.settings, args.env);
    const redact = createSecretRedactor([client.settings.environment, env]);
    const timeoutMs = Math.min(args.command_timeout_ms ?? client.settings.maxTimeoutMs, client.settings.maxTimeoutMs);
    const result = await client.runCommand({ executablePath: allowedCommand.path, args: args.args, cwd, env, stdin: args.stdin, timeoutMs, maxOutputBytes: client.settings.maxOutputBytes, signal });
    const described = describeResult(result, { allowedCommand, args, cwd, redact });
    if (args.fail_on_error && result.exitCode !== 0) {
      throw operationFailed(`${allowedCommand.name} failed with exit code ${result.exitCode ?? result.signal}: ${described.stderr.slice(-2000) || "no stderr"}`);
    }
    return { data: described };
  },
};
