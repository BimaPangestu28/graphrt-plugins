/**
 * Agent (tool) access rules, from SHELL_EXEC_TOOL_RULES: a JSON array of
 *   { "command": "/abs/path", "argsPrefix": ["fixed", "args"], "argPattern": "regex", "maxExtraArgs": 2 }
 * - `command` is an exact absolute path that is also in SHELL_EXEC_COMMANDS (never a base name).
 * - The tool's argv must start with `argsPrefix` (default []) exactly.
 * - Arguments after the prefix are allowed only with `argPattern`, which must match each one whole (it is
 *   anchored as ^(?:pattern)$, Unicode, no flags), and there may be at most `maxExtraArgs` of them
 *   (default 16 with a pattern, 0 without, at most 64).
 * A call is allowed when any rule matches. Rules are read when a tool call arrives, so a malformed value never
 * blocks workflow nodes.
 */
import { isAbsolute, normalize } from "node:path";
import { invalidInput, permissionDenied, setupRequired } from "./errors.mjs";
import { VARIABLES } from "./settings.mjs";

const MAX_PATTERN_LENGTH = 1000;
const MAX_TESTED_ARGUMENT_LENGTH = 4096;
const MAX_EXTRA_ARGS_LIMIT = 64;

function parseRulesText(rulesText) {
  try {
    return JSON.parse(rulesText);
  } catch (parseError) {
    throw invalidInput(`${VARIABLES.toolRules} is not valid JSON: ${parseError.message}`);
  }
}

function compileRule(rule, index, settings) {
  const where = `${VARIABLES.toolRules}[${index}]`;
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) throw invalidInput(`${where} must be an object`);
  if (typeof rule.command !== "string" || !isAbsolute(rule.command) || normalize(rule.command) !== rule.command) throw invalidInput(`${where}.command must be an absolute, normalised executable path`);
  if (!settings.commands.some((entry) => entry.path === rule.command)) throw setupRequired(`${where}.command ${rule.command} is not in ${VARIABLES.commands}`);
  const argsPrefix = rule.argsPrefix ?? [];
  if (!Array.isArray(argsPrefix) || !argsPrefix.every((argument) => typeof argument === "string")) throw invalidInput(`${where}.argsPrefix must be an array of strings`);
  return { command: rule.command, argsPrefix, argPattern: compilePattern(rule.argPattern, where), maxExtraArgs: readMaxExtraArgs(rule, where) };
}

function compilePattern(argPattern, where) {
  if (argPattern === undefined) return null;
  if (typeof argPattern !== "string" || argPattern.length > MAX_PATTERN_LENGTH) throw invalidInput(`${where}.argPattern must be a string of at most ${MAX_PATTERN_LENGTH} characters`);
  try {
    return new RegExp(`^(?:${argPattern})$`, "u");
  } catch (patternError) {
    throw invalidInput(`${where}.argPattern is not a valid regular expression: ${patternError.message}`);
  }
}

function readMaxExtraArgs(rule, where) {
  const defaultValue = rule.argPattern === undefined ? 0 : 16;
  const value = rule.maxExtraArgs ?? defaultValue;
  if (!Number.isInteger(value) || value < 0 || value > MAX_EXTRA_ARGS_LIMIT) throw invalidInput(`${where}.maxExtraArgs must be an integer from 0 to ${MAX_EXTRA_ARGS_LIMIT}`);
  if (value > 0 && rule.argPattern === undefined) throw invalidInput(`${where}.maxExtraArgs needs an argPattern`);
  return value;
}

/**
 * Reads and checks SHELL_EXEC_TOOL_RULES.
 *
 * @param settings - From readShellExecSettings (object)
 * @returns Compiled rules (object[]); empty when the variable is unset
 * @throws PluginError kinds `invalid_input` (malformed), `setup_required` (a command not in SHELL_EXEC_COMMANDS)
 */
export function readToolRules(settings) {
  const rulesText = settings.toolRulesText;
  if (!rulesText) return [];
  const rules = parseRulesText(rulesText);
  if (!Array.isArray(rules)) throw invalidInput(`${VARIABLES.toolRules} must be a JSON array of rules`);
  return rules.map((rule, index) => compileRule(rule, index, settings));
}

function ruleAllows(rule, commandPath, args) {
  if (rule.command !== commandPath || args.length < rule.argsPrefix.length) return false;
  if (!rule.argsPrefix.every((argument, index) => args[index] === argument)) return false;
  const extraArgs = args.slice(rule.argsPrefix.length);
  if (extraArgs.length > rule.maxExtraArgs) return false;
  return extraArgs.every((argument) => argument.length <= MAX_TESTED_ARGUMENT_LENGTH && rule.argPattern.test(argument));
}

/**
 * Checks a tool call against the rules: some rule must allow the exact path and the argv, and tools never set env.
 *
 * @param settings - Settings (object)
 * @param allowedCommand - `{path, name}` from findAllowedCommand (object)
 * @param args - Validated arguments (object)
 * @throws PluginError kind `permission_denied` (or the rule-reading errors)
 */
export function assertToolMayRun(settings, allowedCommand, args) {
  if (args.env !== undefined) throw permissionDenied("Agents may not set environment variables for commands");
  const rules = readToolRules(settings);
  if (rules.length === 0) throw permissionDenied(`Agents may not run commands: shell-exec is for workflow nodes, and agents may only run what ${VARIABLES.toolRules} allows`);
  const forCommand = rules.filter((rule) => rule.command === allowedCommand.path);
  if (forCommand.length === 0) throw permissionDenied(`Agents may not run ${allowedCommand.path}: no ${VARIABLES.toolRules} entry for it`);
  if (!forCommand.some((rule) => ruleAllows(rule, allowedCommand.path, args.args))) {
    throw permissionDenied(`Agents may not run ${allowedCommand.path} with these arguments: they must start with a rule's argsPrefix, and any argument after it must match its argPattern`);
  }
}
