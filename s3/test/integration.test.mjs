// Opt-in round trip against a real S3-compatible server (for example a throwaway MinIO):
//   S3_INTEGRATION_ENDPOINT=http://127.0.0.1:19000 S3_INTEGRATION_ACCESS_KEY_ID=... S3_INTEGRATION_SECRET_ACCESS_KEY=... node --test test/integration.test.mjs
// It creates a uniquely named bucket, works only inside it, and deletes everything it created.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createS3Transport } from "../lib/s3-transport.mjs";
import { resolveSettings } from "../lib/settings.mjs";
import { pluginDefinition } from "../definition.mjs";
import { makeTempDirectory } from "./helpers.mjs";

const endpoint = process.env.S3_INTEGRATION_ENDPOINT;
const credentials = { accessKeyId: process.env.S3_INTEGRATION_ACCESS_KEY_ID, secretAccessKey: process.env.S3_INTEGRATION_SECRET_ACCESS_KEY };
const skip = !endpoint || !credentials.accessKeyId || !credentials.secretAccessKey ? "set S3_INTEGRATION_ENDPOINT, S3_INTEGRATION_ACCESS_KEY_ID and S3_INTEGRATION_SECRET_ACCESS_KEY" : false;

test("round trip against a real S3-compatible server", { skip }, async () => {
  const bucket = `graphrt-it-${randomBytes(4).toString("hex")}`;
  const downloadDirectory = makeTempDirectory("s3-it-");
  const environment = { S3_ENDPOINT: endpoint, S3_ACCESS_KEY_ID: credentials.accessKeyId, S3_SECRET_ACCESS_KEY: credentials.secretAccessKey, S3_DOWNLOAD_DIR: downloadDirectory };
  const transport = createS3Transport({ settings: resolveSettings(environment), credentials });
  await transport.request({ method: "PUT", bucket });
  const runOperation = createOperationRunner(pluginDefinition, environment);
  const run = (operationName, args) => runOperation(operationName, args, { source: "node" });
  try {
    const key = "dir/näme with space+plus &=?.txt"; // MinIO refuses "//" in keys, AWS does not
    await run("put_object", { bucket, key, text: "hello s3", metadata: { origin: "graphrt" } });
    const listing = await run("list_objects", { bucket, prefix: "dir/" });
    assert.deepEqual(listing.data.objects.map((object) => object.key), [key]);
    const head = await run("head_object", { bucket, key });
    assert.equal(head.data.size, 8);
    assert.deepEqual(head.data.metadata, { origin: "graphrt" });
    assert.equal((await run("get_object", { bucket, key, output: "text" })).data.text, "hello s3");
    const saved = await run("get_object", { bucket, key });
    assert.equal(readFileSync(saved.data.path, "utf8"), "hello s3");
    await run("copy_object", { source_bucket: bucket, source_key: key, bucket, key: "copy.txt" });
    const presigned = await run("presign_get_url", { bucket, key: "copy.txt", expires_in_seconds: 60 });
    assert.equal(await (await fetch(presigned.data.url)).text(), "hello s3");
    const missing = await run("head_object", { bucket, key: "missing" }).catch((error) => error);
    assert.equal(missing.kind, "not_found");
    await run("delete_object", { bucket, key });
    await run("delete_object", { bucket, key: "copy.txt" });
    assert.equal((await run("list_objects", { bucket })).data.objects.length, 0);
  } finally {
    await transport.request({ method: "DELETE", bucket }).catch((cleanupError) => console.error(`cleanup: ${cleanupError.message}`));
  }
});

test("invalid credentials against the real server are auth errors", { skip }, async () => {
  const environment = { S3_ENDPOINT: endpoint, S3_ACCESS_KEY_ID: "INVALIDKEY", S3_SECRET_ACCESS_KEY: "invalid-secret-value" };
  const runOperation = createOperationRunner(pluginDefinition, environment);
  const failure = await runOperation("list_buckets", {}, { source: "node" }).catch((error) => error);
  assert.equal(failure.kind, "auth_error");
  assert.doesNotMatch(failure.message, /invalid-secret-value/);
});
