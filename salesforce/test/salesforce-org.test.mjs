import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstanceBaseUrl, readApiVersion, readOAuthVariant, readSalesforceOrigin, extractQueryLocator } from "../lib/salesforce-org.mjs";

const refuses = (action) => assert.throws(action, (error) => error.kind === "invalid_input");

test("readSalesforceOrigin accepts https Salesforce hosts and returns the origin", () => {
  assert.equal(readSalesforceOrigin("https://acme.my.salesforce.com", "X"), "https://acme.my.salesforce.com");
  assert.equal(readSalesforceOrigin(" https://acme--dev.sandbox.my.salesforce.com/ ", "X"), "https://acme--dev.sandbox.my.salesforce.com");
  assert.equal(readSalesforceOrigin("https://login.salesforce.com", "X"), "https://login.salesforce.com");
});

test("readSalesforceOrigin refuses other hosts, http, paths, ports and credentials", () => {
  for (const value of [
    "https://evil.example",
    "https://salesforce.com.evil.example",
    "https://evilsalesforce.com",
    "http://acme.my.salesforce.com",
    "https://acme.my.salesforce.com/services",
    "https://acme.my.salesforce.com:8443",
    "https://user:pass@acme.my.salesforce.com",
    "https://acme.my.salesforce.com?x=1",
    "not a url",
  ]) refuses(() => readSalesforceOrigin(value, "SALESFORCE_INSTANCE_URL"));
});

test("readApiVersion defaults to v66.0 and normalizes 62 / 62.0 / v62.0", () => {
  assert.equal(readApiVersion({}), "v66.0");
  assert.equal(readApiVersion({ SALESFORCE_API_VERSION: "62.0" }), "v62.0");
  assert.equal(readApiVersion({ SALESFORCE_API_VERSION: "v64.0" }), "v64.0");
  assert.equal(readApiVersion({ SALESFORCE_API_VERSION: "65" }), "v65.0");
  refuses(() => readApiVersion({ SALESFORCE_API_VERSION: "v66.1" }));
  refuses(() => readApiVersion({ SALESFORCE_API_VERSION: "../x" }));
});

test("buildInstanceBaseUrl needs SALESFORCE_INSTANCE_URL", () => {
  assert.equal(buildInstanceBaseUrl({ SALESFORCE_INSTANCE_URL: "https://acme.my.salesforce.com" }), "https://acme.my.salesforce.com/services/data/v66.0");
  assert.throws(() => buildInstanceBaseUrl({}), /SALESFORCE_INSTANCE_URL/);
});

test("readOAuthVariant: refresh grant when a refresh token is set, client credentials otherwise", () => {
  assert.deepEqual(readOAuthVariant({}), { grant: "refresh_token", tokenUrl: "https://login.salesforce.com/services/oauth2/token" });
  assert.deepEqual(readOAuthVariant({ SALESFORCE_REFRESH_TOKEN: "r" }), { grant: "refresh_token", tokenUrl: "https://login.salesforce.com/services/oauth2/token" });
  assert.deepEqual(readOAuthVariant({ SALESFORCE_CLIENT_ID: "c", SALESFORCE_LOGIN_URL: "https://acme.my.salesforce.com" }), {
    grant: "client_credentials",
    tokenUrl: "https://acme.my.salesforce.com/services/oauth2/token",
  });
  assert.deepEqual(readOAuthVariant({ SALESFORCE_CLIENT_ID: "c", SALESFORCE_INSTANCE_URL: "https://acme.my.salesforce.com" }), {
    grant: "client_credentials",
    tokenUrl: "https://acme.my.salesforce.com/services/oauth2/token",
  });
  assert.deepEqual(readOAuthVariant({ SALESFORCE_REFRESH_TOKEN: "r", SALESFORCE_LOGIN_URL: "https://test.salesforce.com" }), {
    grant: "refresh_token",
    tokenUrl: "https://test.salesforce.com/services/oauth2/token",
  });
  refuses(() => readOAuthVariant({ SALESFORCE_LOGIN_URL: "https://login.evil.example" }));
});

test("extractQueryLocator takes a locator or a nextRecordsUrl", () => {
  assert.equal(extractQueryLocator("01gD0000002HU6KIAW-2000"), "01gD0000002HU6KIAW-2000");
  assert.equal(extractQueryLocator("/services/data/v66.0/query/01gD0000002HU6KIAW-2000"), "01gD0000002HU6KIAW-2000");
  assert.equal(extractQueryLocator("/services/data/v66.0/queryAll/01gD0000002HU6KIAW-4000"), "01gD0000002HU6KIAW-4000");
  assert.equal(extractQueryLocator("../../x"), "../../x", "anything else is left for the path checks to refuse");
});
