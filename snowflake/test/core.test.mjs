import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { buildKeyPairJwt, computePublicKeyFingerprint, resolveAccountIdentifiers } from "../lib/key-pair-jwt.mjs";
import { classifyStatement } from "../lib/statement-guard.mjs";
import { buildBindings, decodeRows } from "../lib/snowflake-values.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

test("account identifiers: JWT uses the uppercase account without region, the host keeps it with - for _", () => {
  assert.deepEqual(resolveAccountIdentifiers("myorg-my_account"), { jwtAccount: "MYORG-MY_ACCOUNT", host: "myorg-my-account.snowflakecomputing.com" });
  assert.deepEqual(resolveAccountIdentifiers("xy12345.us-east-2.aws"), { jwtAccount: "XY12345", host: "xy12345.us-east-2.aws.snowflakecomputing.com" });
  assert.deepEqual(resolveAccountIdentifiers("XY12345"), { jwtAccount: "XY12345", host: "xy12345.snowflakecomputing.com" });
  assert.deepEqual(resolveAccountIdentifiers("https://MyOrg-Acct.snowflakecomputing.com/"), { jwtAccount: "MYORG-ACCT", host: "myorg-acct.snowflakecomputing.com" });
  for (const badAccount of ["", "evil.com/x", "a b", "acct@x"]) assert.throws(() => resolveAccountIdentifiers(badAccount), /SNOWFLAKE_ACCOUNT/, badAccount);
});

test("the public key fingerprint is SHA256 over the DER SubjectPublicKeyInfo, base64", () => {
  const expected = `SHA256:${createHash("sha256").update(createPublicKey(privateKey).export({ type: "spki", format: "der" })).digest("base64")}`;
  assert.equal(computePublicKeyFingerprint(privateKey), expected);
});

test("buildKeyPairJwt signs iss/sub/iat/exp with RS256", () => {
  const nowMs = Date.UTC(2026, 10, 19, 10, 0, 0);
  const jwt = buildKeyPairJwt({ privateKey, jwtAccount: "MYORG-ACCT", user: "etl_user", nowMs });
  const [encodedHeader, encodedClaims, encodedSignature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(encodedClaims, "base64url"));
  assert.equal(claims.sub, "MYORG-ACCT.ETL_USER");
  assert.equal(claims.iss, `MYORG-ACCT.ETL_USER.${computePublicKeyFingerprint(privateKey)}`);
  assert.equal(claims.iat, nowMs / 1000);
  assert.equal(claims.exp, nowMs / 1000 + 3540);
  assert.ok(verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), publicKey, Buffer.from(encodedSignature, "base64url")));
});

// statement -> read-only for agent tools?
const STATEMENT_CASES = [
  ["SELECT 1", true],
  ["  -- leading comment\n /* block */ select * from t where note = 'DELETE me; DROP' ", true],
  ["(SELECT 1) UNION ALL (SELECT 2)", true],
  ["WITH x AS (SELECT 1) SELECT * FROM x", true],
  ["SHOW TABLES IN SCHEMA analytics.public", true],
  ["DESCRIBE TABLE orders", true],
  ["desc table orders", true],
  ["EXPLAIN SELECT 1", true],
  ['SELECT "delete" FROM t', true],
  ["SELECT 1;", true],
  ["SELECT $$drop table x$$", true],
  ["SELECT REPLACE(name, 'a', 'b'), GET(doc, 'k') FROM t", true],
  ["SELECT 'it''s', 'back\\'slash' FROM t", true],
  ["USE ROLE ACCOUNTADMIN", false],
  ["SET x = 1", false],
  ["PUT file:///etc/passwd @stage", false],
  ["INSERT INTO t VALUES (1)", false],
  ["delete from t", false],
  ["WITH x AS (SELECT 1) DELETE FROM t", false],
  ["SELECT 1; DROP TABLE t", false],
  ["CALL my_proc()", false],
  ["SELECT SYSTEM$CANCEL_ALL_QUERIES(1)", false],
  ["CREATE TABLE t (a INT)", false],
  ["GRANT ROLE r TO USER u", false],
  ["COPY INTO @stage FROM t", false],
  ["EXPLAIN DELETE FROM t", false],
  ["SELECT 1 /* unterminated", false],
  ["SELECT 'unterminated", false],
  ["", false],
  // Review bypasses: "$$" inside identifiers, the ->> pipe operator, quoted SYSTEM$ names, TABLE(<procedure>).
  ["SELECT 1 AS a$$, SYSTEM$CANCEL_ALL_QUERIES(CURRENT_SESSION()) AS b$$", false],
  ["SELECT 1 AS a$$ ->> DELETE FROM orders ->> SELECT 1 AS b$$", false],
  ["SHOW TABLES ->> REMOVE @stage", false],
  ["SHOW TABLES ->> RM @stage", false],
  ["SHOW TABLES ->> USE SECONDARY ROLES ALL", false],
  ["SHOW TABLES ->> SET x = 1", false],
  ["SHOW TABLES ->> UNSET x", false],
  ["SHOW TABLES ->> COMMIT", false],
  ["SHOW TABLES ->> COMMENT ON TABLE t IS 'x'", false],
  ['SELECT "SYSTEM$CANCEL_ALL_QUERIES"(1)', false],
  ['SELECT "system$cancel_all_queries"(1)', false],
  ["SELECT * FROM TABLE(my_writing_proc())", false],
  ["SELECT * FROM TABLE(db.sch.my_writing_proc())", false],
  ["SELECT * FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))", false],
  ["SELECT * FROM TABLE ( my_writing_proc() )", false],
  ["EXECUTE IMMEDIATE $$SELECT 1$$", false],
  ["GET @stage file:///tmp", false],
  ["LIST @stage", false],
  ["EXPLAIN USING TEXT DELETE FROM t", false],
  ["SELECT $$ ->> DELETE $$ AS s", true],
  ["SELECT a$$b FROM t", true],
  ["SELECT * FROM TABLE(FLATTEN(input => PARSE_JSON('[1]')))", true],
  ["SELECT seq4() FROM TABLE(GENERATOR(ROWCOUNT => 10))", true],
  ["SELECT * FROM TABLE(SPLIT_TO_TABLE('a,b', ','))", true],
  ["SELECT * FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY())", true],
  ["SELECT * FROM TABLE(analytics.INFORMATION_SCHEMA.TASK_HISTORY())", true],
  ["SELECT f.value FROM t, LATERAL FLATTEN(input => t.doc) f", true],
  ["EXPLAIN USING JSON SELECT 1", true],
  ["SELECT table_name FROM my_table", true],
];

for (const [statement, isReadOnly] of STATEMENT_CASES) {
  test(`classifyStatement ${JSON.stringify(statement).slice(0, 50)} -> ${isReadOnly ? "read-only" : "refused"}`, () => {
    assert.equal(classifyStatement(statement).isReadOnly, isReadOnly);
  });
}

test("buildBindings infers Snowflake binding types", () => {
  assert.deepEqual(buildBindings(["a", 2, 1.5, true, null, { type: "DATE", value: "2026-11-19" }]), {
    1: { type: "TEXT", value: "a" },
    2: { type: "FIXED", value: "2" },
    3: { type: "REAL", value: "1.5" },
    4: { type: "BOOLEAN", value: "true" },
    5: { type: "TEXT", value: null },
    6: { type: "DATE", value: "2026-11-19" },
  });
  assert.equal(buildBindings(undefined), undefined);
  assert.throws(() => buildBindings([{ type: "EVIL;", value: "x" }]), /type/);
  assert.throws(() => buildBindings([{ nested: true }]), /type/);
  assert.throws(() => buildBindings([2 ** 60]), /exact/);
});

test("decodeRows converts jsonv2 strings by column type", () => {
  const rowType = [
    { name: "ID", type: "fixed", scale: 0 },
    { name: "BIG", type: "fixed", scale: 0 },
    { name: "PRICE", type: "fixed", scale: 2 },
    { name: "RATIO", type: "real" },
    { name: "OK", type: "boolean" },
    { name: "DAY", type: "date" },
    { name: "AT_TIME", type: "time" },
    { name: "NTZ", type: "timestamp_ntz" },
    { name: "LTZ", type: "timestamp_ltz" },
    { name: "TZ", type: "timestamp_tz" },
    { name: "DOC", type: "variant" },
    { name: "NAME", type: "text" },
    { name: "MISSING", type: "text" },
  ];
  const row = ["42", "9007199254740993", "12.50", "0.25", "true", "20411", "36000.123000000", "1763546400.123456789", "1763546400.000000000", "1763546400.000000000 1860", '{"a":1}', "Ana", null];
  assert.deepEqual(decodeRows(rowType, [row]), [
    {
      ID: 42,
      BIG: "9007199254740993",
      PRICE: "12.50",
      RATIO: 0.25,
      OK: true,
      DAY: "2025-11-19",
      AT_TIME: "10:00:00.123000000",
      NTZ: "2025-11-19T10:00:00.123456789",
      LTZ: "2025-11-19T10:00:00.000000000Z",
      TZ: "2025-11-19T17:00:00.000000000+07:00",
      DOC: { a: 1 },
      NAME: "Ana",
      MISSING: null,
    },
  ]);
});
