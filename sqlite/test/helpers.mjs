/**
 * Test helpers: a temporary allowed directory with a real SQLite file, and a
 * runner whose "worker" runs in this process (the real launcher forks; it has
 * its own tests). Tests skip when node:sqlite is unavailable (Node < 22.13).
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";
import { mapSqliteError } from "../lib/error-mapping.mjs";
import { runSqliteRequest } from "../lib/sqlite-statement-runner.mjs";

const sqliteModule = await import("node:sqlite").catch(() => null);
export const SKIP_WITHOUT_SQLITE = sqliteModule ? false : "node:sqlite is not available (Node.js 22.13+)";

/**
 * Runs a request in this process the way the worker would, including its error serialisation.
 *
 * @param request - Worker request (object)
 * @returns Results (object[])
 */
export async function runInProcess(request) {
  try {
    return runSqliteRequest(request, sqliteModule.DatabaseSync);
  } catch (runError) {
    throw mapSqliteError({ message: runError.message, errcode: runError.errcode ?? null, kind: runError.name === "PluginError" ? runError.kind : null });
  }
}

/**
 * Creates a temp allowed directory (and an outside one) and a runner for it.
 *
 * @param options - `{environment, launchWorker}` (object)
 * @param work - `async ({runOperation, allowedDirectory, outsideDirectory, databasePath, requests}) => void` (function)
 * @returns Promise of work's result
 */
export async function withSqliteRunner({ environment = {}, launchWorker } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-sqlite-test-")));
  const allowedDirectory = join(baseDirectory, "allowed");
  const outsideDirectory = join(baseDirectory, "outside");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(allowedDirectory);
  await mkdir(outsideDirectory);
  const requests = [];
  const recordingLauncher = async (request, options) => {
    requests.push({ request, options });
    return (launchWorker ?? runInProcess)(request, options);
  };
  const definition = createPluginDefinition({ launchWorker: recordingLauncher });
  const databasePath = join(allowedDirectory, "shop.db");
  const runOperation = createOperationRunner(definition, { SQLITE_ALLOWED_DIRS: allowedDirectory, SQLITE_PATH: databasePath, ...environment });
  try {
    return await work({ runOperation, allowedDirectory, outsideDirectory, databasePath, requests });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

/**
 * Creates the shop database used by most tests (as a node, which may write).
 *
 * @param runOperation - From withSqliteRunner (function)
 * @returns Promise
 */
export async function createShopDatabase(runOperation) {
  const asNode = { source: "node" };
  await runOperation("execute", { sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, price REAL, big INTEGER, raw BLOB)", create_if_missing: true }, asNode);
  await runOperation("execute", { sql: "INSERT INTO items (name, price, big, raw) VALUES (?, ?, ?, x'0102ff')", params: ["kopi", 12.5, "9007199254740993"] }, asNode);
  await runOperation("execute", { sql: "INSERT INTO items (name, price) VALUES (?, ?)", params: ["teh", 8] }, asNode);
}
