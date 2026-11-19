// SigV4 signer checked against the official AWS signing test suite (awslabs/aws-c-auth
// tests/aws-signing-test-suite/v4, the same vectors as the original aws-sig-v4-test-suite) and the worked
// examples of the Amazon S3 "Authenticating Requests (AWS Signature Version 4)" documentation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCanonicalRequest,
  deriveSigningKey,
  EMPTY_PAYLOAD_SHA256,
  hashPayload,
  presignUrl,
  signRequestHeaders,
  UNSIGNED_PAYLOAD,
  uriEncode,
} from "../lib/aws-sigv4.mjs";

const SUITE_CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const SUITE_SCOPE = { region: "us-east-1", service: "service", now: new Date("2015-08-30T12:36:00Z") };
const SUITE_HOST = "https://example.amazonaws.com";

// [name, method, path+query, extra headers, body, header signature, query (presigned) signature]
const SUITE_VECTORS = [
  ["get-vanilla", "GET", "/", {}, undefined, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31", "e93c787ed7f371d5c6b165c1b38ede9550f4dce4144713e844b25b7192d3865d"],
  ["get-vanilla-query-order-key-case", "GET", "/?Param2=value2&Param1=value1", {}, undefined, "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500", "86012e2c9ad4d77369f5d81c11f75158aae4f895a085212cc6d3f923d300bed5"],
  ["get-vanilla-query-order-encoded", "GET", "/?Param-3=Value3&Param=Value2&%E1%88%B4=Value1", {}, undefined, "371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac", "c5f1848ceec943ac2ca68ee720460c23aaae30a2300586597ada94c4a65e4787"],
  ["get-unreserved", "GET", "/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", {}, undefined, "07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f", "95968482db1b9e0fadef6efc1bd24689f77c77d9ef56919c96a28cc92e0d6005"],
  ["get-utf8", "GET", "/ሴ", {}, undefined, "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85", "10eae3f14a260bd3911cc6d008d3c576d143b05b62f09782a7a4b37f52178e44"],
  ["get-space-unnormalized", "GET", "/example space/", {}, undefined, "652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741", "7a1f416954786484c9824d93c1f26ef64acb9b1b6c9154d08c9f07d0e394abf6"],
  ["get-header-value-trim", "GET", "/", { "My-Header1": " value1", "My-Header2": ' "a   b   c"' }, undefined, "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736", undefined],
  ["post-vanilla", "POST", "/", {}, undefined, "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b", "2ce6e6d2e0cf2f9d1b55fafec88cd20574c31dc2e7631979f71ba2310083e95b"],
  ["post-vanilla-query", "POST", "/?Param1=value1", {}, undefined, "28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11", "a9ef26247f293bffe40eeff86a0480ba8c14d31503b2e0c3399e3a16bf1a3682"],
];

for (const [vectorName, method, pathAndQuery, extraHeaders, body, headerSignature, querySignature] of SUITE_VECTORS) {
  test(`AWS test suite ${vectorName}: header signature`, () => {
    const signedHeaders = signRequestHeaders({
      method,
      url: `${SUITE_HOST}${pathAndQuery}`,
      headers: { ...extraHeaders },
      payloadHash: hashPayload(body),
      credentials: SUITE_CREDENTIALS,
      ...SUITE_SCOPE,
    });
    assert.equal(signedHeaders["x-amz-date"], "20150830T123600Z");
    assert.match(signedHeaders.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=/);
    assert.equal(signedHeaders.authorization.split("Signature=")[1], headerSignature);
  });
  if (!querySignature) continue;
  test(`AWS test suite ${vectorName}: query (presigned) signature`, () => {
    const signedUrl = presignUrl({ method, url: `${SUITE_HOST}${pathAndQuery}`, payloadHash: EMPTY_PAYLOAD_SHA256, credentials: SUITE_CREDENTIALS, expiresInSeconds: 3600, ...SUITE_SCOPE });
    assert.equal(new URL(signedUrl).searchParams.get("X-Amz-Signature"), querySignature);
  });
}

test("AWS test suite post-x-www-form-urlencoded: signed body and content headers", () => {
  const body = "Param1=value1";
  const signedHeaders = signRequestHeaders({
    method: "POST",
    url: `${SUITE_HOST}/`,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "13" },
    payloadHash: hashPayload(body),
    includeContentSha256Header: true,
    credentials: SUITE_CREDENTIALS,
    ...SUITE_SCOPE,
  });
  assert.equal(signedHeaders["x-amz-content-sha256"], "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e");
  assert.match(signedHeaders.authorization, /SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, /);
  assert.equal(signedHeaders.authorization.split("Signature=")[1], "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b");
});

test("AWS test suite get-vanilla-with-session-token: header and query signatures", () => {
  const credentials = { ...SUITE_CREDENTIALS, sessionToken: "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267" };
  const signedHeaders = signRequestHeaders({ method: "GET", url: `${SUITE_HOST}/`, headers: {}, payloadHash: EMPTY_PAYLOAD_SHA256, credentials, ...SUITE_SCOPE });
  assert.equal(signedHeaders["x-amz-security-token"], credentials.sessionToken);
  assert.match(signedHeaders.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token, /);
  assert.equal(signedHeaders.authorization.split("Signature=")[1], "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8");
  const signedUrl = presignUrl({ method: "GET", url: `${SUITE_HOST}/`, payloadHash: EMPTY_PAYLOAD_SHA256, credentials, expiresInSeconds: 3600, ...SUITE_SCOPE });
  assert.equal(new URL(signedUrl).searchParams.get("X-Amz-Security-Token"), credentials.sessionToken);
  assert.equal(new URL(signedUrl).searchParams.get("X-Amz-Signature"), "7ff2b50b376cb4d151970630573d6291dc128cc5c2a12ffb237f73cc53f67b6c");
});

const S3_DOC_CREDENTIALS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const S3_DOC_SCOPE = { region: "us-east-1", service: "s3", now: new Date("2013-05-24T00:00:00Z"), pathEncoding: "s3" };

test("S3 documentation example: GET object with Range", () => {
  const signedHeaders = signRequestHeaders({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: EMPTY_PAYLOAD_SHA256,
    includeContentSha256Header: true,
    credentials: S3_DOC_CREDENTIALS,
    ...S3_DOC_SCOPE,
  });
  assert.match(signedHeaders.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, /);
  assert.equal(signedHeaders.authorization.split("Signature=")[1], "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

test("S3 documentation example: GET bucket with list query (ListObjects)", () => {
  const signedHeaders = signRequestHeaders({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
    headers: {},
    payloadHash: EMPTY_PAYLOAD_SHA256,
    includeContentSha256Header: true,
    credentials: S3_DOC_CREDENTIALS,
    ...S3_DOC_SCOPE,
  });
  assert.equal(signedHeaders.authorization.split("Signature=")[1], "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("S3 documentation example: GET bucket lifecycle (empty query value)", () => {
  const signedHeaders = signRequestHeaders({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/?lifecycle",
    headers: {},
    payloadHash: EMPTY_PAYLOAD_SHA256,
    includeContentSha256Header: true,
    credentials: S3_DOC_CREDENTIALS,
    ...S3_DOC_SCOPE,
  });
  assert.equal(signedHeaders.authorization.split("Signature=")[1], "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
});

test("S3 documentation example: PUT object with storage class and Date header", () => {
  const signedHeaders = signRequestHeaders({
    method: "PUT",
    url: "https://examplebucket.s3.amazonaws.com/test%24file.text",
    headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    payloadHash: hashPayload("Welcome to Amazon S3."),
    includeContentSha256Header: true,
    credentials: S3_DOC_CREDENTIALS,
    ...S3_DOC_SCOPE,
  });
  assert.equal(signedHeaders["x-amz-content-sha256"], "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  assert.match(signedHeaders.authorization, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, /);
  assert.equal(signedHeaders.authorization.split("Signature=")[1], "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

test("S3 documentation example: presigned GET URL", () => {
  const signedUrl = presignUrl({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    payloadHash: UNSIGNED_PAYLOAD,
    credentials: S3_DOC_CREDENTIALS,
    expiresInSeconds: 86400,
    ...S3_DOC_SCOPE,
  });
  const query = new URL(signedUrl).searchParams;
  assert.equal(query.get("X-Amz-Credential"), "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
  assert.equal(query.get("X-Amz-Expires"), "86400");
  assert.equal(query.get("X-Amz-SignedHeaders"), "host");
  assert.equal(query.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  assert.ok(!signedUrl.includes(S3_DOC_CREDENTIALS.secretAccessKey));
});

test("deriveSigningKey matches the documented IAM example key", () => {
  const signingKey = deriveSigningKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam");
  assert.equal(signingKey.toString("hex"), "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
});

test("canonical request: S3 keeps the encoded path, other services encode it again", () => {
  const options = { method: "GET", headers: { host: "h", "x-amz-date": "20150830T123600Z" }, payloadHash: EMPTY_PAYLOAD_SHA256 };
  const s3Request = buildCanonicalRequest({ ...options, url: "https://h/a%20b/c", pathEncoding: "s3" });
  const otherRequest = buildCanonicalRequest({ ...options, url: "https://h/a%20b/c", pathEncoding: "double" });
  assert.equal(s3Request.canonicalRequest.split("\n")[1], "/a%20b/c");
  assert.equal(otherRequest.canonicalRequest.split("\n")[1], "/a%2520b/c");
});

test("uriEncode keeps unreserved characters and encodes everything else", () => {
  assert.equal(uriEncode("a-b_c.d~e f+g/h*", true), "a-b_c.d~e%20f%2Bg%2Fh%2A");
  assert.equal(uriEncode("a/b", false), "a/b");
});

test("signRequestHeaders refuses incomplete credentials and bad scope", () => {
  const base = { method: "GET", url: `${SUITE_HOST}/`, headers: {}, payloadHash: EMPTY_PAYLOAD_SHA256, ...SUITE_SCOPE };
  assert.throws(() => signRequestHeaders({ ...base, credentials: { accessKeyId: "AKID" } }), /secret access key/);
  assert.throws(() => signRequestHeaders({ ...base, credentials: SUITE_CREDENTIALS, region: "" }), /region/);
  assert.throws(() => presignUrl({ ...base, credentials: SUITE_CREDENTIALS, expiresInSeconds: 604801 }), /expire after/);
});
