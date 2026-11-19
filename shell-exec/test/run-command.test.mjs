/**
 * run_command with real child processes: executable allowlist, argument arrays (no shell), clean environment,
 * cwd allowlist, timeout with process-group kill, output caps, secret redaction and the tool policy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";

const AS_NODE = { source: "node" };
const AS_TOOL = { source: "tool" };
const COMMANDS = "/bin/echo,/bin/sh,/usr/bin/env,/bin/cat,/bin/pwd";

async function withShellExec(environment, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-shell-exec-test-")));
  const directories = { workspace: join(baseDirectory, "workspace"), lookalike: join(baseDirectory, "workspace-evil"), outside: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const runOperation = createOperationRunner(pluginDefinition, { SHELL_EXEC_COMMANDS: COMMANDS, SHELL_EXEC_ALLOWED_DIRS: directories.workspace, ...environment });
  try {
    return await work({ runOperation, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

test("runs an allowlisted executable by name or absolute path with an argument array", async () => {
  await withShellExec({}, async ({ runOperation }) => {
    const byName = await runOperation("run_command", { command: "echo", args: ["hello", "world"] }, AS_NODE);
    assert.equal(byName.data.exit_code, 0);
    assert.equal(byName.data.stdout, "hello world\n");
    assert.equal(byName.data.command, "/bin/echo");
    const byPath = await runOperation("run_command", { command: "/bin/echo", args: ["x"] }, AS_NODE);
    assert.equal(byPath.data.stdout, "x\n");
  });
});

test("no shell: metacharacters and substitutions are passed literally", async () => {
  await withShellExec({}, async ({ runOperation, workspace }) => {
    const payload = ["$(touch pwned)", "`touch pwned`", ";", "touch", "pwned", "&&", "|", "*"];
    const { data } = await runOperation("run_command", { command: "echo", args: payload }, AS_NODE);
    assert.equal(data.stdout, `${payload.join(" ")}\n`);
    await assert.rejects(realpath(join(workspace, "pwned")));
  });
});

test("commands outside SHELL_EXEC_COMMANDS are refused, including look-alikes and relative names", async () => {
  await withShellExec({}, async ({ runOperation, workspace }) => {
    await writeFile(join(workspace, "echo"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
    for (const command of ["ls", "/bin/ls", "./echo", join(workspace, "echo"), "/bin/../bin/ls", "sh -c id"]) {
      await assert.rejects(runOperation("run_command", { command }, AS_NODE), { kind: "permission_denied" }, command);
    }
  });
});

test("the child gets a clean environment: fixed PATH plus only the node's env", async () => {
  await withShellExec({ SOME_PLUGIN_SECRET: "should-not-leak" }, async ({ runOperation }) => {
    const { data } = await runOperation("run_command", { command: "env", env: { GREETING: "hi" } }, AS_NODE);
    const names = data.stdout.trim().split("\n").map((line) => line.split("=")[0]).sort();
    assert.deepEqual(names, ["GREETING", "HOME", "LANG", "PATH"]);
    assert.ok(!data.stdout.includes("should-not-leak"));
  });
});

test("secrets in the node's env and the plugin's secret-looking variables are redacted from output", async () => {
  await withShellExec({ DEPLOY_TOKEN: "plugin-token-123456" }, async ({ runOperation }) => {
    const { data } = await runOperation("run_command", { command: "sh", args: ["-c", "echo $API_KEY; echo plugin-token-123456 >&2"], env: { API_KEY: "node-secret-987654" } }, AS_NODE);
    assert.equal(data.stdout, "[redacted]\n");
    assert.equal(data.stderr, "[redacted]\n");
  });
});

test("cwd must be inside SHELL_EXEC_ALLOWED_DIRS (realpath, no look-alikes or symlinks out)", async () => {
  await withShellExec({}, async ({ runOperation, workspace, lookalike, outside }) => {
    await mkdir(join(workspace, "sub"));
    await symlink(outside, join(workspace, "escape"));
    const inside = await runOperation("run_command", { command: "pwd", cwd: "sub" }, AS_NODE);
    assert.equal(inside.data.stdout.trim(), join(workspace, "sub"));
    const defaultCwd = await runOperation("run_command", { command: "pwd" }, AS_NODE);
    assert.equal(defaultCwd.data.stdout.trim(), workspace);
    for (const cwd of [outside, lookalike, "escape", "../outside"]) {
      await assert.rejects(runOperation("run_command", { command: "pwd", cwd }, AS_NODE), { kind: "not_found" }, cwd);
    }
  });
});

test("timeout kills the whole process group, grandchildren included", async () => {
  await withShellExec({}, async ({ runOperation, workspace }) => {
    const marker = join(workspace, "survived");
    const started = Date.now();
    await assert.rejects(
      runOperation("run_command", { command: "sh", args: ["-c", `(sleep 2; touch ${marker}) & sleep 30`], command_timeout_ms: 500 }, AS_NODE),
      { kind: "timeout" },
    );
    assert.ok(Date.now() - started < 5000);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2500));
    await assert.rejects(realpath(marker), "the grandchild must have been killed");
  });
});

test("cancel kills the process group", async () => {
  await withShellExec({}, async ({ runOperation }) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(runOperation("run_command", { command: "sh", args: ["-c", "sleep 30"] }, { source: "node", signal: controller.signal }), { kind: "cancelled" });
  });
});

test("output over SHELL_EXEC_MAX_OUTPUT_BYTES is cut, flagged, and the program stopped", async () => {
  await withShellExec({ SHELL_EXEC_MAX_OUTPUT_BYTES: "1024" }, async ({ runOperation }) => {
    const { data } = await runOperation("run_command", { command: "sh", args: ["-c", "while true; do echo yyyyyyyyyyyyyyyy; done"], command_timeout_ms: 10000 }, AS_NODE);
    assert.equal(data.stdout_truncated, true);
    assert.equal(Buffer.byteLength(data.stdout), 1024);
    assert.equal(data.exit_code, null);
    assert.equal(data.signal, "SIGKILL");
  });
});

test("stdin is passed when given; non-zero exits are results unless fail_on_error", async () => {
  await withShellExec({}, async ({ runOperation }) => {
    const echoed = await runOperation("run_command", { command: "cat", stdin: "from stdin" }, AS_NODE);
    assert.equal(echoed.data.stdout, "from stdin");
    const failed = await runOperation("run_command", { command: "sh", args: ["-c", "echo oops >&2; exit 3"] }, AS_NODE);
    assert.equal(failed.data.exit_code, 3);
    assert.equal(failed.data.stderr, "oops\n");
    await assert.rejects(runOperation("run_command", { command: "sh", args: ["-c", "exit 3"], fail_on_error: true }, AS_NODE), { kind: "plugin_error", message: /exit code 3/ });
  });
});

const ECHO_HELLO_RULE = JSON.stringify([{ command: "/bin/echo", argsPrefix: ["hello"] }]);

test("tools: refused without SHELL_EXEC_TOOL_RULES; tools never set env", async () => {
  await withShellExec({}, async ({ runOperation }) => {
    await assert.rejects(runOperation("run_command", { command: "echo", args: ["x"] }, AS_TOOL), { kind: "permission_denied", message: /SHELL_EXEC_TOOL_RULES/ });
  });
  await withShellExec({ SHELL_EXEC_TOOL_RULES: ECHO_HELLO_RULE }, async ({ runOperation }) => {
    await assert.rejects(runOperation("run_command", { command: "echo", args: ["hello"], env: { A: "b" } }, AS_TOOL), { kind: "permission_denied" });
    await assert.rejects(runOperation("run_command", { command: "sh", args: ["-c", "id"] }, AS_TOOL), { kind: "permission_denied" });
  });
});

// As root every system program is "writable by this user", so agents are (rightly) refused any program.
const RUNNING_AS_ROOT = process.getuid?.() === 0 ? "running as root: every program counts as replaceable, so agent calls are refused" : false;

test("tool rules: the argv must start with argsPrefix, and extra arguments need an argPattern", { skip: RUNNING_AS_ROOT }, async () => {
  await withShellExec({ SHELL_EXEC_TOOL_RULES: ECHO_HELLO_RULE }, async ({ runOperation }) => {
    const { data } = await runOperation("run_command", { command: "/bin/echo", args: ["hello"] }, AS_TOOL);
    assert.equal(data.stdout, "hello\n");
    await assert.rejects(runOperation("run_command", { command: "echo", args: ["hello", "extra"] }, AS_TOOL), { kind: "permission_denied", message: /argument/ });
    await assert.rejects(runOperation("run_command", { command: "echo", args: ["bye"] }, AS_TOOL), { kind: "permission_denied" });
    await assert.rejects(runOperation("run_command", { command: "echo", args: [] }, AS_TOOL), { kind: "permission_denied" });
  });
});

test("tool rules: argPattern is anchored to the whole argument, and maxExtraArgs bounds them", { skip: RUNNING_AS_ROOT }, async () => {
  const rules = JSON.stringify([{ command: "/bin/echo", argsPrefix: ["n"], argPattern: "[a-z]{1,8}", maxExtraArgs: 2 }]);
  await withShellExec({ SHELL_EXEC_TOOL_RULES: rules }, async ({ runOperation }) => {
    const { data } = await runOperation("run_command", { command: "echo", args: ["n", "abc", "def"] }, AS_TOOL);
    assert.equal(data.stdout, "n abc def\n");
    for (const bad of [["n", "abc;id"], ["n", "xabc1"], ["n", "abc\nid"], ["n", "-e"], ["n", "a", "b", "c"]]) {
      await assert.rejects(runOperation("run_command", { command: "echo", args: bad }, AS_TOOL), { kind: "permission_denied" }, JSON.stringify(bad));
    }
  });
});

test("tool rules: keyed by exact absolute path; malformed rules are setup errors", async () => {
  for (const rules of ["not json", JSON.stringify({ command: "/bin/echo" }), JSON.stringify([{ command: "echo" }]), JSON.stringify([{ command: "/bin/ls" }]), JSON.stringify([{ command: "/bin/echo", argsPrefix: "hello" }]), JSON.stringify([{ command: "/bin/echo", argPattern: "(" }])]) {
    await withShellExec({ SHELL_EXEC_TOOL_RULES: rules }, async ({ runOperation }) => {
      await assert.rejects(runOperation("run_command", { command: "echo", args: ["hello"] }, AS_TOOL), (error) => ["setup_required", "invalid_input"].includes(error.kind), rules);
    });
  }
});

test("tools may not run an executable that the plugin's user can modify; nodes may", async () => {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-shell-exec-writable-")));
  try {
    const scriptPath = join(baseDirectory, "hello.sh");
    await writeFile(scriptPath, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    await withShellExec({ SHELL_EXEC_COMMANDS: `${COMMANDS},${scriptPath}`, SHELL_EXEC_TOOL_RULES: JSON.stringify([{ command: scriptPath }]) }, async ({ runOperation }) => {
      await assert.rejects(runOperation("run_command", { command: scriptPath }, AS_TOOL), { kind: "permission_denied", message: /writable/ });
      const { data } = await runOperation("run_command", { command: scriptPath }, AS_NODE);
      assert.equal(data.stdout, "hi\n");
    });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test("node env may not set loader or interpreter start-up variables", async () => {
  await withShellExec({}, async ({ runOperation }) => {
    for (const name of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "PYTHONSTARTUP", "PERL5OPT", "BASH_ENV", "GIT_CONFIG_PARAMETERS"]) {
      await assert.rejects(runOperation("run_command", { command: "echo", env: { [name]: "x" } }, AS_NODE), { kind: "invalid_input", message: new RegExp(name) }, name);
    }
  });
});

test("configuration errors: missing allowlists, relative or non-executable commands", async () => {
  await withShellExec({ SHELL_EXEC_COMMANDS: "" }, async ({ runOperation }) => {
    await assert.rejects(runOperation("run_command", { command: "echo" }, AS_NODE), { kind: "setup_required" });
  });
  await withShellExec({ SHELL_EXEC_COMMANDS: "echo" }, async ({ runOperation }) => {
    await assert.rejects(runOperation("run_command", { command: "echo" }, AS_NODE), { kind: "invalid_input" });
  });
  await withShellExec({ SHELL_EXEC_COMMANDS: "/etc/hosts" }, async ({ runOperation }) => {
    await assert.rejects(runOperation("run_command", { command: "hosts" }, AS_NODE), { kind: "setup_required", message: /not an executable/ });
  });
  await withShellExec({ SHELL_EXEC_ALLOWED_DIRS: "" }, async ({ runOperation }) => {
    await assert.rejects(runOperation("run_command", { command: "echo" }, AS_NODE), { kind: "setup_required" });
  });
});

test("arguments with NUL characters are refused", async () => {
  await withShellExec({}, async ({ runOperation }) => {
    await assert.rejects(runOperation("run_command", { command: "echo", args: ["a\0b"] }, AS_NODE), { kind: "invalid_input" });
  });
});

test("manifest: local only, no secrets", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
});
