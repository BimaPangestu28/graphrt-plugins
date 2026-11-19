/**
 * ATTACH and VACUUM INTO must never reach a file outside SQLITE_ALLOWED_DIRS, however the SQL is dressed up.
 * Two layers are tested: the token scanner and the compiled-bytecode check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertCompiledProgramTouchesNoOtherFiles, assertNoOtherFiles, scanFirstStatement } from "../lib/statement-guard.mjs";
import { createShopDatabase, SKIP_WITHOUT_SQLITE, withSqliteRunner } from "./helpers.mjs";

const sqliteModule = await import("node:sqlite").catch(() => null);
const options = { skip: SKIP_WITHOUT_SQLITE };
const disguisedAttachPrefixes = [";", ";;", "/*x*/;", " ; -- c\n ; ", "\n;\n", ";/* a */;"];

test("scanFirstStatement skips empty statements, comments, strings and quoted names", () => {
  assert.deepEqual(scanFirstStatement(";; /* c */ ; aTtAcH 'b.db' AS \"into\"").keywords, ["ATTACH", "AS"]);
  assert.deepEqual(scanFirstStatement("-- x\nVACUUM main INTO 'c.db'; SELECT 1").keywords, ["VACUUM", "MAIN", "INTO"]);
  assert.equal(scanFirstStatement(";;  SELECT 1").startOffset, 4);
  assert.deepEqual(scanFirstStatement("SELECT 'ATTACH', [INTO], `x`").keywords, ["SELECT"]);
});

test("assertNoOtherFiles refuses ATTACH and VACUUM INTO behind empty statements, comments, mixed case and newlines", () => {
  for (const prefix of disguisedAttachPrefixes) {
    assert.throws(() => assertNoOtherFiles(`${prefix}ATTACH 'x.db' AS y`), { kind: "permission_denied" }, JSON.stringify(prefix));
    assert.throws(() => assertNoOtherFiles(`${prefix}vacuum INTO 'x.db'`), { kind: "permission_denied" }, JSON.stringify(prefix));
  }
  assert.throws(() => assertNoOtherFiles("AtTaCh\nDATABASE\n'x.db'\nAS\ny"), { kind: "permission_denied" });
  assert.throws(() => assertNoOtherFiles("VACUUM\n\"main\"\nINTO\n'x.db'"), { kind: "permission_denied" });
  assert.doesNotThrow(() => assertNoOtherFiles("VACUUM"));
  assert.doesNotThrow(() => assertNoOtherFiles("SELECT 'ATTACH x' AS note, 'VACUUM INTO' AS other"));
});

test("the bytecode check refuses ATTACH and VACUUM INTO on its own, and allows ordinary statements", { skip: SKIP_WITHOUT_SQLITE }, () => {
  const database = new sqliteModule.DatabaseSync(":memory:");
  try {
    assert.throws(() => assertCompiledProgramTouchesNoOtherFiles(database, "ATTACH 'x.db' AS y"), { kind: "permission_denied" });
    assert.throws(() => assertCompiledProgramTouchesNoOtherFiles(database, ";;ATTACH 'x.db' AS y"), { kind: "permission_denied" });
    assert.throws(() => assertCompiledProgramTouchesNoOtherFiles(database, "VACUUM INTO 'x.db'"), { kind: "permission_denied" });
    assert.doesNotThrow(() => assertCompiledProgramTouchesNoOtherFiles(database, "VACUUM"));
    assert.doesNotThrow(() => assertCompiledProgramTouchesNoOtherFiles(database, "SELECT sqlite_version()"));
    assert.doesNotThrow(() => assertCompiledProgramTouchesNoOtherFiles(database, "EXPLAIN QUERY PLAN SELECT 1"));
  } finally {
    database.close();
  }
});

test("agent query: every disguised ATTACH of a file outside the allowlist is refused", options, () =>
  withSqliteRunner({}, async ({ runOperation, outsideDirectory }) => {
    await createShopDatabase(runOperation);
    const outsideFile = join(outsideDirectory, "secret.db");
    await writeFile(outsideFile, "");
    for (const prefix of [...disguisedAttachPrefixes, ""]) {
      await assert.rejects(runOperation("query", { sql: `${prefix}AtTaCh '${outsideFile}' AS s` }, { source: "tool" }), { kind: "permission_denied" }, JSON.stringify(prefix));
    }
  }));

test("node execute: disguised VACUUM INTO and ATTACH are refused and no file is written outside the allowlist", options, () =>
  withSqliteRunner({}, async ({ runOperation, outsideDirectory }) => {
    await createShopDatabase(runOperation);
    for (const [index, prefix] of [...disguisedAttachPrefixes, ""].entries()) {
      const copyPath = join(outsideDirectory, `copy-${index}.db`);
      await assert.rejects(runOperation("execute", { sql: `${prefix}VACUUM INTO '${copyPath}'` }, { source: "node" }), { kind: "permission_denied" }, JSON.stringify(prefix));
      assert.equal(existsSync(copyPath), false);
      await assert.rejects(runOperation("execute", { sql: `${prefix}ATTACH '${join(outsideDirectory, `new-${index}.db`)}' AS n` }, { source: "node" }), { kind: "permission_denied" });
      assert.equal(existsSync(join(outsideDirectory, `new-${index}.db`)), false);
    }
  }));

test("explain still works (EXPLAIN QUERY PLAN is not executed)", options, () =>
  withSqliteRunner({}, async ({ runOperation }) => {
    await createShopDatabase(runOperation);
    const plan = await runOperation("explain", { sql: "SELECT * FROM items WHERE name = ?", params: ["kopi"] }, { source: "tool" });
    assert.match(plan.data.plan, /items/);
  }));
