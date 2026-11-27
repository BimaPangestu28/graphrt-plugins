/**
 * Test helpers: a temp "server" directory behind the fake ssh2 module, local
 * input/output directories, and a runner over the real plugin definition.
 * The plugin is given the server's own POSIX path (`/server`); tests reach
 * the same files locally through `serverRoot`.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";
import { createFakeSsh2, FAKE_HOST_KEY } from "./fake-ssh2.mjs";

export const AS_NODE = { source: "node" };
export const AS_TOOL = { source: "tool" };
export const TEST_PASSWORD = "pa55:w0rd@secret";
export const FAKE_FINGERPRINT = `SHA256:${createHash("sha256").update(FAKE_HOST_KEY).digest("base64").replace(/=+$/, "")}`;

/**
 * Runs `work` with temp directories and a runner wired to a fake ssh2.
 *
 * @param options - `{scenario, environment}` (object, optional)
 * @param work - `async ({runOperation, log, serverRoot, outsideRemote, inputDirectory, outputDirectory}) => void` (function)
 * @returns Promise of work's result
 */
export async function withSftp({ scenario = {}, environment = {} } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-sftp-test-")));
  const directories = { serverRoot: join(baseDirectory, "server"), outsideRemote: join(baseDirectory, "server-evil"), inputDirectory: join(baseDirectory, "in"), outputDirectory: join(baseDirectory, "out") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  // Set on the caller's object: a test may add to its scenario while it runs.
  scenario.localRoot = baseDirectory;
  const fake = createFakeSsh2(scenario);
  const definition = createPluginDefinition({ loadSsh2: async () => fake.module });
  const runOperation = createOperationRunner(definition, {
    SFTP_HOST: "sftp.example.com",
    SFTP_USERNAME: "deploy",
    SFTP_PASSWORD: TEST_PASSWORD,
    SFTP_HOST_FINGERPRINT: FAKE_FINGERPRINT,
    SFTP_ROOT: "/server",
    SFTP_INPUT_DIRS: directories.inputDirectory,
    SFTP_OUTPUT_DIR: directories.outputDirectory,
    ...environment,
  });
  try {
    return await work({ runOperation, log: fake.log, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}
