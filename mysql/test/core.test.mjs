import { test } from "node:test";
import assert from "node:assert/strict";
import { describeColumnType, normalizeDateTimeText } from "../lib/column-types.mjs";
import { mapMysqlError } from "../lib/error-mapping.mjs";
import { resolveConnection } from "../lib/settings.mjs";

test("date-time text becomes ISO; TIMESTAMP gets Z; zero dates stay", () => {
  assert.equal(normalizeDateTimeText("2026-11-19 10:00:00.123456", false), "2026-11-19T10:00:00.123456");
  assert.equal(normalizeDateTimeText("2026-11-19 03:00:00", true), "2026-11-19T03:00:00Z");
  assert.equal(normalizeDateTimeText("0000-00-00 00:00:00", true), "0000-00-00 00:00:00");
  assert.equal(normalizeDateTimeText(null, true), null);
});

test("column types tell text from binary by character set", () => {
  assert.equal(describeColumnType({ columnType: 252, characterSet: 63 }), "blob");
  assert.equal(describeColumnType({ columnType: 252, characterSet: 255 }), "text");
  assert.equal(describeColumnType({ columnType: 251, characterSet: 255 }), "longtext");
  assert.equal(describeColumnType({ columnType: 253, characterSet: 63 }), "varbinary");
  assert.equal(describeColumnType({ columnType: 999 }), "type:999");
});

test("mapMysqlError: errno and SQLSTATE classes", () => {
  const server = (errno, sqlState) => ({ errno, sqlState, sqlMessage: "x" });
  assert.equal(mapMysqlError(server(1146, "42S02")).kind, "not_found");
  assert.equal(mapMysqlError(server(1062, "23000")).kind, "invalid_input");
  assert.equal(mapMysqlError(server(1213, "40001")).retryable, true);
  assert.equal(mapMysqlError(server(1040, "08004")).kind, "rate_limited");
  assert.equal(mapMysqlError(server(1290, "HY000")).kind, "permission_denied");
  assert.equal(mapMysqlError(server(1105, "HY000")).kind, "api_error");
  assert.equal(mapMysqlError({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" }).kind, "network_error");
});

test("connection parts and URL decoding", () => {
  const fromParts = resolveConnection({ environment: { MYSQL_HOST: "db.internal", MYSQL_USER: "app", MYSQL_PASSWORD: "pw-123", MYSQL_SSL_MODE: "verify_identity" } });
  assert.deepEqual(fromParts, { host: "db.internal", port: 3306, user: "app", password: "pw-123", database: null, sslMode: "verify-full", secrets: ["pw-123"] });
  const fromUrl = resolveConnection({ environment: { MYSQL_URL: "mysql://a%40b:p%3Aw@[::1]:3307/my%20db" } });
  assert.equal(fromUrl.user, "a@b");
  assert.equal(fromUrl.password, "p:w");
  assert.equal(fromUrl.host, "::1");
  assert.equal(fromUrl.port, 3307);
  assert.equal(fromUrl.database, "my db");
  assert.throws(() => resolveConnection({ environment: { MYSQL_HOST: "bad host;" } }), { kind: "invalid_input" });
  assert.throws(() => resolveConnection({ environment: { MYSQL_URL: "mysql://h/db?ssl-mode=maybe" } }), { kind: "invalid_input" });
});
