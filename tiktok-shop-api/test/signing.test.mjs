import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildTiktokShopStringToSign, signTiktokShopRequest } from "../lib/signing.mjs";

// Worked example from the TikTok Shop Partner Center guide "Sign your API request" (Get Authorized Shops).
const DOCUMENTED_EXAMPLE = {
  appSecret: "e59af819cc",
  path: "/authorization/202309/shops",
  query: { app_key: "29a39d", sign: "ignored", timestamp: "1623812664" },
};
const DOCUMENTED_STRING_TO_SIGN = "/authorization/202309/shopsapp_key29a39dtimestamp1623812664";
const DOCUMENTED_SIGNATURE = "b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8";

// The guide's second example (Update Shop Webhook) shows the string with a shop_cipher and a JSON body.
const DOCUMENTED_BODY_EXAMPLE = {
  path: "/event/202309/webhooks",
  query: { timestamp: "1696909648", shop_cipher: "ROW_xkMbgAAAeVAQra0eZWebFQq5aIK", app_key: "68xu9ks5p4i8" },
  body: '{"address":"https://partner.tiktokshop.com","event_type":"PACKAGE_UPDATE"}',
};
const DOCUMENTED_BODY_STRING_TO_SIGN =
  '/event/202309/webhooksapp_key68xu9ks5p4i8shop_cipherROW_xkMbgAAAeVAQra0eZWebFQq5aIKtimestamp1696909648{"address":"https://partner.tiktokshop.com","event_type":"PACKAGE_UPDATE"}';

// Independent reference: HMAC-SHA256 keyed by the app secret over secret + string + secret, hex encoded.
const referenceSignature = (stringToSign, appSecret) => createHmac("sha256", appSecret).update(`${appSecret}${stringToSign}${appSecret}`).digest("hex");

test("buildTiktokShopStringToSign reproduces the documented string (sign excluded, keys sorted)", () => {
  assert.equal(buildTiktokShopStringToSign(DOCUMENTED_EXAMPLE), DOCUMENTED_STRING_TO_SIGN);
});

test("signTiktokShopRequest matches the signature published in the official guide", () => {
  assert.equal(signTiktokShopRequest(DOCUMENTED_EXAMPLE), DOCUMENTED_SIGNATURE);
});

test("signTiktokShopRequest matches an independent node:crypto computation of the documented string", () => {
  assert.equal(signTiktokShopRequest(DOCUMENTED_EXAMPLE), referenceSignature(DOCUMENTED_STRING_TO_SIGN, DOCUMENTED_EXAMPLE.appSecret));
});

test("buildTiktokShopStringToSign appends the exact body after the sorted parameters", () => {
  assert.equal(buildTiktokShopStringToSign(DOCUMENTED_BODY_EXAMPLE), DOCUMENTED_BODY_STRING_TO_SIGN);
  assert.equal(
    signTiktokShopRequest({ ...DOCUMENTED_BODY_EXAMPLE, appSecret: "app-secret-x" }),
    referenceSignature(DOCUMENTED_BODY_STRING_TO_SIGN, "app-secret-x"),
  );
});

test("access_token and sign never enter the string to sign; undefined values are skipped", () => {
  const stringToSign = buildTiktokShopStringToSign({
    path: "/p",
    query: { b: "2", access_token: "tok", sign: "s", a: "1", skipped: undefined },
  });
  assert.equal(stringToSign, "/pa1b2");
});

test("an empty or missing body adds nothing", () => {
  assert.equal(buildTiktokShopStringToSign({ path: "/p", query: {}, body: "" }), "/p");
  assert.equal(buildTiktokShopStringToSign({ path: "/p", query: {} }), "/p");
});

test("the signature depends on path, every parameter, the body and the secret", () => {
  const baseline = signTiktokShopRequest({ ...DOCUMENTED_BODY_EXAMPLE, appSecret: "s1" });
  const variants = [
    { ...DOCUMENTED_BODY_EXAMPLE, appSecret: "s2" },
    { ...DOCUMENTED_BODY_EXAMPLE, appSecret: "s1", path: "/event/202309/webhooks2" },
    { ...DOCUMENTED_BODY_EXAMPLE, appSecret: "s1", query: { ...DOCUMENTED_BODY_EXAMPLE.query, timestamp: "1696909649" } },
    { ...DOCUMENTED_BODY_EXAMPLE, appSecret: "s1", body: '{"address":"x"}' },
  ];
  for (const variant of variants) assert.notEqual(signTiktokShopRequest(variant), baseline);
});
