/**
 * Opt-in tests against a real PostgreSQL server. They run only when
 * POSTGRES_INTEGRATION_URL points at a disposable database as a SUPERUSER (and
 * `npm install` was run). They create a uniquely named table and two roles there
 * and drop them at the end; agent calls use the least-privilege role.
 *
 *   POSTGRES_INTEGRATION_URL=postgres://admin:pass@127.0.0.1:55432/scratch node --test test/integration.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

const integrationUrl = process.env.POSTGRES_INTEGRATION_URL;
const isPgInstalled = await import("pg").then(() => true, () => false);
const skipReason = !integrationUrl ? "POSTGRES_INTEGRATION_URL is not set" : !isPgInstalled ? "pg is not installed (npm install)" : false;
const AS_NODE = { source: "node" };
const AS_TOOL = { source: "tool" };

/**
 * Creates a table and a least-privilege login role (plus a second role it may SET ROLE to), runs `work`, cleans up.
 */
async function withScratchObjects(work) {
  const suffix = randomBytes(4).toString("hex");
  const names = { table: `graphrt_it_${suffix}`, role: `graphrt_it_role_${suffix}`, otherRole: `graphrt_it_other_${suffix}` };
  const rolePassword = randomBytes(12).toString("hex");
  const adminDefinition = createPluginDefinition({ logWarning: () => {} });
  const admin = createOperationRunner(adminDefinition, { POSTGRES_URL: integrationUrl });
  const roleUrl = new URL(integrationUrl);
  roleUrl.username = names.role;
  roleUrl.password = rolePassword;
  const roleDefinition = createPluginDefinition();
  // One pooled connection, so a leftover session state would reach the next call.
  const asRole = createOperationRunner(roleDefinition, { POSTGRES_URL: roleUrl.href, POSTGRES_POOL_MAX: "1" });
  try {
    await admin("execute", { sql: `CREATE TABLE ${names.table} (id bigserial PRIMARY KEY, name text NOT NULL, price numeric(10,2))` }, AS_NODE);
    await admin("execute", { sql: `CREATE ROLE ${names.role} LOGIN PASSWORD '${rolePassword}'` }, AS_NODE);
    await admin("execute", { sql: `CREATE ROLE ${names.otherRole} NOLOGIN` }, AS_NODE);
    await admin("execute", { sql: `GRANT ${names.otherRole} TO ${names.role}` }, AS_NODE);
    await admin("execute", { sql: `GRANT SELECT ON ${names.table} TO ${names.role}` }, AS_NODE);
    return await work({ admin, asRole, names });
  } finally {
    await admin("execute", { sql: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, params: [names.role] }, AS_NODE).catch(() => {});
    await admin("execute", { sql: `DROP TABLE IF EXISTS ${names.table}` }, AS_NODE).catch(() => {});
    await admin("execute", { sql: `DROP ROLE IF EXISTS ${names.role}` }, AS_NODE).catch(() => {});
    await admin("execute", { sql: `DROP ROLE IF EXISTS ${names.otherRole}` }, AS_NODE).catch(() => {});
    await roleDefinition.closeAllConnections();
    await adminDefinition.closeAllConnections();
  }
}

test("real server: write as node, read-only query as tool, caps, timeout and schema", { skip: skipReason }, () =>
  withScratchObjects(async ({ admin, asRole, names }) => {
    const inserted = await admin("execute", { sql: `INSERT INTO ${names.table} (name, price) VALUES ($1, $2), ($3, $4) RETURNING id`, params: ["kopi", "12.50", "teh", "8.00"] }, AS_NODE);
    assert.equal(inserted.data.affected_rows, 2);
    const read = await asRole("query", { sql: `SELECT name, price FROM ${names.table} ORDER BY id`, max_rows: 1 }, AS_TOOL);
    assert.deepEqual(read.data.rows, [{ name: "kopi", price: "12.50" }]);
    assert.equal(read.data.truncated, true);
    await assert.rejects(asRole("query", { sql: `DELETE FROM ${names.table}` }, AS_TOOL), { kind: "permission_denied" });
    await assert.rejects(asRole("query", { sql: "SELECT 1; SELECT 2" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(asRole("query", { sql: "SELECT pg_sleep(2)", statement_timeout_ms: 200 }, AS_TOOL), { kind: "timeout" });
    const description = await asRole("describe_table", { table: names.table }, AS_TOOL);
    assert.deepEqual(description.data.primary_key, ["id"]);
  }));

test("real server: agent tool calls on a superuser connection are refused", { skip: skipReason }, () =>
  withScratchObjects(async ({ admin }) => {
    await assert.rejects(admin("query", { sql: "SELECT 1" }, AS_TOOL), { kind: "permission_denied", message: /superuser/ });
  }));

test("real server: an advisory lock taken by a failing read does not survive on a pooled connection", { skip: skipReason }, () =>
  withScratchObjects(async ({ admin, asRole }) => {
    await assert.rejects(asRole("query", { sql: "SELECT pg_advisory_lock(4242), 1 / (random() * 0)::int" }, AS_TOOL), { kind: "invalid_input" });
    // No successful call in between: its DISCARD ALL would hide a connection that was wrongly kept.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const locks = await admin("query", { sql: "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 4242" }, AS_NODE);
    assert.equal(locks.data.rows[0].n, "0");
  }));

test("real server: SET ROLE and session settings from a node execute do not reach a later agent query", { skip: skipReason }, () =>
  withScratchObjects(async ({ asRole, names }) => {
    await asRole("execute", { sql: `SET ROLE ${names.otherRole}` }, AS_NODE);
    await asRole("execute", { sql: "SELECT set_config('application_name', 'leaked', false)" }, AS_NODE);
    const session = await asRole("query", { sql: "SELECT current_user AS role_name, current_setting('application_name') AS app" }, AS_TOOL);
    assert.deepEqual(session.data.rows[0], { role_name: names.role, app: "graphrt-postgres" });
  }));

test("real server: cancel terminates a backend that swallows query_canceled", { skip: skipReason }, () =>
  withScratchObjects(async ({ admin, asRole }) => {
    const stubbornLoop = "DO $$ BEGIN LOOP BEGIN PERFORM pg_sleep(0.05); EXCEPTION WHEN query_canceled THEN NULL; END; END LOOP; END $$";
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 300);
    await assert.rejects(asRole("query", { sql: stubbornLoop }, { source: "node", signal: abortController.signal }), { kind: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const running = await admin("query", { sql: "SELECT count(*) AS n FROM pg_stat_activity WHERE query LIKE 'DO $$ BEGIN LOOP%' AND pid <> pg_backend_pid()" }, AS_NODE);
    assert.equal(running.data.rows[0].n, "0");
  }));

test("real server: rows far larger on the wire than in JSON trip the socket budget and discard the connection", { skip: skipReason }, async () => {
  const definition = createPluginDefinition({ logWarning: () => {} });
  const runOperation = createOperationRunner(definition, { POSTGRES_URL: integrationUrl, POSTGRES_MAX_RESULT_BYTES: "200000", POSTGRES_ALLOW_SUPERUSER: "1" });
  try {
    const rssBefore = process.memoryUsage().rss;
    // 1 MB of bytea is 2 MB of hex text on the wire but only 64 KiB (cut, base64) in the result.
    const output = await runOperation("query", { sql: "SELECT decode(repeat('ab', 1000000), 'hex') AS b FROM generate_series(1, 100)" }, AS_TOOL);
    assert.equal(output.data.truncated, true);
    assert.equal(output.data.truncated_reason, "max_bytes");
    assert.ok(output.data.row_count <= 1);
    assert.ok(process.memoryUsage().rss - rssBefore < 100 * 1024 * 1024);
    const afterwards = await runOperation("query", { sql: "SELECT 1 AS ok" }, AS_TOOL);
    assert.equal(afterwards.data.rows[0].ok, 1);
  } finally {
    await definition.closeAllConnections();
  }
});

test("real server: 200 rows of 2 MB stay within the byte cap without buffering them all", { skip: skipReason }, () =>
  withScratchObjects(async ({ asRole }) => {
    const rssBefore = process.memoryUsage().rss;
    const output = await asRole("query", { sql: "SELECT repeat('x', 2000000) AS t FROM generate_series(1, 200)" }, AS_TOOL);
    const rssGrowthBytes = process.memoryUsage().rss - rssBefore;
    assert.equal(output.data.truncated, true);
    assert.equal(output.data.truncated_reason, "max_bytes");
    assert.equal(output.data.row_count, 0);
    assert.ok(rssGrowthBytes < 100 * 1024 * 1024, `RSS grew by ${Math.round(rssGrowthBytes / 1048576)} MB`);
  }));
