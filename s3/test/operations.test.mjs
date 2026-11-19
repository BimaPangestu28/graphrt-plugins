import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signRequestHeaders } from "../lib/aws-sigv4.mjs";
import { createS3Transport } from "../lib/s3-transport.mjs";
import { resolveSettings } from "../lib/settings.mjs";
import { FIXED_NOW, makeTempDirectory, mkfifoSync, runS3, runS3Failing, SECRET_KEY, SESSION_TOKEN, TEST_ENVIRONMENT, xmlError } from "./helpers.mjs";

const LIST_OBJECTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>my-bucket</Name><Prefix>reports%2F</Prefix><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated>
<Contents><Key>reports%2Fq3+summary.pdf</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>1234</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>reports%2F%E2%82%AC.txt</Key><LastModified>2026-10-02T00:00:00.000Z</LastModified><ETag>&quot;def&quot;</ETag><Size>5</Size><StorageClass>STANDARD</StorageClass></Contents>
<CommonPrefixes><Prefix>reports%2F2026%2F</Prefix></CommonPrefixes>
<NextContinuationToken>token+/=next</NextContinuationToken></ListBucketResult>`;

// operation, args, environment overrides -> expected method, URL (exact), selected headers
const REQUEST_CASES = [
  ["list_buckets", {}, {}, "GET", "https://s3.eu-west-1.amazonaws.com/"],
  ["list_buckets", { prefix: "logs", limit: 10, cursor: "c1" }, {}, "GET", "https://s3.eu-west-1.amazonaws.com/?prefix=logs&max-buckets=10&continuation-token=c1"],
  ["list_objects", { bucket: "my-bucket", prefix: "a b/", delimiter: "/", limit: 2, cursor: "t+/=" }, {}, "GET", "https://my-bucket.s3.eu-west-1.amazonaws.com/?list-type=2&encoding-type=url&prefix=a%20b%2F&delimiter=%2F&max-keys=2&continuation-token=t%2B%2F%3D"],
  ["list_objects", { bucket: "dotted.bucket.name" }, {}, "GET", "https://s3.eu-west-1.amazonaws.com/dotted.bucket.name?list-type=2&encoding-type=url&max-keys=100"],
  ["list_objects", { bucket: "minio-bucket" }, { S3_ENDPOINT: "http://localhost:9000" }, "GET", "http://localhost:9000/minio-bucket?list-type=2&encoding-type=url&max-keys=100"],
  ["list_objects", { bucket: "r2-bucket" }, { S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", S3_FORCE_PATH_STYLE: "0", S3_REGION: "auto" }, "GET", "https://r2-bucket.acct.r2.cloudflarestorage.com/?list-type=2&encoding-type=url&max-keys=100"],
  ["head_object", { bucket: "my-bucket", key: "dir//file name+€.txt", version_id: "v1" }, {}, "HEAD", "https://my-bucket.s3.eu-west-1.amazonaws.com/dir//file%20name%2B%E2%82%AC.txt?versionId=v1"],
  ["delete_object", { bucket: "my-bucket", key: "a/b.txt" }, {}, "DELETE", "https://my-bucket.s3.eu-west-1.amazonaws.com/a/b.txt"],
];

for (const [operationName, args, environmentOverrides, method, expectedUrl] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${method} ${expectedUrl}`, async () => {
    const responseBody = operationName === "list_buckets" ? "<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>" : operationName === "list_objects" ? "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>" : "";
    const { calls } = await runS3(operationName, args, { responses: [{ status: method === "DELETE" ? 204 : 200, body: responseBody }], environment: { ...TEST_ENVIRONMENT, ...environmentOverrides } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, method);
    assert.equal(calls[0].url, expectedUrl);
    assert.equal(calls[0].redirect, "manual");
    assert.match(calls[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\/20261119\/[a-z0-9-]+\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(calls[0].headers["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
}

test("the signature is the SigV4 signature of exactly the URL that was sent", async () => {
  const { calls } = await runS3("head_object", { bucket: "my-bucket", key: "x y.txt" });
  const expected = signRequestHeaders({
    method: "HEAD",
    url: calls[0].url,
    headers: {},
    payloadHash: calls[0].headers["x-amz-content-sha256"],
    credentials: { accessKeyId: "AKIATESTKEY", secretAccessKey: SECRET_KEY },
    region: "eu-west-1",
    service: "s3",
    now: FIXED_NOW,
    pathEncoding: "s3",
    includeContentSha256Header: true,
  });
  assert.equal(calls[0].headers.authorization, expected.authorization);
});

test("list_objects decodes url-encoded keys and returns the continuation token as next_cursor", async () => {
  const { output } = await runS3("list_objects", { bucket: "my-bucket", prefix: "reports/" }, { responses: [{ body: LIST_OBJECTS_XML }] });
  assert.deepEqual(output.data.objects.map((object) => object.key), ["reports/q3 summary.pdf", "reports/€.txt"]);
  assert.deepEqual(output.data.objects[0], { key: "reports/q3 summary.pdf", size: 1234, last_modified: "2026-10-01T00:00:00.000Z", etag: '"abc"', storage_class: "STANDARD" });
  assert.deepEqual(output.data.common_prefixes, ["reports/2026/"]);
  assert.equal(output.data.prefix, "reports/");
  assert.equal(output.data.is_truncated, true);
  assert.equal(output.next_cursor, "token+/=next");
});

test("list_buckets summarizes buckets", async () => {
  const body = "<ListAllMyBucketsResult><Owner><DisplayName>me</DisplayName></Owner><Buckets><Bucket><Name>b1</Name><CreationDate>2026-01-01T00:00:00Z</CreationDate><BucketRegion>eu-west-1</BucketRegion></Bucket></Buckets></ListAllMyBucketsResult>";
  const { output } = await runS3("list_buckets", {}, { responses: [{ body }] });
  assert.deepEqual(output.data, { buckets: [{ name: "b1", created_at: "2026-01-01T00:00:00Z", region: "eu-west-1" }], owner: "me" });
  assert.equal(output.next_cursor, null);
});

test("head_object returns size, type and user metadata", async () => {
  const headers = { "content-length": "42", "content-type": "text/csv", etag: '"e1"', "last-modified": "Wed, 01 Oct 2026 00:00:00 GMT", "x-amz-meta-source": "graphrt" };
  const { output } = await runS3("head_object", { bucket: "b-1", key: "k.csv" }, { responses: [{ headers }] });
  assert.equal(output.data.size, 42);
  assert.equal(output.data.content_type, "text/csv");
  assert.deepEqual(output.data.metadata, { source: "graphrt" });
});

test("session tokens are sent and signed", async () => {
  const { calls } = await runS3("list_buckets", {}, { responses: [{ body: "<ListAllMyBucketsResult/>" }], environment: { ...TEST_ENVIRONMENT, AWS_SESSION_TOKEN: SESSION_TOKEN } });
  assert.equal(calls[0].headers["x-amz-security-token"], SESSION_TOKEN);
  assert.match(calls[0].headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
});

test("S3_* credentials win over AWS_* and a node access_token wins over both", async () => {
  const environment = { ...TEST_ENVIRONMENT, S3_ACCESS_KEY_ID: "R2KEY", S3_SECRET_ACCESS_KEY: "r2-secret-value" };
  const fromS3 = await runS3("list_buckets", {}, { responses: [{ body: "<ListAllMyBucketsResult/>" }], environment });
  assert.match(fromS3.calls[0].headers.authorization, /Credential=R2KEY\//);
  const fromNode = await runS3("list_buckets", { access_token: "NODEKEY:node-secret-value" }, { responses: [{ body: "<ListAllMyBucketsResult/>" }], environment });
  assert.match(fromNode.calls[0].headers.authorization, /Credential=NODEKEY\//);
});

test("missing or half-configured credentials are auth errors that never echo values", async () => {
  const missing = await runS3Failing("list_buckets", {}, { environment: {} });
  assert.equal(missing.error.kind, "auth_error");
  const half = await runS3Failing("list_buckets", {}, { environment: { AWS_ACCESS_KEY_ID: "AKIAONLY" } });
  assert.equal(half.error.kind, "auth_error");
  assert.doesNotMatch(half.error.message, /AKIAONLY/);
  const badNodeToken = await runS3Failing("list_buckets", { access_token: "no-colon-secret" }, {});
  assert.equal(badNodeToken.error.kind, "auth_error");
  assert.doesNotMatch(badNodeToken.error.message, /no-colon-secret/);
});

// S3 error code -> kind
const ERROR_CASES = [
  [403, "InvalidAccessKeyId", "auth_error"],
  [403, "SignatureDoesNotMatch", "auth_error"],
  [400, "ExpiredToken", "auth_error"],
  [403, "AccessDenied", "permission_denied"],
  [404, "NoSuchBucket", "not_found"],
  [404, "NoSuchKey", "not_found"],
  [400, "InvalidArgument", "invalid_input"],
];

for (const [status, code, kind] of ERROR_CASES) {
  test(`S3 error ${code} maps to ${kind} without retries`, async () => {
    const { error, calls } = await runS3Failing("list_objects", { bucket: "b-1" }, { responses: [xmlError(status, code)] });
    assert.equal(error.kind, kind);
    assert.match(error.message, new RegExp(code));
    assert.equal(calls.length, 1);
  });
}

test("SlowDown and 5xx are retried, then reported as retryable", async () => {
  const { error, calls } = await runS3Failing("list_objects", { bucket: "b-1" }, { responses: [xmlError(503, "SlowDown"), xmlError(500, "InternalError"), xmlError(500, "InternalError")] });
  assert.equal(calls.length, 3);
  assert.equal(error.kind, "api_error");
  assert.equal(error.retryable, true);
  const recovered = await runS3("list_objects", { bucket: "b-1" }, { responses: [xmlError(503, "SlowDown"), { body: "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>" }] });
  assert.equal(recovered.calls.length, 2);
});

test("a wrong-region redirect is not followed and names the bucket's region", async () => {
  const { error, calls } = await runS3Failing("list_objects", { bucket: "b-1" }, { responses: [{ status: 301, headers: { "x-amz-bucket-region": "ap-southeast-1" }, body: "<Error><Code>PermanentRedirect</Code><Message>use the right endpoint</Message></Error>" }] });
  assert.equal(calls.length, 1);
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /S3_REGION=ap-southeast-1/);
});

test("a HEAD 403 without a body is permission_denied with a hint", async () => {
  const { error } = await runS3Failing("head_object", { bucket: "b-1", key: "k" }, { responses: [{ status: 403 }] });
  assert.equal(error.kind, "permission_denied");
  assert.match(error.message, /check the credentials/);
});

test("secrets echoed by the server or a proxy are redacted from errors", async () => {
  const body = `<Error><Code>SignatureDoesNotMatch</Code><Message>secret ${SECRET_KEY} token ${SESSION_TOKEN}</Message></Error>`;
  const { error } = await runS3Failing("list_objects", { bucket: "b-1" }, { responses: [{ status: 403, body }], environment: { ...TEST_ENVIRONMENT, AWS_SESSION_TOKEN: SESSION_TOKEN } });
  assert.doesNotMatch(error.message, new RegExp(SECRET_KEY.replace(/[+/]/g, "\\$&")));
  assert.doesNotMatch(error.message, new RegExp(SESSION_TOKEN));
  assert.match(error.message, /\[redacted\]/);
});

test("network failures are network_error, retried, and cancellations are cancelled", async () => {
  const failure = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const { error, calls } = await runS3Failing("list_buckets", {}, { responses: [{ throws: failure }, { throws: failure }, { throws: failure }] });
  assert.equal(error.kind, "network_error");
  assert.match(error.message, /ECONNREFUSED/);
  assert.equal(calls.length, 3);
});

test("an aborted call is cancelled, and a hanging request times out", async () => {
  // AbortSignal.timeout timers do not keep the event loop alive; the keep-alive timer stands in for the host's stdin.
  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("not aborted")), 2000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      });
    });
  const credentials = { accessKeyId: "AKIATESTKEY", secretAccessKey: SECRET_KEY };
  const transport = createS3Transport({ settings: { ...resolveSettings(TEST_ENVIRONMENT), timeoutMs: 20 }, credentials, fetchImpl: hangingFetch, retryBaseDelayMs: 1 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(transport.request({ method: "GET", signal: controller.signal }), (error) => error.kind === "cancelled");
  await assert.rejects(transport.request({ method: "GET" }), (error) => error.kind === "network_error" && /timed out/.test(error.message));
});

test("invalid bucket names, dot segments and bad endpoints are refused before any request", async () => {
  for (const [args, environment] of [
    [{ bucket: "../etc" }, TEST_ENVIRONMENT],
    [{ bucket: "b-1", key: "a/../b" }, TEST_ENVIRONMENT],
    [{ bucket: "b-1", key: "./x" }, TEST_ENVIRONMENT],
    [{ bucket: "b-1", key: "k" }, { ...TEST_ENVIRONMENT, S3_ENDPOINT: "http://example.com" }],
    [{ bucket: "b-1", key: "k" }, { ...TEST_ENVIRONMENT, S3_ENDPOINT: "https://example.com/path" }],
    [{ bucket: "b-1", key: "k" }, { ...TEST_ENVIRONMENT, S3_REGION: "EU WEST" }],
  ]) {
    const operationName = args.key ? "head_object" : "list_objects";
    const { error, calls } = await runS3Failing(operationName, args, { environment });
    assert.equal(error.kind, "invalid_input", JSON.stringify(args));
    assert.equal(calls.length, 0);
  }
});

test("get_object streams into S3_DOWNLOAD_DIR without overwriting existing files", async () => {
  const downloadDirectory = makeTempDirectory("s3-download-");
  writeFileSync(join(downloadDirectory, "report.csv"), "existing");
  const environment = { ...TEST_ENVIRONMENT, S3_DOWNLOAD_DIR: downloadDirectory };
  const { output } = await runS3("get_object", { bucket: "b-1", key: "dir/report.csv" }, { responses: [{ body: "a,b\n1,2\n", headers: { "content-type": "text/csv", etag: '"e"' } }], environment });
  assert.equal(output.data.bytes, 8);
  assert.notEqual(output.data.path, join(downloadDirectory, "report.csv"));
  assert.match(output.data.path, /report-[0-9a-f]{6}\.csv$/);
  assert.equal(readFileSync(output.data.path, "utf8"), "a,b\n1,2\n");
  assert.equal(readFileSync(join(downloadDirectory, "report.csv"), "utf8"), "existing");
});

test("get_object refuses objects over S3_MAX_DOWNLOAD_BYTES and leaves no partial file", async () => {
  const downloadDirectory = makeTempDirectory("s3-download-");
  const environment = { ...TEST_ENVIRONMENT, S3_DOWNLOAD_DIR: downloadDirectory, S3_MAX_DOWNLOAD_BYTES: "4" };
  const declared = await runS3Failing("get_object", { bucket: "b-1", key: "big.bin" }, { responses: [{ body: "0123456789", headers: { "content-length": "10" } }], environment });
  assert.equal(declared.error.kind, "invalid_input");
  // Without a usable Content-Length the cap applies while streaming.
  const streamed = await runS3Failing("get_object", { bucket: "b-1", key: "big2.bin" }, { responses: [{ body: new ReadableStream({ start: (controller) => { controller.enqueue(new TextEncoder().encode("0123456789")); controller.close(); } }) }], environment });
  assert.equal(streamed.error.kind, "invalid_input");
  assert.equal(existsSync(join(downloadDirectory, "big2.bin")), false);
});

test("get_object without S3_DOWNLOAD_DIR, or with an unsafe file_name, is refused", async () => {
  const noDirectory = await runS3Failing("get_object", { bucket: "b-1", key: "k" }, { responses: [{ body: "x" }] });
  assert.equal(noDirectory.error.kind, "invalid_input");
  assert.match(noDirectory.error.message, /S3_DOWNLOAD_DIR/);
  const environment = { ...TEST_ENVIRONMENT, S3_DOWNLOAD_DIR: makeTempDirectory("s3-download-") };
  for (const fileName of ["../x", "a/b", "..", ".hidden"]) {
    const { error, calls } = await runS3Failing("get_object", { bucket: "b-1", key: "k", file_name: fileName }, { environment });
    assert.equal(error.kind, "invalid_input", fileName);
    assert.equal(calls.length, 0);
  }
});

test("get_object output text asks for a capped range and flags truncation", async () => {
  const environment = { ...TEST_ENVIRONMENT, S3_MAX_TEXT_BYTES: "5" };
  const { output, calls } = await runS3("get_object", { bucket: "b-1", key: "notes.txt", output: "text" }, { responses: [{ status: 206, body: "hello!", headers: { "content-range": "bytes 0-5/100", "content-type": "text/plain" } }], environment });
  assert.equal(calls[0].headers.range, "bytes=0-5");
  assert.deepEqual({ text: output.data.text, truncated: output.data.truncated, total: output.data.total_bytes }, { text: "hello", truncated: true, total: 100 });
  const empty = await runS3("get_object", { bucket: "b-1", key: "empty.txt", output: "text" }, { responses: [xmlError(416, "InvalidRange"), { body: "" }], environment });
  assert.equal(empty.calls.length, 2);
  assert.equal(empty.calls[1].headers.range, undefined);
  assert.equal(empty.output.data.text, "");
});

test("put_object from text sends the body, its hash, type and metadata", async () => {
  const { output, calls } = await runS3("put_object", { bucket: "b-1", key: "notes/a.txt", text: "héllo", metadata: { Source: "graphrt" }, only_if_absent: true }, { responses: [{ headers: { etag: '"x"' } }] });
  assert.equal(calls[0].method, "PUT");
  assert.equal(Buffer.from(calls[0].body).toString("utf8"), "héllo");
  assert.equal(calls[0].headers["x-amz-content-sha256"], createHash("sha256").update("héllo").digest("hex"));
  assert.equal(calls[0].headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(calls[0].headers["x-amz-meta-source"], "graphrt");
  assert.equal(calls[0].headers["if-none-match"], "*");
  assert.match(calls[0].headers.authorization, /SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-source,/);
  assert.deepEqual(output.data, { bucket: "b-1", key: "notes/a.txt", bytes: 6, etag: '"x"', version_id: null });
});

test("a conditional put is not retried after a 5xx (its outcome is unknown)", async () => {
  const { error, calls } = await runS3Failing("put_object", { bucket: "b-1", key: "k", text: "x", only_if_absent: true }, { responses: [xmlError(500, "InternalError")] });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /outcome unknown/);
});

test("put_object from a file only inside S3_UPLOAD_DIR, regular files only", async () => {
  const uploadDirectory = makeTempDirectory("s3-upload-");
  const outsideDirectory = makeTempDirectory("s3-outside-");
  writeFileSync(join(uploadDirectory, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(outsideDirectory, "secret.txt"), "nope");
  symlinkSync(join(outsideDirectory, "secret.txt"), join(uploadDirectory, "link.txt"));
  mkfifoSync(join(uploadDirectory, "pipe"));
  const environment = { ...TEST_ENVIRONMENT, S3_UPLOAD_DIR: uploadDirectory };
  const { calls } = await runS3("put_object", { bucket: "b-1", key: "c.png", file_path: join(uploadDirectory, "chart.png") }, { environment });
  assert.equal(calls[0].headers["content-type"], "image/png");
  assert.equal(calls[0].body.length, 4);
  for (const filePath of [join(outsideDirectory, "secret.txt"), join(uploadDirectory, "link.txt"), join(uploadDirectory, "..", "x"), "relative.txt", join(uploadDirectory, "pipe")]) {
    const { error, calls: refusedCalls } = await runS3Failing("put_object", { bucket: "b-1", key: "k", file_path: filePath }, { environment });
    assert.equal(error.kind, "invalid_input", filePath);
    assert.equal(refusedCalls.length, 0);
  }
  const disabled = await runS3Failing("put_object", { bucket: "b-1", key: "k", file_path: join(uploadDirectory, "chart.png") }, {});
  assert.match(disabled.error.message, /S3_UPLOAD_DIR/);
  const both = await runS3Failing("put_object", { bucket: "b-1", key: "k", text: "a", file_path: join(uploadDirectory, "chart.png") }, { environment });
  assert.match(both.error.message, /exactly one/);
});

test("copy_object sends the encoded copy source and detects errors inside a 200 response", async () => {
  const okBody = "<CopyObjectResult><ETag>&quot;c&quot;</ETag><LastModified>2026-11-19T10:00:00Z</LastModified></CopyObjectResult>";
  const { output, calls } = await runS3("copy_object", { source_bucket: "src", source_key: "a b/c.txt", source_version_id: "v1", bucket: "dst", key: "d.txt" }, { responses: [{ body: okBody }] });
  assert.equal(calls[0].headers["x-amz-copy-source"], "/src/a%20b/c.txt?versionId=v1");
  assert.equal(calls[0].headers["x-amz-metadata-directive"], "COPY");
  assert.equal(output.data.etag, '"c"');
  const { error, calls: failedCalls } = await runS3Failing("copy_object", { source_bucket: "src", source_key: "k", bucket: "dst", key: "d" }, { responses: [{ body: "<Error><Code>InternalError</Code></Error>" }, { body: "<Error><Code>InternalError</Code></Error>" }, { body: "<Error><Code>InternalError</Code></Error>" }] });
  assert.equal(error.kind, "api_error");
  assert.equal(failedCalls.length, 3);
});

test("agent tools are read-only: put and copy need S3_TOOL_ALLOW_WRITES=1, delete and presign are node only", async () => {
  for (const [operationName, args] of [
    ["put_object", { bucket: "b-1", key: "k", text: "x" }],
    ["copy_object", { source_bucket: "s", source_key: "k", bucket: "b-1", key: "k2" }],
  ]) {
    const { error, calls } = await runS3Failing(operationName, args, { source: "tool" });
    assert.equal(error.kind, "permission_denied");
    assert.match(error.message, /S3_TOOL_ALLOW_WRITES=1/);
    assert.equal(calls.length, 0);
  }
  const allowed = await runS3("put_object", { bucket: "b-1", key: "k", text: "x" }, { source: "tool", environment: { ...TEST_ENVIRONMENT, S3_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(allowed.calls.length, 1);
  for (const operationName of ["delete_object", "presign_get_url"]) {
    const { error } = await runS3Failing(operationName, { bucket: "b-1", key: "k" }, { source: "tool" });
    assert.equal(error.kind, "invalid_input");
    assert.match(error.message, /Unknown operation/);
  }
  const toolAccessToken = await runS3("list_buckets", { access_token: "EVIL:evil-secret" }, { source: "tool", responses: [{ body: "<ListAllMyBucketsResult/>" }] });
  assert.match(toolAccessToken.calls[0].headers.authorization, /Credential=AKIATESTKEY\//);
});

test("presign_get_url signs the query, includes the session token and never the secret", async () => {
  const environment = { ...TEST_ENVIRONMENT, AWS_SESSION_TOKEN: SESSION_TOKEN };
  const { output, calls } = await runS3("presign_get_url", { bucket: "b-1", key: "a b.pdf", expires_in_seconds: 900, response_content_disposition: "attachment" }, { environment });
  assert.equal(calls.length, 0);
  const url = new URL(output.data.url);
  assert.equal(url.origin + url.pathname, "https://b-1.s3.eu-west-1.amazonaws.com/a%20b.pdf");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(url.searchParams.get("X-Amz-Security-Token"), SESSION_TOKEN);
  assert.equal(url.searchParams.get("response-content-disposition"), "attachment");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
  assert.ok(!output.data.url.includes(encodeURIComponent(SECRET_KEY)) && !output.data.url.includes(SECRET_KEY));
  assert.equal(output.data.expires_at, "2026-11-19T10:15:00.000Z");
});
