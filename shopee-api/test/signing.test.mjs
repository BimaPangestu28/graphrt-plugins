import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildShopeeBaseString, computeShopeeSignature, signShopeeBaseString } from "../lib/signing.mjs";

// Base-string examples published in the Shopee Open Platform developer guide ("API calls" > "Signature calculation").
const DOCUMENTED_SHOP_EXAMPLE = {
  partnerId: "2001887",
  path: "/api/v2/shop/get_shop_info",
  timestamp: 1655714431,
  accessToken: "59777174636562737266615546704c6d",
  shopId: "14701711",
};
const DOCUMENTED_SHOP_BASE_STRING = "2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711";
const DOCUMENTED_PUBLIC_BASE_STRING = "2001887/api/v2/public/get_shops_by_partner1655714431";
const TEST_PARTNER_KEY = "shpk-test-partner-key-0001";

// Independent reference: HMAC-SHA256 of the documented string, keyed by the partner key, hex encoded.
const referenceSignature = (baseString, partnerKey) => createHmac("sha256", Buffer.from(partnerKey, "utf8")).update(Buffer.from(baseString, "utf8")).digest("hex");

test("buildShopeeBaseString reproduces the documented shop API base string", () => {
  assert.equal(buildShopeeBaseString(DOCUMENTED_SHOP_EXAMPLE), DOCUMENTED_SHOP_BASE_STRING);
});

test("buildShopeeBaseString reproduces the documented public API base string (no token, no shop)", () => {
  const baseString = buildShopeeBaseString({ partnerId: 2001887, path: "/api/v2/public/get_shops_by_partner", timestamp: 1655714431 });
  assert.equal(baseString, DOCUMENTED_PUBLIC_BASE_STRING);
});

test("signShopeeBaseString is lowercase hex HMAC-SHA256 keyed by the partner key", () => {
  const signature = signShopeeBaseString(DOCUMENTED_SHOP_BASE_STRING, TEST_PARTNER_KEY);
  assert.equal(signature, referenceSignature(DOCUMENTED_SHOP_BASE_STRING, TEST_PARTNER_KEY));
  assert.match(signature, /^[0-9a-f]{64}$/);
});

test("computeShopeeSignature signs the documented shop example end to end", () => {
  const signature = computeShopeeSignature({ ...DOCUMENTED_SHOP_EXAMPLE, partnerKey: TEST_PARTNER_KEY });
  assert.equal(signature, referenceSignature(DOCUMENTED_SHOP_BASE_STRING, TEST_PARTNER_KEY));
});

test("computeShopeeSignature changes when any signed element changes", () => {
  const baseline = computeShopeeSignature({ ...DOCUMENTED_SHOP_EXAMPLE, partnerKey: TEST_PARTNER_KEY });
  for (const [field, value] of [
    ["partnerId", "2001888"],
    ["path", "/api/v2/shop/get_profile"],
    ["timestamp", 1655714432],
    ["accessToken", "other-token"],
    ["shopId", "14701712"],
    ["partnerKey", "other-key"],
  ]) {
    assert.notEqual(computeShopeeSignature({ ...DOCUMENTED_SHOP_EXAMPLE, partnerKey: TEST_PARTNER_KEY, [field]: value }), baseline, field);
  }
});

test("computeShopeeSignature handles non-ASCII partner keys as UTF-8", () => {
  const partnerKey = "kunci-rahasia-é";
  assert.equal(
    computeShopeeSignature({ ...DOCUMENTED_SHOP_EXAMPLE, partnerKey }),
    referenceSignature(DOCUMENTED_SHOP_BASE_STRING, partnerKey),
  );
});
