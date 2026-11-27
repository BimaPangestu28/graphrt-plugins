import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { createShopDatabase, SKIP_WITHOUT_SQLITE, withSqliteRunner } from "./helpers.mjs";

const AS_NODE = { source: "node" };
const AS_TOOL = { source: "tool" };
const options = { skip: SKIP_WITHOUT_SQLITE };

test("manifest: local only (no network, no secrets, no access_token), five tools, allowlist and policy env declared", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["query", "execute", "explain", "list_tables", "describe_table"]);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  for (const variableName of ["SQLITE_ALLOWED_DIRS", "SQLITE_PATH", "SQLITE_TOOL_ALLOW_WRITES", "SQLITE_STATEMENT_TIMEOUT_MS"]) {
    assert.ok(manifest.permissions.env.includes(variableName), variableName);
  }
  assert.ok(manifest.nodes.every((node) => !node.config_schema.properties.access_token));
});

test("query reads on a read-only connection: exact big integers, base64 blobs, duplicate names kept", options, () =>
  withSqliteRunner({}, async ({ runOperation, requests }) => {
    await createShopDatabase(runOperation);
    const output = await runOperation("query", { sql: "SELECT id, name, big, raw, 1 AS id FROM items WHERE name = ?", params: ["kopi"] }, AS_TOOL);
    assert.equal(requests.at(-1).request.mode, "read");
    assert.deepEqual(output.data.rows, [{ id: 1, name: "kopi", big: "9007199254740993", raw: "AQL/", id_2: 1 }]);
    assert.deepEqual(output.data.fields.slice(0, 2), [{ name: "id", type: "INTEGER" }, { name: "name", type: "TEXT" }]);
    assert.equal(output.data.truncated, false);
  }));

test("writes and DDL inside query are refused by SQLite (read-only connection) → permission_denied", options, () =>
  withSqliteRunner({}, async ({ runOperation }) => {
    await createShopDatabase(runOperation);
    for (const sql of ["DELETE FROM items", "DROP TABLE items", "CREATE TABLE evil (x)", "INSERT INTO items (name) VALUES (1)"]) {
      await assert.rejects(runOperation("query", { sql }, AS_TOOL), { kind: "permission_denied", message: /read-only/ }, sql);
    }
    const count = await runOperation("query", { sql: "SELECT count(*) AS n FROM items" }, AS_TOOL);
    assert.equal(count.data.rows[0].n, 2);
  }));

test("several statements are refused instead of silently running only the first", options, () =>
  withSqliteRunner({}, async ({ runOperation }) => {
    await createShopDatabase(runOperation);
    await assert.rejects(runOperation("execute", { sql: "DELETE FROM items WHERE id = 1; DROP TABLE items" }, AS_NODE), { kind: "invalid_input", message: /one SQL statement/ });
    const output = await runOperation("query", { sql: "SELECT count(*) AS n FROM items; -- trailing comment is fine" }, AS_TOOL);
    assert.equal(output.data.rows[0].n, 2);
  }));

test("ATTACH and VACUUM INTO are refused (they would reach files outside the allowlist)", options, () =>
  withSqliteRunner({}, async ({ runOperation, outsideDirectory }) => {
    await createShopDatabase(runOperation);
    await assert.rejects(runOperation("query", { sql: `/* hi */ ATTACH '${join(outsideDirectory, "x.db")}' AS other` }, AS_TOOL), { kind: "permission_denied", message: /ATTACH/ });
    await assert.rejects(runOperation("execute", { sql: `VACUUM INTO '${join(outsideDirectory, "copy.db")}'` }, AS_NODE), { kind: "permission_denied", message: /VACUUM INTO/ });
  }));

test("row cap and byte cap stop reading and set truncated", options, () =>
  withSqliteRunner({ environment: { SQLITE_MAX_RESULT_BYTES: "2000" } }, async ({ runOperation }) => {
    await createShopDatabase(runOperation);
    const endless = "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s) SELECT n FROM s";
    const capped = await runOperation("query", { sql: endless, max_rows: 3 }, AS_TOOL);
    assert.deepEqual(capped.data.rows, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.equal(capped.data.truncated_reason, "max_rows");
    const wide = await runOperation("query", { sql: "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s LIMIT 100) SELECT printf('%.*c', 500, 'x') AS t FROM s" }, AS_TOOL);
    assert.equal(wide.data.truncated_reason, "max_bytes");
    assert.ok(wide.data.row_count < 100);
  }));

test("execute is refused for agent tool calls unless SQLITE_TOOL_ALLOW_WRITES=1", options, async () => {
  await withSqliteRunner({}, async ({ runOperation, requests }) => {
    await createShopDatabase(runOperation);
    const requestCount = requests.length;
    await assert.rejects(runOperation("execute", { sql: "DELETE FROM items" }, AS_TOOL), { kind: "permission_denied", message: /SQLITE_TOOL_ALLOW_WRITES=1/ });
    assert.equal(requests.length, requestCount);
  });
  await withSqliteRunner({ environment: { SQLITE_TOOL_ALLOW_WRITES: "1" } }, async ({ runOperation }) => {
    await createShopDatabase(runOperation);
    const output = await runOperation("execute", { sql: "DELETE FROM items WHERE name = ?", params: ["teh"] }, AS_TOOL);
    assert.equal(output.data.changes, 1);
  });
});

test("execute reports changes, last_insert_rowid and RETURNING rows; JSON and boolean params are converted", options, () =>
  withSqliteRunner({}, async ({ runOperation }) => {
    await createShopDatabase(runOperation);
    const inserted = await runOperation("execute", { sql: "INSERT INTO items (name, price) VALUES (?, ?)", params: ["susu", true] }, AS_NODE);
    assert.equal(inserted.data.changes, 1);
    assert.equal(inserted.data.last_insert_rowid, "3");
    const returning = await runOperation("execute", { sql: "UPDATE items SET name = ? WHERE id = ? RETURNING id, name", params: [{ v: 1 }, 3] }, AS_NODE);
    assert.deepEqual(returning.data.rows, [{ id: 3, name: '{"v":1}' }]);
    assert.equal(returning.data.returned_row_count, 1);
  }));

test("path policy: outside, symlink escape, '..', relative, directories and devices are refused; missing files only created on request", options, () =>
  withSqliteRunner({}, async ({ runOperation, allowedDirectory, outsideDirectory }) => {
    const outsideFile = join(outsideDirectory, "secret.db");
    await writeFile(outsideFile, "");
    await symlink(outsideFile, join(allowedDirectory, "link.db"));
    const read = (database) => runOperation("query", { database, sql: "SELECT 1" }, AS_TOOL);
    await assert.rejects(read(outsideFile), { kind: "not_found", message: /inside SQLITE_ALLOWED_DIRS/ });
    await assert.rejects(read(join(allowedDirectory, "link.db")), { kind: "not_found" });
    await assert.rejects(read(`${allowedDirectory}/../outside/secret.db`), { kind: "not_found" });
    await assert.rejects(read(`${allowedDirectory}-evil/x.db`), { kind: "not_found" });
    await assert.rejects(read("shop.db"), { kind: "invalid_input", message: /absolute/ });
    await assert.rejects(read(join(allowedDirectory, "missing.db")), { kind: "not_found" });
    await assert.rejects(runOperation("execute", { database: join(allowedDirectory, "missing.db"), sql: "CREATE TABLE t (x)" }, AS_NODE), { kind: "not_found" });
    await assert.rejects(runOperation("execute", { database: join(outsideDirectory, "new.db"), sql: "CREATE TABLE t (x)", create_if_missing: true }, AS_NODE), { kind: "not_found" });
    const fifoPath = join(allowedDirectory, "pipe.db");
    // Not on Windows: Git's mkfifo reports success there without making anything a Windows program can see.
    if (process.platform !== "win32" && spawnSync("mkfifo", [fifoPath]).status === 0) await assert.rejects(read(fifoPath), { kind: "invalid_input", message: /not a regular file/ });
  }));

test("no SQLITE_ALLOWED_DIRS → setup_required; no database and no SQLITE_PATH → invalid_input", options, async () => {
  await withSqliteRunner({ environment: { SQLITE_ALLOWED_DIRS: "", SQLITE_PATH: "" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT 1" }, AS_TOOL), { kind: "setup_required", message: /SQLITE_ALLOWED_DIRS/ });
  });
  await withSqliteRunner({ environment: { SQLITE_PATH: "" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("query", { sql: "SELECT 1" }, AS_TOOL), { kind: "invalid_input", message: /SQLITE_PATH/ });
  });
});

test("list_tables, describe_table and explain", options, () =>
  withSqliteRunner({}, async ({ runOperation }) => {
    await runOperation("execute", { sql: "CREATE TABLE cats (id INTEGER PRIMARY KEY, title TEXT)", create_if_missing: true }, AS_NODE);
    await runOperation("execute", { sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'x', cat_id INTEGER REFERENCES cats(id) ON DELETE CASCADE)" }, AS_NODE);
    await runOperation("execute", { sql: "CREATE UNIQUE INDEX idx_items_name ON items(name)" }, AS_NODE);
    await runOperation("execute", { sql: "CREATE VIEW item_names AS SELECT name FROM items" }, AS_NODE);
    const tables = await runOperation("list_tables", {}, AS_TOOL);
    assert.deepEqual(tables.data.tables.map((table) => [table.name, table.type]), [["cats", "table"], ["item_names", "view"], ["items", "table"]]);
    const onlyTables = await runOperation("list_tables", { include_views: false }, AS_TOOL);
    assert.equal(onlyTables.data.row_count, 2);
    const description = await runOperation("describe_table", { table: "items" }, AS_TOOL);
    assert.deepEqual(description.data.primary_key, ["id"]);
    assert.deepEqual(description.data.columns[1], { name: "name", type: "TEXT", default: "'x'", nullable: false, primary_key_position: 0 });
    assert.deepEqual(description.data.indexes, [{ name: "idx_items_name", unique: true, origin: "c", columns: ["name"] }]);
    assert.deepEqual(description.data.foreign_keys, [{ referenced_table: "cats", on_update: "NO ACTION", on_delete: "CASCADE", columns: ["cat_id"], referenced_columns: ["id"] }]);
    await assert.rejects(runOperation("describe_table", { table: "nope'); DROP TABLE items; --" }, AS_TOOL), { kind: "not_found" });
    const plan = await runOperation("explain", { sql: "SELECT * FROM items WHERE name = ?", params: ["kopi"] }, AS_TOOL);
    assert.match(plan.data.plan, /USING INDEX idx_items_name/);
  }));

test("unknown table → not_found, syntax error → invalid_input", options, () =>
  withSqliteRunner({}, async ({ runOperation }) => {
    await createShopDatabase(runOperation);
    await assert.rejects(runOperation("query", { sql: "SELECT * FROM nope" }, AS_TOOL), { kind: "not_found" });
    await assert.rejects(runOperation("query", { sql: "SELEC 1" }, AS_TOOL), { kind: "invalid_input" });
  }));
