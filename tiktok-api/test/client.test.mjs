import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBusinessError, detectOAuthError, detectOpenApiError, parseOpenApiError } from "../lib/client.mjs";
import { businessOk, openOk, runWithResponses, TEST_ENVIRONMENT } from "./helpers.mjs";

const openErrorBody = (code) => ({ data: {}, error: { code, message: `msg for ${code}`, log_id: "LOG9" } });

for (const [code, expectedKind] of [
  ["access_token_invalid", "auth_error"],
  ["scope_not_authorized", "permission_denied"],
  ["scope_permission_missed", "permission_denied"],
  ["rate_limit_exceeded", "rate_limited"],
  ["invalid_param", "invalid_input"],
  ["invalid_params", "invalid_input"],
  ["privacy_level_option_mismatch", "invalid_input"],
  ["spam_risk_too_many_posts", "permission_denied"],
  ["spam_risk_user_banned_from_posting", "permission_denied"],
  ["unaudited_client_can_only_post_to_private_accounts", "permission_denied"],
  ["url_ownership_unverified", "permission_denied"],
  ["internal_error", "api_error"],
]) {
  test(`detectOpenApiError maps ${code} to ${expectedKind}`, () => {
    const detected = detectOpenApiError(openErrorBody(code));
    assert.equal(detected.kind, expectedKind);
    assert.match(detected.message, new RegExp(`msg for ${code}`));
    assert.match(detected.message, new RegExp(code));
    assert.match(detected.message, /LOG9/);
  });
}

test("detectOpenApiError ignores code ok and bodies without an error object", () => {
  assert.equal(detectOpenApiError(openOk().body), null);
  assert.equal(detectOpenApiError({ data: {} }), null);
});

test("parseOpenApiError maps non-2xx Open API bodies and leaves others to the default", () => {
  assert.equal(parseOpenApiError(401, openErrorBody("access_token_invalid")).kind, "auth_error");
  assert.equal(parseOpenApiError(429, openErrorBody("rate_limit_exceeded")).kind, "rate_limited");
  assert.deepEqual(parseOpenApiError(502, { text: "Bad gateway" }), {});
});

for (const [code, expectedKind] of [
  [40100, "rate_limited"],
  [40001, "permission_denied"],
  [40002, "invalid_input"],
  [40104, "auth_error"],
  [40105, "auth_error"],
  [50000, "api_error"],
]) {
  test(`detectBusinessError maps code ${code} to ${expectedKind}`, () => {
    const detected = detectBusinessError({ code, message: "biz failure", request_id: "REQ7" });
    assert.equal(detected.kind, expectedKind);
    assert.match(detected.message, /biz failure/);
    assert.match(detected.message, /REQ7/);
  });
}

test("detectBusinessError ignores code 0", () => {
  assert.equal(detectBusinessError(businessOk().body), null);
});

for (const [errorCode, expectedKind] of [
  ["invalid_grant", "auth_error"],
  ["invalid_client", "auth_error"],
  ["invalid_request", "invalid_input"],
  ["rate_limit_exceeded", "rate_limited"],
]) {
  test(`detectOAuthError maps ${errorCode} to ${expectedKind}`, () => {
    const detected = detectOAuthError({ error: errorCode, error_description: "nope", log_id: "L" });
    assert.equal(detected.kind, expectedKind);
    assert.match(detected.message, /nope/);
  });
}

test("an Open API error inside an HTTP 200 body becomes a PluginError", async () => {
  await assert.rejects(runWithResponses("get_user_info", {}, [{ body: openErrorBody("access_token_invalid") }]), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.doesNotMatch(error.message, /open-token/);
    return true;
  });
});

test("a Business API non-zero code inside an HTTP 200 body becomes a PluginError", async () => {
  await assert.rejects(
    runWithResponses("delete_comment", { comment_id: "c1" }, [{ body: { code: 40002, message: "bad comment_id", request_id: "R" } }]),
    (error) => error.kind === "invalid_input" && /bad comment_id/.test(error.message),
  );
});

test("business token never appears in error messages", async () => {
  await assert.rejects(
    runWithResponses("delete_comment", { comment_id: "c1" }, [{ body: { code: 40105, message: "token business-token is invalid", request_id: "R" } }]),
    (error) => error.kind === "auth_error" && !error.message.includes("business-token"),
  );
});

test("business operations fail with auth_error naming TIKTOK_BUSINESS_ACCESS_TOKEN when it is missing", async () => {
  const { TIKTOK_BUSINESS_ACCESS_TOKEN, ...environmentWithoutBusinessToken } = TEST_ENVIRONMENT;
  await assert.rejects(
    runWithResponses("list_comments", { video_id: "v1" }, [businessOk()], environmentWithoutBusinessToken),
    (error) => error.kind === "auth_error" && error.message.includes("TIKTOK_BUSINESS_ACCESS_TOKEN"),
  );
});

test("Open API operations work without the business token", async () => {
  const { TIKTOK_BUSINESS_ACCESS_TOKEN, TIKTOK_BUSINESS_ID, ...openOnlyEnvironment } = TEST_ENVIRONMENT;
  const { calls } = await runWithResponses("get_user_info", {}, [openOk({ user: { open_id: "o1" } })], openOnlyEnvironment);
  assert.equal(calls[0].headers.authorization, "Bearer open-token");
});

test("business operations work with only the business token", async () => {
  const { TIKTOK_ACCESS_TOKEN, ...businessOnlyEnvironment } = TEST_ENVIRONMENT;
  const { calls } = await runWithResponses("delete_comment", { comment_id: "c1" }, [businessOk()], businessOnlyEnvironment);
  assert.equal(calls[0].headers["access-token"], "business-token");
});

test("Open API operations fail with auth_error naming TIKTOK_ACCESS_TOKEN when it is missing", async () => {
  const { TIKTOK_ACCESS_TOKEN, ...businessOnlyEnvironment } = TEST_ENVIRONMENT;
  await assert.rejects(
    runWithResponses("get_user_info", {}, [openOk()], businessOnlyEnvironment),
    (error) => error.kind === "auth_error" && error.message.includes("TIKTOK_ACCESS_TOKEN"),
  );
});

test("business operations need a business id", async () => {
  const { TIKTOK_BUSINESS_ID, ...environmentWithoutBusinessId } = TEST_ENVIRONMENT;
  await assert.rejects(
    runWithResponses("delete_comment", { comment_id: "c1" }, [businessOk()], environmentWithoutBusinessId),
    (error) => error.kind === "invalid_input" && error.message.includes("TIKTOK_BUSINESS_ID"),
  );
});
