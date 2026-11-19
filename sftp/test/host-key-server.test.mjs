/**
 * Host-key pinning against a real loopback ssh2.Server (when ssh2 is installed): with a wrong fingerprint the
 * connection is refused before any credential is sent; with the right one the client goes on to authenticate.
 * The server rejects every login, so nothing ever logs in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { fingerprintHostKey } from "../lib/host-key.mjs";

const ssh2 = await import("ssh2").then((module) => module.default ?? module, () => null);

async function withRejectingServer(work) {
  const keys = ssh2.utils.generateKeyPairSync("ed25519");
  const fingerprint = fingerprintHostKey(ssh2.utils.parseKey(keys.private).getPublicSSH());
  const counters = { authAttempts: 0 };
  const server = new ssh2.Server({ hostKeys: [keys.private] }, (connection) => {
    connection.on("authentication", (context) => {
      counters.authAttempts += 1;
      context.reject();
    });
    connection.on("error", () => {});
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const environment = (pinned) => ({ SFTP_HOST: "127.0.0.1", SFTP_PORT: String(server.address().port), SFTP_USERNAME: "nobody", SFTP_PASSWORD: "hunter2-secret", SFTP_HOST_FINGERPRINT: pinned, SFTP_ROOT: "/srv", SFTP_CONNECT_TIMEOUT_MS: "5000" });
  try {
    return await work({ fingerprint, counters, environment });
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

const skip = ssh2 ? false : "ssh2 is not installed (npm install)";

test("loopback server: a wrong fingerprint is refused before the password is sent", { skip }, async () => {
  await withRejectingServer(async ({ counters, environment }) => {
    const runOperation = createOperationRunner(pluginDefinition, environment("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    await assert.rejects(runOperation("list_directory", {}, { source: "tool" }), { kind: "auth_error", message: /SFTP_HOST_FINGERPRINT/ });
    assert.equal(counters.authAttempts, 0);
  });
});

test("loopback server: the right fingerprint (also with = padding) gets as far as authentication", { skip }, async () => {
  await withRejectingServer(async ({ fingerprint, counters, environment }) => {
    for (const pinned of [fingerprint, `${fingerprint}=`]) {
      const before = counters.authAttempts;
      const runOperation = createOperationRunner(pluginDefinition, environment(pinned));
      await assert.rejects(runOperation("list_directory", {}, { source: "tool" }), (error) => {
        assert.equal(error.kind, "auth_error");
        assert.doesNotMatch(error.message, /hunter2-secret/);
        return true;
      });
      assert.ok(counters.authAttempts > before, pinned);
    }
  });
});

test("loopback server: a fingerprint with a changed case does not match", { skip }, async () => {
  await withRejectingServer(async ({ fingerprint, counters, environment }) => {
    const runOperation = createOperationRunner(pluginDefinition, environment(`SHA256:${fingerprint.slice(7).toLowerCase()}`));
    await assert.rejects(runOperation("list_directory", {}, { source: "tool" }), { kind: "auth_error" });
    assert.equal(counters.authAttempts, 0);
  });
});

test("malformed SFTP_HOST_FINGERPRINT values are setup_required, before any connection", { skip }, async () => {
  await withRejectingServer(async ({ environment }) => {
    for (const pinned of [",", " , ", "MD5:aa:bb", "SHA256:not base64!"]) {
      const runOperation = createOperationRunner(pluginDefinition, environment(pinned));
      await assert.rejects(runOperation("list_directory", {}, { source: "tool" }), { kind: "setup_required" }, pinned);
    }
  });
});
