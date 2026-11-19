/**
 * Connecting: host key pinning, credentials from the environment (redacted), timeouts and error kinds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AS_TOOL, TEST_PASSWORD, withSftp } from "./helpers.mjs";
import { fingerprintHostKey, parseFingerprints } from "../lib/host-key.mjs";

test("the connection uses the env credentials, never an SSH agent, and pins the host key", async () => {
  await withSftp({}, async ({ runOperation, log }) => {
    await runOperation("list_directory", {}, AS_TOOL);
    const [config] = log.configs;
    assert.equal(config.host, "sftp.example.com");
    assert.equal(config.port, 22);
    assert.equal(config.username, "deploy");
    assert.equal(config.password, TEST_PASSWORD);
    assert.equal(config.agent, undefined);
    assert.equal(config.tryKeyboard, false);
    assert.equal(typeof config.hostVerifier, "function");
    assert.equal(log.ended, 1);
  });
});

test("an unknown host key is refused: auth_error naming the seen fingerprint", async () => {
  await withSftp({ scenario: { hostKey: Buffer.from("another-key") } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("list_directory", {}, AS_TOOL), (error) => {
      assert.equal(error.kind, "auth_error");
      assert.match(error.message, /SFTP_HOST_FINGERPRINT/);
      assert.match(error.message, new RegExp(fingerprintHostKey(Buffer.from("another-key")).replace(/[+/]/g, "\\$&")));
      return true;
    });
  });
});

test("without SFTP_HOST_FINGERPRINT nothing connects: setup_required", async () => {
  await withSftp({ environment: { SFTP_HOST_FINGERPRINT: "" } }, async ({ runOperation, log }) => {
    await assert.rejects(runOperation("list_directory", {}, AS_TOOL), { kind: "setup_required", message: /ssh-keyscan/ });
    assert.equal(log.configs.length, 0);
  });
});

test("missing host, username, credentials or root are setup_required", async () => {
  for (const environment of [{ SFTP_HOST: "" }, { SFTP_USERNAME: "" }, { SFTP_PASSWORD: "" }, { SFTP_ROOT: "" }, { SFTP_ROOT: "relative/dir" }]) {
    await withSftp({ environment }, async ({ runOperation }) => {
      await assert.rejects(runOperation("list_directory", {}, AS_TOOL), (error) => ["setup_required", "invalid_input"].includes(error.kind), JSON.stringify(environment));
    });
  }
});

test("authentication failures are auth_error; the password never appears", async () => {
  await withSftp({ scenario: { authError: true } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("list_directory", {}, AS_TOOL), (error) => {
      assert.equal(error.kind, "auth_error");
      assert.ok(!error.message.includes(TEST_PASSWORD));
      return true;
    });
  });
});

test("connection failures are retryable network_error, with secrets redacted", async () => {
  await withSftp({ scenario: { connectError: { message: `connect ECONNREFUSED 10.0.0.1:22 ${TEST_PASSWORD}`, code: "ECONNREFUSED" } } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("list_directory", {}, AS_TOOL), (error) => {
      assert.equal(error.kind, "network_error");
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes(TEST_PASSWORD));
      assert.match(error.message, /\[redacted\]/);
      return true;
    });
  });
});

test("a server that never answers hits SFTP_CONNECT_TIMEOUT_MS / the operation timeout and is closed", async () => {
  await withSftp({ scenario: { hang: true }, environment: { SFTP_OPERATION_TIMEOUT_MS: "1000" } }, async ({ runOperation, log }) => {
    const started = Date.now();
    await assert.rejects(runOperation("list_directory", {}, AS_TOOL), { kind: "timeout" });
    assert.ok(Date.now() - started < 5000);
    assert.equal(log.ended, 1);
  });
});

test("cancel closes the connection", async () => {
  await withSftp({ scenario: { hang: true } }, async ({ runOperation, log }) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(runOperation("list_directory", {}, { source: "tool", signal: controller.signal }), { kind: "cancelled" });
    assert.equal(log.ended, 1);
  });
});

test("fingerprints: SHA256 with or without padding, comma-separated for key rotation; MD5 or garbage refused", () => {
  assert.deepEqual(parseFingerprints("SHA256:abc=, sha256:DEF"), ["abc", "DEF"]);
  assert.throws(() => parseFingerprints("MD5:12:34"), { kind: "setup_required" });
  assert.throws(() => parseFingerprints("abc"), { kind: "setup_required" });
  assert.throws(() => parseFingerprints(" , "), { kind: "setup_required" });
});
