/**
 * With the real ssh2 (when installed): a port nobody listens on fails cleanly as a retryable network_error,
 * and nothing ever logs in. No real server or account is used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { FAKE_FINGERPRINT } from "./helpers.mjs";

const isSsh2Installed = await import("ssh2").then(() => true, () => false);

async function findClosedPort() {
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

test("real ssh2: a refused connection is network_error", { skip: isSsh2Installed ? false : "ssh2 is not installed (npm install)" }, async () => {
  const port = await findClosedPort();
  const runOperation = createOperationRunner(pluginDefinition, {
    SFTP_HOST: "127.0.0.1",
    SFTP_PORT: String(port),
    SFTP_USERNAME: "nobody",
    SFTP_PASSWORD: "not-a-real-password",
    SFTP_HOST_FINGERPRINT: FAKE_FINGERPRINT,
    SFTP_ROOT: "/tmp",
    SFTP_CONNECT_TIMEOUT_MS: "3000",
  });
  await assert.rejects(runOperation("list_directory", {}, { source: "tool" }), (error) => {
    assert.equal(error.kind, "network_error");
    assert.match(error.message, /ECONNREFUSED/);
    assert.doesNotMatch(error.message, /not-a-real-password/);
    return true;
  });
});
