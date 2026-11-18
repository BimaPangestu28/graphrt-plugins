import { test } from "node:test";
import assert from "node:assert/strict";
import { isInvalidInput, runWithResponses } from "./helpers.mjs";
import { parseBusinessProfileError } from "../lib/client.mjs";
import { DAILY_METRICS } from "../operations/performance.mjs";

const ACCOUNTS = "mybusinessaccountmanagement.googleapis.com";
const INFO = "mybusinessbusinessinformation.googleapis.com";
const V4 = "mybusiness.googleapis.com";
const PERFORMANCE = "businessprofileperformance.googleapis.com";
const LOCATION = { account_id: "111", location_id: "222" };

// Each case: operation + args -> expected single request: host, method, path, query subset, full json when given.
const REQUEST_CASES = [
  ["list_accounts", {}, { host: ACCOUNTS, method: "GET", path: "/v1/accounts", query: { pageSize: "20" } }],
  [
    "list_accounts",
    { parent_account: "accounts/9", type: "LOCATION_GROUP", limit: 5, cursor: "N" },
    { host: ACCOUNTS, method: "GET", path: "/v1/accounts", query: { parentAccount: "accounts/9", filter: "type=LOCATION_GROUP", pageSize: "5", pageToken: "N" } },
  ],
  [
    "list_locations",
    { account_id: "accounts/111", order_by: "title", filter: 'title="Kopi"', limit: 100 },
    { host: INFO, method: "GET", path: "/v1/accounts/111/locations", query: { readMask: "name,title,storeCode,phoneNumbers,storefrontAddress,websiteUri,metadata", orderBy: "title", filter: 'title="Kopi"', pageSize: "100" } },
  ],
  ["list_locations", { account_id: "-" }, { host: INFO, method: "GET", path: "/v1/accounts/-/locations" }],
  ["get_location", { location_id: "locations/222", read_mask: "name,title" }, { host: INFO, method: "GET", path: "/v1/locations/222", query: { readMask: "name,title" } }],
  [
    "update_location",
    { location_id: "222", description: "Kopi enak", primary_phone: "+62 21 5550100", validate_only: true },
    {
      host: INFO,
      method: "PATCH",
      path: "/v1/locations/222",
      query: { updateMask: "profile.description,phoneNumbers.primaryPhone", validateOnly: "true" },
      json: { profile: { description: "Kopi enak" }, phoneNumbers: { primaryPhone: "+62 21 5550100" } },
    },
  ],
  [
    "update_location",
    {
      location_id: "222",
      additional_phones: [],
      regular_hours: [
        { open_day: "monday", open_time: "09:00", close_time: "17:30" },
        { open_day: "FRIDAY", open_time: "22:00", close_day: "SATURDAY", close_time: "02:00" },
      ],
      special_hours: [{ date: "2026-12-25", closed: true }, { date: "2026-12-31", open_time: "10:00", close_time: "24:00" }],
    },
    {
      host: INFO,
      method: "PATCH",
      path: "/v1/locations/222",
      query: { updateMask: "phoneNumbers.additionalPhones,regularHours,specialHours" },
      json: {
        phoneNumbers: { additionalPhones: [] },
        regularHours: {
          periods: [
            { openDay: "MONDAY", openTime: { hours: 9, minutes: 0 }, closeDay: "MONDAY", closeTime: { hours: 17, minutes: 30 } },
            { openDay: "FRIDAY", openTime: { hours: 22, minutes: 0 }, closeDay: "SATURDAY", closeTime: { hours: 2, minutes: 0 } },
          ],
        },
        specialHours: {
          specialHourPeriods: [
            { startDate: { year: 2026, month: 12, day: 25 }, closed: true },
            { startDate: { year: 2026, month: 12, day: 31 }, openTime: { hours: 10, minutes: 0 }, closeTime: { hours: 24, minutes: 0 } },
          ],
        },
      },
    },
  ],
  [
    "list_reviews",
    { ...LOCATION, order_by: "rating", limit: 10, cursor: "R2" },
    { host: V4, method: "GET", path: "/v4/accounts/111/locations/222/reviews", query: { orderBy: "rating", pageSize: "10", pageToken: "R2" } },
  ],
  ["get_review", { ...LOCATION, review_id: "rev_A-1" }, { host: V4, method: "GET", path: "/v4/accounts/111/locations/222/reviews/rev_A-1" }],
  [
    "reply_to_review",
    { ...LOCATION, review_id: "rev1", comment: "Terima kasih!" },
    { host: V4, method: "PUT", path: "/v4/accounts/111/locations/222/reviews/rev1/reply", json: { comment: "Terima kasih!" } },
  ],
  ["delete_review_reply", { ...LOCATION, review_id: "rev1" }, { host: V4, method: "DELETE", path: "/v4/accounts/111/locations/222/reviews/rev1/reply" }],
  ["list_local_posts", { ...LOCATION, limit: 100 }, { host: V4, method: "GET", path: "/v4/accounts/111/locations/222/localPosts", query: { pageSize: "100" } }],
  [
    "create_local_post",
    { ...LOCATION, summary: "Promo kopi", call_to_action_type: "ORDER", call_to_action_url: "https://kopi.example/order", media_url: "https://kopi.example/a.jpg", language_code: "id" },
    {
      host: V4,
      method: "POST",
      path: "/v4/accounts/111/locations/222/localPosts",
      json: {
        languageCode: "id",
        summary: "Promo kopi",
        topicType: "STANDARD",
        callToAction: { actionType: "ORDER", url: "https://kopi.example/order" },
        media: [{ mediaFormat: "PHOTO", sourceUrl: "https://kopi.example/a.jpg" }],
      },
    },
  ],
  [
    "create_local_post",
    { ...LOCATION, topic_type: "EVENT", event_title: "Live music", event_start: "2026-12-20T19:00", event_end: "2026-12-20T22:30", call_to_action_type: "CALL" },
    {
      host: V4,
      method: "POST",
      path: "/v4/accounts/111/locations/222/localPosts",
      json: {
        topicType: "EVENT",
        callToAction: { actionType: "CALL" },
        event: {
          title: "Live music",
          schedule: { startDate: { year: 2026, month: 12, day: 20 }, startTime: { hours: 19, minutes: 0 }, endDate: { year: 2026, month: 12, day: 20 }, endTime: { hours: 22, minutes: 30 } },
        },
      },
    },
  ],
  [
    "create_local_post",
    { ...LOCATION, topic_type: "OFFER", summary: "Diskon", event_title: "Diskon 20%", event_start: "2026-12-01", event_end: "2026-12-31", offer_coupon_code: "KOPI20", offer_terms: "Min. 2 cups" },
    {
      host: V4,
      method: "POST",
      path: "/v4/accounts/111/locations/222/localPosts",
      json: {
        summary: "Diskon",
        topicType: "OFFER",
        event: { title: "Diskon 20%", schedule: { startDate: { year: 2026, month: 12, day: 1 }, endDate: { year: 2026, month: 12, day: 31 } } },
        offer: { couponCode: "KOPI20", termsConditions: "Min. 2 cups" },
      },
    },
  ],
  ["delete_local_post", { ...LOCATION, local_post_id: "localPosts/p9" }, { host: V4, method: "DELETE", path: "/v4/accounts/111/locations/222/localPosts/p9" }],
  [
    "api_request",
    { host: "business_information", path: "/categories", query: { regionCode: "ID", languageCode: "id", view: "BASIC" } },
    { host: INFO, method: "GET", path: "/v1/categories", query: { regionCode: "ID", view: "BASIC" } },
  ],
  ["api_request", { path: "/accounts/111/locations/222/media" }, { host: V4, method: "GET", path: "/v4/accounts/111/locations/222/media" }],
];

for (const [operationName, args, expectedRequest] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.host}${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args, [{ body: {} }]);
    assert.equal(calls.length, 1);
    const [call] = calls;
    const url = new URL(call.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, expectedRequest.host);
    assert.equal(call.method, expectedRequest.method);
    assert.equal(call.path, expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer google-token");
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("get_daily_metrics repeats dailyMetrics, sends the date range and flattens the series", async () => {
  const responseBody = {
    multiDailyMetricTimeSeries: [
      {
        dailyMetricTimeSeries: [
          { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 1 }, value: "3" }, { date: { year: 2026, month: 11, day: 2 } }] } },
          { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 1 }, value: "10" }] } },
        ],
      },
    ],
  };
  const { calls, output } = await runWithResponses(
    "get_daily_metrics",
    { location_id: "locations/222", start_date: "2026-11-01", end_date: "2026-11-02", metrics: ["CALL_CLICKS", "WEBSITE_CLICKS", "CALL_CLICKS"] },
    [{ body: responseBody }],
  );
  const url = new URL(calls[0].url);
  assert.equal(url.host, PERFORMANCE);
  assert.equal(url.pathname, "/v1/locations/222:fetchMultiDailyMetricsTimeSeries");
  assert.deepEqual(url.searchParams.getAll("dailyMetrics"), ["CALL_CLICKS", "WEBSITE_CLICKS"]);
  assert.deepEqual(
    ["year", "month", "day"].flatMap((part) => [url.searchParams.get(`dailyRange.start_date.${part}`), url.searchParams.get(`dailyRange.end_date.${part}`)]),
    ["2026", "2026", "11", "11", "1", "2"],
  );
  assert.deepEqual(output.data.metrics, [
    { metric: "CALL_CLICKS", sub_entity_type: null, total: 3, values: [{ date: "2026-11-01", value: 3 }, { date: "2026-11-02", value: 0 }] },
    { metric: "WEBSITE_CLICKS", sub_entity_type: null, total: 10, values: [{ date: "2026-11-01", value: 10 }] },
  ]);
});

test("get_daily_metrics defaults to every non-deprecated metric", async () => {
  const { calls } = await runWithResponses("get_daily_metrics", { location_id: "1", start_date: "2026-01-01", end_date: "2026-01-31" }, [{ body: {} }]);
  const metrics = new URL(calls[0].url).searchParams.getAll("dailyMetrics");
  assert.equal(metrics.length, 10);
  assert.ok(!metrics.includes("BUSINESS_CONVERSATIONS") && !metrics.includes("BUSINESS_FOOD_ORDERS"));
});

test("list operations map items and nextPageToken", async () => {
  const accounts = await runWithResponses("list_accounts", {}, [{ body: { accounts: [{ name: "accounts/1" }], nextPageToken: "N" } }]);
  assert.deepEqual(accounts.output, { data: [{ name: "accounts/1" }], next_cursor: "N" });
  const locations = await runWithResponses("list_locations", { account_id: "1" }, [{ body: {} }]);
  assert.deepEqual(locations.output, { data: [], next_cursor: null });
  const reviews = await runWithResponses("list_reviews", LOCATION, [{ body: { reviews: [{ reviewId: "r" }], averageRating: 4.5, totalReviewCount: 12, nextPageToken: "R" } }]);
  assert.deepEqual(reviews.output, { data: { reviews: [{ reviewId: "r" }], average_rating: 4.5, total_review_count: 12 }, next_cursor: "R" });
  const posts = await runWithResponses("list_local_posts", LOCATION, [{ body: { localPosts: [{ name: "p" }] } }]);
  assert.deepEqual(posts.output, { data: [{ name: "p" }], next_cursor: null });
});

test("deletes report what was deleted on an empty response", async () => {
  const reply = await runWithResponses("delete_review_reply", { ...LOCATION, review_id: "rev1" }, [{ status: 200, body: {} }]);
  assert.deepEqual(reply.output.data, { deleted: true, review_id: "rev1" });
  const post = await runWithResponses("delete_local_post", { ...LOCATION, local_post_id: "p9" }, [{ status: 200, body: {} }]);
  assert.deepEqual(post.output.data, { deleted: true, local_post_id: "p9" });
});

test("create_local_post is never retried after an unknown outcome and says how to check", async () => {
  const serverError = { status: 503, body: { error: { code: 503, message: "unavailable", status: "UNAVAILABLE" } } };
  await assert.rejects(runWithResponses("create_local_post", { ...LOCATION, summary: "hi" }, [serverError, { body: {} }]), (error) => {
    assert.equal(error.retryable, false);
    assert.match(error.message, /outcome unknown/);
    assert.match(error.message, /list_local_posts/);
    return true;
  });
});

test("ids are strict: no extra segments, queries or traversal", async () => {
  const invalidCases = [
    ["get_location", { location_id: "222/../333" }],
    ["get_location", { location_id: "accounts/1/locations" }],
    ["get_location", { location_id: "accounts/1/reviews/2" }],
    ["get_review", { ...LOCATION, review_id: "r?x=1" }],
    ["list_reviews", { account_id: "1#x", location_id: "2" }],
    ["delete_local_post", { ...LOCATION, local_post_id: ".." }],
    ["list_accounts", { parent_account: "accounts/1/x" }],
    ["list_locations", { account_id: "a b" }],
  ];
  for (const [operationName, args] of invalidCases) {
    await assert.rejects(runWithResponses(operationName, args, []), isInvalidInput, `${operationName} ${JSON.stringify(args)}`);
  }
});

test("update_location validation", async () => {
  const invalidCases = [
    {},
    { description: "x".repeat(751) },
    { regular_hours: [] },
    { regular_hours: [{ open_day: "FUNDAY", open_time: "09:00", close_time: "17:00" }] },
    { regular_hours: [{ open_day: "MONDAY", open_time: "9am", close_time: "17:00" }] },
    { regular_hours: [{ open_day: "MONDAY", open_time: "24:30", close_time: "17:00" }] },
    { regular_hours: ["MONDAY 9-5"] },
    { special_hours: [{ date: "2026-02-30", closed: true }] },
    { special_hours: [{ date: "2026-12-31", open_time: "10:00" }] },
    { additional_phones: ["1", "2", "3"] },
  ];
  for (const extraArgs of invalidCases) {
    await assert.rejects(runWithResponses("update_location", { location_id: "222", ...extraArgs }, []), isInvalidInput, JSON.stringify(extraArgs));
  }
});

test("create_local_post validation", async () => {
  const invalidCases = [
    {},
    { summary: "x".repeat(1501) },
    { summary: "s", call_to_action_type: "BOOK" },
    { summary: "s", call_to_action_type: "CALL", call_to_action_url: "https://a.example" },
    { summary: "s", call_to_action_url: "https://a.example" },
    { summary: "s", call_to_action_type: "SHOP", call_to_action_url: "javascript:alert(1)" },
    { summary: "s", media_url: "file:///etc/passwd" },
    { summary: "s", event_title: "x" },
    { summary: "s", offer_coupon_code: "X" },
    { topic_type: "EVENT", event_title: "x", event_start: "2026-12-01" },
    { topic_type: "EVENT", event_title: "x", event_start: "2026-12-01", event_end: "12/31/2026" },
    { topic_type: "EVENT", event_title: "x", event_start: "2026-12-01", event_end: "2026-12-02", offer_terms: "t" },
    { topic_type: "OFFER", event_title: "x", event_start: "2026-12-01", event_end: "2026-12-02", offer_redeem_url: "ftp://x" },
    { topic_type: "EVENT", event_title: "x", event_start: "2026-12-02", event_end: "2026-12-01" },
    { topic_type: "EVENT", event_title: "x", event_start: "2026-12-01T20:00", event_end: "2026-12-01T19:00" },
    { topic_type: "EVENT", event_title: "x", event_start: "2026-12-01T20:00", event_end: "2026-12-01T20:00" },
    { topic_type: "EVENT", event_title: "x", event_start: "2026-12-01T20:00", event_end: "2026-12-02" },
    { topic_type: "EVENT", event_title: "x", event_start: "2026-12-01", event_end: "2026-12-02T10:00" },
  ];
  for (const extraArgs of invalidCases) {
    await assert.rejects(runWithResponses("create_local_post", { ...LOCATION, ...extraArgs }, []), isInvalidInput, JSON.stringify(extraArgs));
  }
});

test("reply_to_review and get_daily_metrics validation", async () => {
  await assert.rejects(runWithResponses("reply_to_review", { ...LOCATION, review_id: "r", comment: "é".repeat(2049) }, []), isInvalidInput);
  const metricCases = [
    { start_date: "2026-11-05", end_date: "2026-11-01" },
    { start_date: "2026-13-01", end_date: "2026-11-01" },
    { start_date: "2026-11-01", end_date: "2026-11-02", metrics: [] },
    { start_date: "2026-11-01", end_date: "2026-11-02", metrics: ["BUSINESS_CONVERSATIONS"] },
  ];
  for (const extraArgs of metricCases) {
    await assert.rejects(runWithResponses("get_daily_metrics", { location_id: "1", ...extraArgs }, []), isInvalidInput, JSON.stringify(extraArgs));
  }
});

test("api_request is restricted to the selected Business Profile host", async () => {
  await assert.rejects(runWithResponses("api_request", { host: "www.googleapis.com", path: "/x" }, []), isInvalidInput);
  await assert.rejects(runWithResponses("api_request", { host: "performance", path: "https://evil.example.com/steal" }, []), isInvalidInput);
  await assert.rejects(runWithResponses("api_request", { host: "performance", path: "//evil.example.com/steal" }, []), isInvalidInput);
});

test("Google errors map to kinds and quota errors mention API approval", async () => {
  const permissionDenied = { status: 403, body: { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } } };
  await assert.rejects(runWithResponses("list_reviews", LOCATION, [permissionDenied]), (error) => error.kind === "permission_denied");
  const notFound = { status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } };
  await assert.rejects(runWithResponses("get_location", { location_id: "1" }, [notFound]), (error) => error.kind === "not_found");
  const quota = parseBusinessProfileError(429, { error: { code: 429, message: "Quota exceeded for quota metric 'Requests'", status: "RESOURCE_EXHAUSTED", details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } });
  assert.equal(quota.kind, "rate_limited");
  assert.match(quota.message, /approved by Google/);
  assert.doesNotMatch(parseBusinessProfileError(403, permissionDenied.body).message, /approved/);
});

test("DAILY_METRICS is the official non-deprecated DailyMetric enum (developers.google.com performance/rest/v1/DailyMetric)", () => {
  assert.deepEqual([...DAILY_METRICS].sort(), [
    "BUSINESS_BOOKINGS",
    "BUSINESS_DIRECTION_REQUESTS",
    "BUSINESS_FOOD_MENU_CLICKS",
    "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
    "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
    "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
    "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
    "CALL_CLICKS",
    "MESSAGING_CLICKS",
    "WEBSITE_CLICKS",
  ]);
});

test("ids accept full resource names: the id after the matching collection is used", async () => {
  const cases = [
    ["get_review", { account_id: "accounts/111", location_id: "accounts/111/locations/222", review_id: "accounts/111/locations/222/reviews/rev1" }, "/v4/accounts/111/locations/222/reviews/rev1"],
    ["delete_local_post", { account_id: "111", location_id: "locations/222", local_post_id: "accounts/111/locations/222/localPosts/p9" }, "/v4/accounts/111/locations/222/localPosts/p9"],
    ["get_location", { location_id: "accounts/111/locations/222" }, "/v1/locations/222"],
    ["list_locations", { account_id: "accounts/-" }, "/v1/accounts/-/locations"],
  ];
  for (const [operationName, args, expectedPath] of cases) {
    const { calls } = await runWithResponses(operationName, args, [{ body: {} }]);
    assert.equal(calls[0].path, expectedPath, operationName);
  }
});

const SERVER_ERROR = { status: 503, body: { error: { code: 503, message: "unavailable", status: "UNAVAILABLE" } } };
const NOT_FOUND = { status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } };

test("a DELETE retried after a server error that then gets 404 counts as deleted (already_absent)", async () => {
  const reply = await runWithResponses("delete_review_reply", { ...LOCATION, review_id: "rev1" }, [SERVER_ERROR, NOT_FOUND]);
  assert.equal(reply.calls.length, 2);
  assert.deepEqual(reply.output.data, { deleted: true, already_absent: true, review_id: "rev1" });
  const post = await runWithResponses("delete_local_post", { ...LOCATION, local_post_id: "p9" }, [SERVER_ERROR, NOT_FOUND]);
  assert.deepEqual(post.output.data, { deleted: true, already_absent: true, local_post_id: "p9" });
});

test("a DELETE that gets 404 on its first attempt is still not_found", async () => {
  await assert.rejects(runWithResponses("delete_local_post", { ...LOCATION, local_post_id: "p9" }, [NOT_FOUND]), (error) => error.kind === "not_found");
});

test("update_location infers a next-day close for overnight hours when close_day is not given", async () => {
  const { calls } = await runWithResponses(
    "update_location",
    {
      location_id: "222",
      regular_hours: [
        { open_day: "SATURDAY", open_time: "22:00", close_time: "02:00" },
        { open_day: "SUNDAY", open_time: "20:00", close_time: "01:30" },
        { open_day: "MONDAY", open_time: "09:00", close_time: "17:00" },
      ],
    },
    [{ body: {} }],
  );
  assert.deepEqual(
    calls[0].json.regularHours.periods.map((period) => [period.openDay, period.closeDay]),
    [["SATURDAY", "SUNDAY"], ["SUNDAY", "MONDAY"], ["MONDAY", "MONDAY"]],
  );
});

test("update_location server failures are retryable because the PATCH is safe to resend", async () => {
  await assert.rejects(runWithResponses("update_location", { location_id: "222", description: "x" }, [SERVER_ERROR]), (error) => {
    assert.equal(error.retryable, true);
    assert.match(error.message, /safe to (retry|resend)/);
    return true;
  });
});
