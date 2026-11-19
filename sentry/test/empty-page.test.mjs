import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const ISSUES_URL = "https://us.sentry.io/api/0/organizations/acme/issues/";
// Sentry always sends rel="next", with results="false" when the next page is empty.
const sentryLinkHeader = (nextCursor, hasResults) =>
  `<${ISSUES_URL}?&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <${ISSUES_URL}?&cursor=${nextCursor}>; rel="next"; results="${hasResults}"; cursor="${nextCursor}"`;

async function listIssues(args, response) {
  const recordingFetch = createRecordingFetch([response]);
  const run = createOperationRunner(pluginDefinition, { SENTRY_AUTH_TOKEN: "sntrys_test" }, { fetchImpl: recordingFetch });
  return { result: await run("list_issues", { organization: "acme", ...args }, { source: "tool" }), calls: recordingFetch.calls };
}

test("a page with results gives the next Link URL as next_cursor", async () => {
  const { result } = await listIssues({}, { body: [{ id: "1" }], headers: { link: sentryLinkHeader("0:100:0", true) } });
  assert.equal(result.next_cursor, `${ISSUES_URL}?&cursor=0:100:0`);
});

test("an empty page ends the listing although Sentry still sends rel=next", async () => {
  const { result } = await listIssues({ cursor: `${ISSUES_URL}?&cursor=0:100:0` }, { body: [], headers: { link: sentryLinkHeader("0:200:0", false) } });
  assert.deepEqual(result.data, []);
  assert.equal(result.next_cursor, null);
});

test("operations without pagination are not changed", async () => {
  const recordingFetch = createRecordingFetch([{ body: { id: "1" } }]);
  const run = createOperationRunner(pluginDefinition, { SENTRY_AUTH_TOKEN: "sntrys_test" }, { fetchImpl: recordingFetch });
  const result = await run("get_issue", { organization: "acme", issue_id: "1" }, { source: "tool" });
  assert.deepEqual(result, { data: { id: "1" }, next_cursor: null });
});
