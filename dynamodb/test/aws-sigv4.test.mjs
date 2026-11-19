// The signer is a byte-identical copy of s3/lib/aws-sigv4.mjs (plugins are installed one directory at a time, so
// each carries its own copy). The full AWS test-suite vectors live in s3/test/aws-sigv4.test.mjs; a few are
// repeated here so this plugin's copy is checked on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EMPTY_PAYLOAD_SHA256, hashPayload, signRequestHeaders } from "../lib/aws-sigv4.mjs";

const OWN_COPY = fileURLToPath(new URL("../lib/aws-sigv4.mjs", import.meta.url));
const S3_COPY = fileURLToPath(new URL("../../s3/lib/aws-sigv4.mjs", import.meta.url));
const SUITE = { credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }, region: "us-east-1", service: "service", now: new Date("2015-08-30T12:36:00Z") };

test("lib/aws-sigv4.mjs is byte-identical to the s3 plugin's copy", { skip: existsSync(S3_COPY) ? false : "s3 plugin not next to this one" }, () => {
  assert.ok(readFileSync(OWN_COPY).equals(readFileSync(S3_COPY)), "copy s3/lib/aws-sigv4.mjs over dynamodb/lib/aws-sigv4.mjs");
});

test("AWS test suite get-vanilla and post-x-www-form-urlencoded", () => {
  const vanilla = signRequestHeaders({ method: "GET", url: "https://example.amazonaws.com/", headers: {}, payloadHash: EMPTY_PAYLOAD_SHA256, ...SUITE });
  assert.equal(vanilla.authorization.split("Signature=")[1], "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  const form = signRequestHeaders({
    method: "POST",
    url: "https://example.amazonaws.com/",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "13" },
    payloadHash: hashPayload("Param1=value1"),
    includeContentSha256Header: true,
    ...SUITE,
  });
  assert.equal(form.authorization.split("Signature=")[1], "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b");
});
