import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses, rejectsWithKind } from "./helpers.mjs";

const BASE_PATH = "/v26.0";
const TO = "6281234567890";
const ENVELOPE = { messaging_product: "whatsapp", recipient_type: "individual", to: TO };

// Each case: operation + args → expected single request (method, path, a subset of query, and the exact JSON body).
const REQUEST_CASES = [
  ["send_text", { to: "+62 812-3456-7890", body: "halo" }, { method: "POST", path: "/111/messages", json: { ...ENVELOPE, type: "text", text: { body: "halo", preview_url: false } } }],
  [
    "send_text",
    { to: TO, body: "see https://x.test", preview_url: true, reply_to_message_id: "wamid.A" },
    { method: "POST", path: "/111/messages", json: { ...ENVELOPE, type: "text", context: { message_id: "wamid.A" }, text: { body: "see https://x.test", preview_url: true } } },
  ],
  [
    "send_text",
    { to: TO, body: "from another number", phone_number_id: "999" },
    { method: "POST", path: "/999/messages", json: { ...ENVELOPE, type: "text", text: { body: "from another number", preview_url: false } } },
  ],
  [
    "send_template",
    { to: TO, name: "order_update", language: "id", components: [{ type: "body", parameters: [{ type: "text", text: "A1" }] }] },
    {
      method: "POST",
      path: "/111/messages",
      json: { ...ENVELOPE, type: "template", template: { name: "order_update", language: { code: "id" }, components: [{ type: "body", parameters: [{ type: "text", text: "A1" }] }] } },
    },
  ],
  ["send_template", { to: TO, name: "hello_world" }, { method: "POST", path: "/111/messages", json: { ...ENVELOPE, type: "template", template: { name: "hello_world", language: { code: "en_US" } } } }],
  [
    "send_media",
    { to: TO, type: "image", link: "https://img.test/a.jpg", caption: "pic" },
    { method: "POST", path: "/111/messages", json: { ...ENVELOPE, type: "image", image: { link: "https://img.test/a.jpg", caption: "pic" } } },
  ],
  [
    "send_media",
    { to: TO, type: "document", media_id: "m1", caption: "invoice", filename: "inv.pdf" },
    { method: "POST", path: "/111/messages", json: { ...ENVELOPE, type: "document", document: { id: "m1", caption: "invoice", filename: "inv.pdf" } } },
  ],
  ["send_media", { to: TO, type: "sticker", media_id: "s1" }, { method: "POST", path: "/111/messages", json: { ...ENVELOPE, type: "sticker", sticker: { id: "s1" } } }],
  [
    "send_location",
    { to: TO, latitude: -6.2, longitude: 106.8, name: "Monas", address: "Jakarta" },
    { method: "POST", path: "/111/messages", json: { ...ENVELOPE, type: "location", location: { latitude: -6.2, longitude: 106.8, name: "Monas", address: "Jakarta" } } },
  ],
  [
    "send_interactive_buttons",
    { to: TO, body: "Confirm?", buttons: [{ id: "yes", title: "Yes" }, "No"], header_text: "Order", footer: "Shop" },
    {
      method: "POST",
      path: "/111/messages",
      json: {
        ...ENVELOPE,
        type: "interactive",
        interactive: {
          type: "button",
          header: { type: "text", text: "Order" },
          body: { text: "Confirm?" },
          footer: { text: "Shop" },
          action: { buttons: [{ type: "reply", reply: { id: "yes", title: "Yes" } }, { type: "reply", reply: { id: "No", title: "No" } }] },
        },
      },
    },
  ],
  [
    "send_interactive_list",
    { to: TO, body: "Pick one", button_text: "Options", sections: [{ title: "Fast", rows: [{ id: "x", title: "Express", description: "1 day" }] }] },
    {
      method: "POST",
      path: "/111/messages",
      json: {
        ...ENVELOPE,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: "Pick one" },
          action: { button: "Options", sections: [{ title: "Fast", rows: [{ id: "x", title: "Express", description: "1 day" }] }] },
        },
      },
    },
  ],
  ["send_reaction", { to: TO, message_id: "wamid.A", emoji: "👍" }, { method: "POST", path: "/111/messages", json: { ...ENVELOPE, type: "reaction", reaction: { message_id: "wamid.A", emoji: "👍" } } }],
  ["send_reaction", { to: TO, message_id: "wamid.A", remove: true }, { method: "POST", path: "/111/messages", json: { ...ENVELOPE, type: "reaction", reaction: { message_id: "wamid.A", emoji: "" } } }],
  ["mark_as_read", { message_id: "wamid.B" }, { method: "POST", path: "/111/messages", json: { messaging_product: "whatsapp", status: "read", message_id: "wamid.B" } }],
  [
    "mark_as_read",
    { message_id: "wamid.B", show_typing_indicator: true },
    { method: "POST", path: "/111/messages", json: { messaging_product: "whatsapp", status: "read", message_id: "wamid.B", typing_indicator: { type: "text" } } },
  ],
  ["get_media_url", { media_id: "m1" }, { method: "GET", path: "/m1" }],
  ["get_media_url", { media_id: "m1", phone_number_id: "111" }, { method: "GET", path: "/m1", query: { phone_number_id: "111" } }],
  ["delete_media", { media_id: "m1" }, { method: "DELETE", path: "/m1" }],
  [
    "list_templates",
    { status: "APPROVED", limit: 5, cursor: "c1" },
    { method: "GET", path: "/222/message_templates", query: { status: "APPROVED", limit: "5", after: "c1", fields: "id,name,status,category,language,components" } },
  ],
  ["get_template", { template_id: "t1" }, { method: "GET", path: "/t1", query: { fields: "id,name,status,category,language,components" } }],
  [
    "create_template",
    { name: "order_update", category: "UTILITY", language: "en_US", components: [{ type: "BODY", text: "Order shipped" }] },
    { method: "POST", path: "/222/message_templates", json: { name: "order_update", category: "UTILITY", language: "en_US", components: [{ type: "BODY", text: "Order shipped" }] } },
  ],
  [
    "create_template",
    { name: "promo", category: "MARKETING", language: "id", components: [{ type: "BODY", text: "Hi {{name}}" }], parameter_format: "named", allow_category_change: true },
    {
      method: "POST",
      path: "/222/message_templates",
      json: { name: "promo", category: "MARKETING", language: "id", components: [{ type: "BODY", text: "Hi {{name}}" }], parameter_format: "named", allow_category_change: true },
    },
  ],
  ["delete_template", { name: "promo" }, { method: "DELETE", path: "/222/message_templates", query: { name: "promo" } }],
  ["delete_template", { name: "promo", template_id: "t1" }, { method: "DELETE", path: "/222/message_templates", query: { name: "promo", hsm_id: "t1" } }],
  ["list_phone_numbers", {}, { method: "GET", path: "/222/phone_numbers", query: { fields: "id,display_phone_number,verified_name,quality_rating,code_verification_status", limit: "25" } }],
  ["get_business_profile", {}, { method: "GET", path: "/111/whatsapp_business_profile", query: { fields: "about,address,description,email,profile_picture_url,websites,vertical" } }],
  [
    "update_business_profile",
    { about: "We sell plants", websites: ["https://shop.test"], vertical: "RETAIL" },
    { method: "POST", path: "/111/whatsapp_business_profile", json: { messaging_product: "whatsapp", about: "We sell plants", websites: ["https://shop.test"], vertical: "RETAIL" } },
  ],
  ["api_request", { method: "GET", path: "/111", query: { fields: "id" } }, { method: "GET", path: "/111", query: { fields: "id" } }],
];

for (const [operationName, args, expectedRequest] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args, [{ body: { data: [{}] } }]);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(call.path, BASE_PATH + expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer wa-token");
    assert.equal(call.query.access_token, undefined, "the token must stay in the header");
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("list operations return data and next_cursor only when paging.next exists", async () => {
  const withNext = await runWithResponses("list_templates", {}, [{ body: { data: [{ id: "t1" }], paging: { cursors: { after: "A" }, next: "https://graph.facebook.com/next" } } }]);
  assert.deepEqual(withNext.output, { data: [{ id: "t1" }], next_cursor: "A" });
  const lastPage = await runWithResponses("list_phone_numbers", {}, [{ body: { data: [], paging: { cursors: { after: "B" } } } }]);
  assert.deepEqual(lastPage.output, { data: [], next_cursor: null });
});

test("get_business_profile unwraps the single profile from data[]", async () => {
  const { output } = await runWithResponses("get_business_profile", {}, [{ body: { data: [{ about: "Hi", messaging_product: "whatsapp" }] } }]);
  assert.deepEqual(output.data, { about: "Hi", messaging_product: "whatsapp" });
});

test("send operations need WHATSAPP_PHONE_NUMBER_ID or phone_number_id", async () => {
  await rejectsWithKind(assert, runWithResponses("send_text", { to: TO, body: "x" }, undefined, { WHATSAPP_ACCESS_TOKEN: "t" }), "invalid_input", /WHATSAPP_PHONE_NUMBER_ID/);
});

test("template operations need WHATSAPP_BUSINESS_ACCOUNT_ID or business_account_id", async () => {
  await rejectsWithKind(assert, runWithResponses("list_templates", {}, undefined, { WHATSAPP_ACCESS_TOKEN: "t" }), "invalid_input", /WHATSAPP_BUSINESS_ACCOUNT_ID/);
});

const VALIDATION_CASES = [
  ["send_text with a local number", "send_text", { to: "0812345678", body: "x" }, /E\.164/],
  ["send_text over 4096 characters", "send_text", { to: TO, body: "x".repeat(4097) }, /4096/],
  ["send_media with link and media_id", "send_media", { to: TO, type: "image", link: "https://a.test/a.jpg", media_id: "m1" }, /exactly one/],
  ["send_media with neither link nor media_id", "send_media", { to: TO, type: "image" }, /exactly one/],
  ["send_media with an http link", "send_media", { to: TO, type: "image", link: "http://a.test/a.jpg" }, /https/],
  ["send_media caption on audio", "send_media", { to: TO, type: "audio", media_id: "m1", caption: "x" }, /caption/],
  ["send_media filename on an image", "send_media", { to: TO, type: "image", media_id: "m1", filename: "a.jpg" }, /filename/],
  ["send_location latitude out of range", "send_location", { to: TO, latitude: 91, longitude: 0 }, /latitude/],
  ["send_reaction without emoji or remove", "send_reaction", { to: TO, message_id: "wamid.A" }, /emoji/],
  ["send_interactive_buttons with 4 buttons", "send_interactive_buttons", { to: TO, body: "x", buttons: ["a", "b", "c", "d"] }, /at most 3/],
  ["send_interactive_buttons with a long title", "send_interactive_buttons", { to: TO, body: "x", buttons: ["x".repeat(21)] }, /20 characters/],
  ["send_interactive_buttons with duplicate ids", "send_interactive_buttons", { to: TO, body: "x", buttons: [{ id: "a", title: "Yes" }, { id: "a", title: "No" }] }, /ids must be unique/],
  ["send_interactive_buttons with a string id equal to another id", "send_interactive_buttons", { to: TO, body: "x", buttons: ["Yes", { id: "Yes", title: "Sure" }] }, /ids must be unique/],
  ["send_interactive_buttons with duplicate titles", "send_interactive_buttons", { to: TO, body: "x", buttons: ["Yes", { id: "y2", title: "Yes" }] }, /unique/],
  ["send_interactive_buttons body over 1024", "send_interactive_buttons", { to: TO, body: "x".repeat(1025), buttons: ["a"] }, /1024/],
  ["send_interactive_list with 11 rows", "send_interactive_list", { to: TO, body: "x", button_text: "Go", sections: [{ title: "s", rows: Array.from({ length: 11 }, (_, index) => ({ id: `r${index}`, title: "t" })) }] }, /10 rows/],
  ["send_interactive_list without rows", "send_interactive_list", { to: TO, body: "x", button_text: "Go", sections: [{ title: "s", rows: [] }] }, /at least one row/],
  ["send_interactive_list two sections without titles", "send_interactive_list", { to: TO, body: "x", button_text: "Go", sections: [{ rows: [{ id: "a", title: "a" }] }, { rows: [{ id: "b", title: "b" }] }] }, /title/],
  ["send_interactive_list long row title", "send_interactive_list", { to: TO, body: "x", button_text: "Go", sections: [{ rows: [{ id: "a", title: "x".repeat(25) }] }] }, /24 characters/],
  ["send_interactive_list long button text", "send_interactive_list", { to: TO, body: "x", button_text: "x".repeat(21), sections: [{ rows: [{ id: "a", title: "a" }] }] }, /20 characters/],
  ["create_template with an invalid name", "create_template", { name: "Order Update", category: "UTILITY", language: "en_US", components: [{ type: "BODY", text: "x" }] }, /lowercase/],
  ["update_business_profile with nothing to change", "update_business_profile", {}, /at least one/],
  ["update_business_profile with 3 websites", "update_business_profile", { websites: ["https://a.test", "https://b.test", "https://c.test"] }, /at most 2/],
  ["update_business_profile with a website without scheme", "update_business_profile", { websites: ["shop.test"] }, /http/],
  ["update_business_profile about over 139", "update_business_profile", { about: "x".repeat(140) }, /139/],
];

for (const [caseName, operationName, args, messagePattern] of VALIDATION_CASES) {
  test(`${caseName} is rejected as invalid_input before any request`, async () => {
    await rejectsWithKind(assert, runWithResponses(operationName, args, []), "invalid_input", messagePattern);
  });
}
