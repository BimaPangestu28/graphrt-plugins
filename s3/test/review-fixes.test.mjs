import { test } from "node:test";
import assert from "node:assert/strict";
import { readCappedText } from "../lib/local-files.mjs";
import { runS3, runS3Failing, TEST_ENVIRONMENT, xmlError } from "./helpers.mjs";

const ALLOWED_ENVIRONMENT = { ...TEST_ENVIRONMENT, S3_ALLOWED_BUCKETS: "reports, public-assets", S3_TOOL_ALLOW_WRITES: "1" };
const EMPTY_LISTING = { body: "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>" };
const COPY_RESULT = { body: "<CopyObjectResult><ETag>&quot;c&quot;</ETag></CopyObjectResult>" };

test("S3_ALLOWED_BUCKETS limits every bucket an agent tool touches, copy source and destination included", async () => {
  for (const [operationName, args] of [
    ["list_objects", { bucket: "secrets" }],
    ["head_object", { bucket: "secrets", key: "k" }],
    ["get_object", { bucket: "secrets", key: "k", output: "text" }],
    ["put_object", { bucket: "secrets", key: "k", text: "x" }],
    ["copy_object", { source_bucket: "secrets", source_key: "k", bucket: "reports", key: "k" }],
    ["copy_object", { source_bucket: "reports", source_key: "k", bucket: "attacker-bucket", key: "k" }],
  ]) {
    const { error, calls } = await runS3Failing(operationName, args, { source: "tool", environment: ALLOWED_ENVIRONMENT });
    assert.equal(error.kind, "permission_denied", `${operationName} ${JSON.stringify(args)}`);
    assert.match(error.message, /S3_ALLOWED_BUCKETS/);
    assert.equal(calls.length, 0);
  }
  const allowed = await runS3("copy_object", { source_bucket: "reports", source_key: "k", bucket: "public-assets", key: "k" }, { source: "tool", environment: ALLOWED_ENVIRONMENT, responses: [COPY_RESULT] });
  assert.equal(allowed.calls.length, 1);
  const node = await runS3("list_objects", { bucket: "secrets" }, { environment: ALLOWED_ENVIRONMENT, responses: [EMPTY_LISTING] });
  assert.equal(node.calls.length, 1);
});

test("list_buckets for agent tools only shows allowed buckets", async () => {
  const body = "<ListAllMyBucketsResult><Buckets><Bucket><Name>reports</Name></Bucket><Bucket><Name>secrets</Name></Bucket></Buckets></ListAllMyBucketsResult>";
  const tool = await runS3("list_buckets", {}, { source: "tool", environment: ALLOWED_ENVIRONMENT, responses: [{ body }] });
  assert.deepEqual(tool.output.data.buckets.map((bucket) => bucket.name), ["reports"]);
  const node = await runS3("list_buckets", {}, { environment: ALLOWED_ENVIRONMENT, responses: [{ body }] });
  assert.equal(node.output.data.buckets.length, 2);
});

test("S3_EXPECTED_BUCKET_OWNER is sent on bucket requests and for the copy source, never on ListBuckets", async () => {
  const environment = { ...TEST_ENVIRONMENT, S3_EXPECTED_BUCKET_OWNER: "111122223333" };
  const listed = await runS3("list_objects", { bucket: "reports" }, { environment, responses: [EMPTY_LISTING] });
  assert.equal(listed.calls[0].headers["x-amz-expected-bucket-owner"], "111122223333");
  assert.match(listed.calls[0].headers.authorization, /x-amz-expected-bucket-owner/);
  const copied = await runS3("copy_object", { source_bucket: "a-1", source_key: "k", bucket: "b-1", key: "k" }, { environment, responses: [COPY_RESULT] });
  assert.equal(copied.calls[0].headers["x-amz-source-expected-bucket-owner"], "111122223333");
  const buckets = await runS3("list_buckets", {}, { environment, responses: [{ body: "<ListAllMyBucketsResult/>" }] });
  assert.equal(buckets.calls[0].headers["x-amz-expected-bucket-owner"], undefined);
  const invalid = await runS3Failing("list_objects", { bucket: "reports" }, { environment: { ...TEST_ENVIRONMENT, S3_EXPECTED_BUCKET_OWNER: "not-an-account" } });
  assert.equal(invalid.error.kind, "invalid_input");
});

test("undefined header values are dropped before signing and sending", async () => {
  const { calls } = await runS3("get_object", { bucket: "b-1", key: "k", output: "text", range: "bytes=0-1" }, { responses: [{ body: "ab" }] });
  assert.equal(calls[0].headers.range, "bytes=0-1");
  const noRange = await runS3Failing("get_object", { bucket: "b-1", key: "k" }, { responses: [{ body: "ab" }] });
  assert.ok(!("range" in noRange.calls[0].headers), JSON.stringify(noRange.calls[0].headers));
  const head = await runS3("head_object", { bucket: "b-1", key: "k" });
  assert.ok(!Object.values(head.calls[0].headers).includes(undefined));
  const put = await runS3("put_object", { bucket: "b-1", key: "k", text: "x" });
  assert.ok(!("cache-control" in put.calls[0].headers) && !("if-none-match" in put.calls[0].headers));
});

test("non-streamed S3 responses larger than 8 MiB are refused", async () => {
  const hugeListing = `<ListBucketResult>${"<Contents><Key>k</Key></Contents>".repeat(300000)}</ListBucketResult>`;
  const { error } = await runS3Failing("list_objects", { bucket: "b-1" }, { responses: [{ body: hugeListing }] });
  assert.equal(error.kind, "api_error");
  assert.match(error.message, /larger than/);
});

test("readCappedText never cuts a UTF-8 sequence in half", async () => {
  const body = [new TextEncoder().encode("€€€")];
  const { text, bytesRead, truncated } = await readCappedText(body, 4);
  assert.equal(text, "€");
  assert.equal(bytesRead, 3);
  assert.equal(truncated, true);
});

test("copy_object checks source_bucket like any bucket name", async () => {
  const { error, calls } = await runS3Failing("copy_object", { source_bucket: "../etc", source_key: "k", bucket: "b-1", key: "k" });
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("RequestTimeTooSkewed is an auth error that points at the clock", async () => {
  const { error } = await runS3Failing("list_objects", { bucket: "b-1" }, { responses: [xmlError(403, "RequestTimeTooSkewed", "The difference between the request time and the current time is too large.")] });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /clock/);
});
