import { test } from "node:test";
import assert from "node:assert/strict";
import { assertJsonShape } from "../lib/documents.mjs";
import { classifyDriverError } from "../lib/errors.mjs";
import { findKey, isWritingPipeline } from "../lib/query-guard.mjs";
import { buildUrlSecrets, createRedactor, maskConnectionUrl } from "../lib/redaction.mjs";
import { databaseFromUrl, resolveSettings } from "../lib/settings.mjs";
import { installShutdownHandlers } from "../lib/shutdown.mjs";
import { EventEmitter } from "node:events";

test("redactor hides the encoded and decoded password and any URL userinfo", () => {
  const url = "mongodb+srv://app:p%40ss%3Aw0rd@cluster0.example.net/shop";
  const redact = createRedactor(buildUrlSecrets(url));
  assert.equal(redact(`failed ${url}`), "failed [redacted]");
  assert.equal(redact("auth p@ss:w0rd rejected"), "auth [redacted] rejected");
  assert.equal(redact("other mongodb://x:y-secret@h/"), "other mongodb://x:[redacted]@h/");
  assert.equal(maskConnectionUrl(url), "mongodb+srv://app:[redacted]@cluster0.example.net/shop");
});

test("URLs without a password produce no short secrets", () => {
  assert.deepEqual(buildUrlSecrets("mongodb://127.0.0.1:27017"), ["mongodb://127.0.0.1:27017"]);
  assert.deepEqual(buildUrlSecrets(""), []);
});

test("settings: defaults, database from URL, validation", () => {
  const settings = resolveSettings({}, "mongodb://h/shop?authSource=admin");
  assert.deepEqual(settings, {
    connectionUrl: "mongodb://h/shop?authSource=admin",
    defaultDatabase: "shop",
    toolWritesAllowed: false,
    toolAllowedDatabases: [],
    maxResultBytes: 1_000_000,
    idleTimeoutMs: 300_000,
  });
  assert.equal(databaseFromUrl("mongodb://a,b,c/?replicaSet=rs"), null);
  assert.throws(() => resolveSettings({ MONGODB_MAX_RESULT_BYTES: "0" }, "mongodb://h"), { kind: "invalid_input" });
  assert.throws(() => resolveSettings({}, "http://h"), { kind: "invalid_input" });
  assert.equal(resolveSettings({ MONGODB_TOOL_ALLOW_WRITES: "true" }, "mongodb://h").toolWritesAllowed, false, "only 1 enables writes");
});

test("findKey searches nested objects and arrays", () => {
  assert.equal(findKey({ $and: [{ a: 1 }, { b: { $where: "x" } }] }, ["$where"]), "$and.1.b.$where");
  assert.equal(findKey({ a: "$where" }, ["$where"]), null, "values are not keys");
});

test("isWritingPipeline looks at the last stage", () => {
  assert.equal(isWritingPipeline([{ $match: {} }, { $out: "x" }]), true);
  assert.equal(isWritingPipeline([{ $match: {} }]), false);
  assert.equal(isWritingPipeline([]), false);
});

test("inputs that are too deep are refused", () => {
  let nested = {};
  for (let depth = 0; depth < 70; depth += 1) nested = { a: nested };
  assert.throws(() => assertJsonShape(nested, "filter"), { kind: "invalid_input", message: /deeper/ });
});

test("driver error classification", () => {
  assert.equal(classifyDriverError({ name: "MongoNetworkTimeoutError" }).kind, "network_error");
  assert.equal(classifyDriverError({ code: 13 }).kind, "permission_denied");
  assert.equal(classifyDriverError({ name: "MongoParseError" }).kind, "invalid_input");
  assert.equal(classifyDriverError({ name: "MongoServerError", code: 40324 }).kind, "invalid_input");
  assert.equal(classifyDriverError({ name: "MongoServerError", code: 99999 }).kind, "database_error");
});

test("shutdown waits for running operations on stdin end, closes once, then exits", async () => {
  const events = [];
  const processObject = new EventEmitter();
  const shutdown = installShutdownHandlers({
    pluginName: "mongodb",
    closeAllClients: async () => events.push("close"),
    waitForRunningOperations: async (timeoutMs) => {
      events.push(`wait ${timeoutMs}`);
      return "idle";
    },
    drainTimeoutMs: 1234,
    processObject,
    exit: (exitCode) => events.push(`exit ${exitCode}`),
  });
  await Promise.all([shutdown("stdin", { letRunningFinish: true }), shutdown("again")]);
  assert.deepEqual(events, ["wait 1234", "close", "exit 0"]);
});
