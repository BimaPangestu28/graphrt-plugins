# shell-exec operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `shell-exec.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `run_command` | Runs one executable from SHELL_EXEC_COMMANDS with an argument array (no shell, no globbing, no variable expansion) in an allowed directory, with a clean environment, a timeout and output caps. Agents may only run what SHELL_EXEC_TOOL_RULES allows (exact path, fixed argument prefix, per-argument pattern) | **command**, args, cwd, env, stdin, command_timeout_ms, fail_on_error |
