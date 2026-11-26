# shell-exec

**Status:** stable · **ToS risk:** none. Local only; ran an allowlisted executable live and printed `$(not expanded)` literally (PR #48). See [plugin status](../README.md#plugin-status).

> **Warning: this is the most dangerous plugin in this collection.** A program run through it can do anything its
> arguments allow, with your user's rights: read and delete files, reach the network, start other programs. The
> safeguards below limit *which* programs run, *where*, *with which arguments for agents* and *for how long*; they
> cannot make a powerful program safe. Allowlist only the programs you need.

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin that runs **allowlisted local executables** with an
argument array, for workflow steps that have no dedicated plugin (a build script, a converter, a report generator).
It is designed for **workflow nodes**. Agent tool calls are refused unless a rule in `SHELL_EXEC_TOOL_RULES` allows
that exact executable and argument list.

**Deviation from the catalog design:** the design lists shell-exec as node only. graphrt manifests are static, so
`run_command` is declared as a tool too; without `SHELL_EXEC_TOOL_RULES` every tool call is `permission_denied`.
The opt-in, rule-based tool path is the accepted deviation.

## Features
- **`run_command`:** `command` (base name or absolute path from `SHELL_EXEC_COMMANDS`), `args` (array, passed
  as-is), `cwd` (inside `SHELL_EXEC_ALLOWED_DIRS`), `env` (nodes only), `stdin`, `command_timeout_ms`,
  `fail_on_error`.
- **Result:** `command`, `args`, `cwd`, `exit_code`, `signal`, `stdout`, `stdout_truncated`, `stderr`,
  `stderr_truncated`, `duration_ms`. A non-zero exit is a result, not an error, unless `fail_on_error: true`.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- macOS or Linux (process groups are used to stop programs). Node.js 20 or newer. No npm dependencies.

## Installation
```bash
graphrt plugin install ./shell-exec
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `SHELL_EXEC_COMMANDS` | (required) | Comma-separated **absolute** executable paths that may run, e.g. `/usr/bin/pandoc,/usr/local/bin/report` |
| `SHELL_EXEC_ALLOWED_DIRS` | (required) | Comma-separated directories (absolute or `~/...`) that may be the working directory; the first is the default |
| `SHELL_EXEC_TOOL_RULES` | (none: no agent calls) | JSON array of rules for **agent** calls; see below |
| `SHELL_EXEC_TIMEOUT_MS` | `30000` | Default and maximum run time (100 to 600000) |
| `SHELL_EXEC_MAX_OUTPUT_BYTES` | 1 MiB | Cap for stdout and for stderr, each (1024 to 64 MiB) |

The plugin asks graphrt for no network access and no secrets for itself. That does not stop a program it runs from
using the network.

### Agent rules (`SHELL_EXEC_TOOL_RULES`)
```json
[
  { "command": "/usr/local/bin/report", "argsPrefix": ["--format", "text"] },
  { "command": "/usr/bin/pandoc", "argsPrefix": ["--to", "plain"], "argPattern": "[A-Za-z0-9_-]{1,64}\\.md", "maxExtraArgs": 1 }
]
```
- `command`: an exact absolute path that is also in `SHELL_EXEC_COMMANDS` (rules never match by base name).
- `argsPrefix`: the agent's argument list must start with exactly these arguments (default: none).
- `argPattern`: any argument after the prefix must match this regular expression **whole** (it is anchored as
  `^(?:pattern)$`). Without it, no extra arguments are allowed at all.
- `maxExtraArgs`: most arguments after the prefix (default 16 with a pattern, 0 without, at most 64).
- A call is allowed when any rule matches. Agents can never set `env`, and may not run a program whose real file
  or directory the plugin's user can write (it could be swapped); nodes may.
- A malformed value fails only agent calls (`invalid_input` or `setup_required`), never workflow nodes.

**Never give agents** (no rule makes these safe): shells (`sh`, `bash`, `zsh`), interpreters (`python`, `node`,
`perl`, `ruby`, `osascript`), `env`, `xargs`, `awk`, `sed`, `find`, `git`, `tar`, `ssh`, `scp`, `rsync`, `curl`,
`wget`, `make`, package managers, editors, and anything else whose arguments or input files can run code, write
arbitrary files or read secrets. `git` in particular runs code from the repository's own config (for example
`core.fsmonitor`, `core.sshCommand` and hooks), so even `git status` with a fixed prefix can execute whatever the
repository says. Prefer small, purpose-built scripts with fixed behaviour.

## Quick Start
```bash
mkdir -p ~/graphrt-work
SHELL_EXEC_COMMANDS=/bin/echo SHELL_EXEC_ALLOWED_DIRS=~/graphrt-work graphrt run shell-exec/example.yaml --plugins .
```

## Usage
A workflow node:
```yaml
- id: report
  type: shell-exec.run_command
  command: /usr/local/bin/report
  args: ["--format", "text", "--month", "{{#start.month#}}"]
  cwd: reports
  command_timeout_ms: 10000
  fail_on_error: true
```
The timeout parameter is `command_timeout_ms` because graphrt keeps `timeout_ms` for a node's own policy.

## Safety
- **No shell, ever:** the executable is started directly with an argument array, so `;`, `|`, `&&`, `$(...)`,
  backticks, globs and `$VARS` in arguments are passed literally.
- **Executable allowlist:** only absolute, normalised paths from `SHELL_EXEC_COMMANDS`, named by exact path or
  unique base name; a file with the same name elsewhere (e.g. in the working directory) is never run. The file
  must still be an executable regular file when the call starts. An allowlisted path that is a symlink, or a file in
  a directory your user can write (Homebrew's, for example), can be replaced by anything running as you; agents are
  refused such programs, nodes are not, so allowlist system paths where you can.
- **Working directory:** `realpath`'d and checked against the allowed directories with a separator-suffixed prefix
  (so `/work-evil` is not inside `/work`, and symlinks out are refused). The program itself can still open any path
  it is given; the directory limits where it starts, not what it touches.
- **Clean environment:** the child gets only `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `HOME`, `LANG` and the node's
  `env`. `HOME` is your real home directory, so programs read your dotfiles and configuration there. The plugin's
  own variables (and any secret in them) are never inherited. A node's `env` may not set loader or interpreter
  start-up variables (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `PERL5OPT`, `BASH_ENV`, `GIT_CONFIG_*`,
  `GIT_SSH_COMMAND` and similar), which would make any program run other code.
- **Redaction:** values of variables whose names look secret (`TOKEN`, `SECRET`, `PASSWORD`, `PASSPHRASE`,
  `API_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, `AUTH`), from the plugin's environment and the node's `env`, are replaced
  with `[redacted]` in stdout, stderr and the echoed arguments. Other values are not redacted, and a program can
  print a secret in another form (e.g. base64); do not rely on redaction as a boundary.
- **Timeouts and cancel:** each run starts its own process group. A timeout, cancel or output cap sends SIGKILL to
  the whole group, and the group is killed again when the program exits. This stops ordinary child and grandchild
  processes, but **not** a process that leaves the group on purpose (`setsid`, `nohup` with a new session, a
  daemon that double-forks, `launchctl`/`systemd-run`): such a process can outlive the call.
- **Output caps:** stdout and stderr are each capped; reaching the cap kills the process group and sets
  `*_truncated`. `stdin` is at most 1 MiB, arguments at most 256 of 32 KiB each.

## Errors
| Kind | When |
|------|------|
| `setup_required` | `SHELL_EXEC_COMMANDS` or `SHELL_EXEC_ALLOWED_DIRS` unset or missing, the executable is gone or not executable, a rule names a command not in `SHELL_EXEC_COMMANDS` |
| `permission_denied` | The command is not allowlisted; an agent call no rule allows, with `env`, or for a program the user can write |
| `not_found` | The working directory is missing or outside the allowed directories |
| `invalid_input` | Bad arguments (NUL characters, too many or too long), an ambiguous name, a refused env variable, malformed `SHELL_EXEC_TOOL_RULES` |
| `timeout` / `cancelled` | The run passed its time limit or was cancelled; the process group was killed |
| `plugin_error` | `fail_on_error` with a non-zero exit, or the program could not be started |

## License
Apache-2.0
