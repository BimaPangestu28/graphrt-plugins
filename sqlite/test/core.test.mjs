import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoOtherFiles, assertSingleStatement, stripSqlComments } from "../lib/statement-guard.mjs";
import { mapSqliteError } from "../lib/error-mapping.mjs";
import { resolveSettings } from "../lib/settings.mjs";

const PLUGIN_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPIED_FILES = ["lib/errors.mjs", "lib/value-conversion.mjs", "lib/result-collector.mjs", "lib/environment-readers.mjs", "operations/parameters.mjs"];

test("stripSqlComments keeps quoted text and drops comments", () => {
  assert.equal(stripSqlComments("/* a */SELECT '--x', \"/*y*/\" -- tail\nFROM t"), " SELECT '--x', \"/*y*/\"  \nFROM t");
});

test("assertSingleStatement allows trailing comments and semicolons, refuses another statement", () => {
  assert.doesNotThrow(() => assertSingleStatement("SELECT 1; -- done\n;", "SELECT 1;"));
  assert.doesNotThrow(() => assertSingleStatement("SELECT 1", undefined));
  assert.throws(() => assertSingleStatement("SELECT 1; /* x */ DROP TABLE t", "SELECT 1;"), { kind: "invalid_input" });
});

test("assertNoOtherFiles refuses ATTACH and VACUUM INTO, allows plain VACUUM and strings that mention them", () => {
  assert.throws(() => assertNoOtherFiles("-- c\n attach database 'x' as y"), { kind: "permission_denied" });
  assert.throws(() => assertNoOtherFiles("VACUUM main INTO '/tmp/x.db'"), { kind: "permission_denied" });
  assert.doesNotThrow(() => assertNoOtherFiles("VACUUM"));
  assert.doesNotThrow(() => assertNoOtherFiles("SELECT 'ATTACH' AS word"));
});

test("mapSqliteError: result codes to kinds", () => {
  assert.equal(mapSqliteError({ message: "attempt to write a readonly database", errcode: 8 }).kind, "permission_denied");
  assert.equal(mapSqliteError({ message: "database is locked", errcode: 5 }).retryable, true);
  assert.equal(mapSqliteError({ message: "UNIQUE constraint failed: items.name", errcode: 2067 }).kind, "invalid_input");
  assert.equal(mapSqliteError({ message: "unable to open database file", errcode: 14 }).kind, "not_found");
  assert.equal(mapSqliteError({ message: "file is not a database", errcode: 26 }).kind, "invalid_input");
  assert.equal(mapSqliteError({ message: "no such column: x", errcode: 1 }).kind, "not_found");
  assert.equal(mapSqliteError({ message: "bad", kind: "permission_denied" }).kind, "permission_denied");
});

test("settings: allowed directories expand ~ and must be absolute", () => {
  const settings = resolveSettings({ HOME: "/home/budi", SQLITE_ALLOWED_DIRS: "~/data, /srv/db" });
  assert.deepEqual(settings.allowedDirectories, ["/home/budi/data", "/srv/db"]);
  assert.throws(() => resolveSettings({ SQLITE_ALLOWED_DIRS: "data" }), { kind: "invalid_input" });
  assert.throws(() => resolveSettings({ SQLITE_BUSY_TIMEOUT_MS: "-1" }), { kind: "invalid_input" });
});

// The SQL plugins share these files by copy; a drifting copy is a bug. Skipped when installed on its own.
test("copied core files match the postgres and mysql plugins", (context) => {
  for (const siblingName of ["postgres", "mysql"]) {
    for (const relativePath of COPIED_FILES) {
      const siblingPath = join(PLUGIN_DIRECTORY, "..", siblingName, relativePath);
      if (!existsSync(siblingPath)) {
        context.diagnostic(`${siblingName} not found next to this plugin; skipped`);
        continue;
      }
      assert.equal(readFileSync(join(PLUGIN_DIRECTORY, relativePath), "utf8"), readFileSync(siblingPath, "utf8"), `${relativePath} differs from ${siblingName}`);
    }
  }
  const poolRegistryPath = join(PLUGIN_DIRECTORY, "..", "postgres", "lib", "pool-registry.mjs");
  const mysqlPoolRegistryPath = join(PLUGIN_DIRECTORY, "..", "mysql", "lib", "pool-registry.mjs");
  if (existsSync(poolRegistryPath) && existsSync(mysqlPoolRegistryPath)) assert.equal(readFileSync(poolRegistryPath, "utf8"), readFileSync(mysqlPoolRegistryPath, "utf8"));
});
