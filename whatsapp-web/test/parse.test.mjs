import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDesktopUserAgent,
  classifyLaunchError,
  isUnsupportedBrowserPage,
  determineLoginStatus,
  findMismatchedChatId,
  findNewOutgoingMessage,
  isSameEditableText,
  matchesSentContent,
  mergeRawChatRows,
  normalizePhoneNumber,
  parseChatRows,
  parseSearchRows,
  parseDeliveryStatus,
  parseMessageDataId,
  parseMessageRows,
  parsePrePlainText,
} from "../lib/parse.mjs";

test("normalizePhoneNumber strips formatting and keeps international digits", () => {
  assert.equal(normalizePhoneNumber("+62 812-3456-789"), "628123456789");
  assert.equal(normalizePhoneNumber("(+1) 415 555 0100"), "14155550100");
  assert.equal(normalizePhoneNumber("0062 812 3456 789"), "628123456789", "00 is the international prefix");
});

for (const badNumber of ["0812", "abc", "+62 812 3456 7890 1234", "62x8123456789", "00012345678", "+0812345678"]) {
  test(`normalizePhoneNumber rejects ${JSON.stringify(badNumber)}`, () => {
    assert.throws(() => normalizePhoneNumber(badNumber), { kind: "invalid_input" });
  });
}

for (const numberWithoutCountryCode of ["08123456789", "628123456789", "812 3456 789"]) {
  test(`normalizePhoneNumber refuses ${JSON.stringify(numberWithoutCountryCode)} without + or 00 (it could be read as another country)`, () => {
    assert.throws(
      () => normalizePhoneNumber(numberWithoutCountryCode),
      (error) => error.kind === "invalid_input" && /country code/.test(error.message) && /\+62/.test(error.message),
    );
  });
}

const MESSAGE_ID_CASES = [
  ["true_628123456789@c.us_3EB0C0F8A4D1", { from_me: true, chat_id: "628123456789@c.us", id: "3EB0C0F8A4D1", participant: null }],
  ["false_120363012345@g.us_3A9F2B_628111222333@c.us", { from_me: false, chat_id: "120363012345@g.us", id: "3A9F2B", participant: "628111222333@c.us" }],
  ["false_98765432101234@lid_ABCDEF", { from_me: false, chat_id: "98765432101234@lid", id: "ABCDEF", participant: null }],
];
for (const [dataId, expected] of MESSAGE_ID_CASES) {
  test(`parseMessageDataId ${dataId}`, () => assert.deepEqual(parseMessageDataId(dataId), expected));
}

test("parseMessageDataId returns null for unrelated ids", () => {
  assert.equal(parseMessageDataId("album-123"), null);
  assert.equal(parseMessageDataId(""), null);
});

test("parsePrePlainText reads time and sender", () => {
  assert.deepEqual(parsePrePlainText("[10:42, 18/11/2026] Alice Smith: "), { time: "10:42, 18/11/2026", sender: "Alice Smith" });
  assert.deepEqual(parsePrePlainText("[9:05 PM, 11/18/2026] +62 812-3456-789: "), { time: "9:05 PM, 11/18/2026", sender: "+62 812-3456-789" });
  assert.deepEqual(parsePrePlainText("[10:42, 18/11/2026] Dr: Who: "), { time: "10:42, 18/11/2026", sender: "Dr: Who" });
  assert.deepEqual(parsePrePlainText(null), { time: null, sender: null });
});

test("parseMessageRows builds messages, drops unknown rows, dedupes and keeps the last N", () => {
  const rawRows = [
    { dataId: "false_6281@c.us_A1", prePlainText: "[10:00, 18/11/2026] Budi: ", text: "halo", iconNames: [], iconLabels: [] },
    { dataId: "true_6281@c.us_A2", prePlainText: "[10:01, 18/11/2026] Me: ", text: "hai juga", iconNames: ["msg-dblcheck"], iconLabels: [" Read "] },
    { dataId: "true_6281@c.us_A2", prePlainText: "[10:01, 18/11/2026] Me: ", text: "hai juga", iconNames: [], iconLabels: [] },
    { dataId: "not-a-message", prePlainText: null, text: "x", iconNames: [], iconLabels: [] },
    { dataId: "false_6281@c.us_A3", prePlainText: null, text: "", iconNames: ["media-play"], iconLabels: [] },
  ];
  const messages = parseMessageRows(rawRows, 2);
  assert.deepEqual(messages, [
    { id: "A2", from_me: true, sender: "Me", time: "10:01, 18/11/2026", text: "hai juga", status: "read", chat_id: "6281@c.us", participant: null },
    { id: "A3", from_me: false, sender: null, time: null, text: null, status: null, chat_id: "6281@c.us", participant: null },
  ]);
});

const DELIVERY_CASES = [
  [["msg-time"], [], "pending"],
  [["status-time"], [], "pending"],
  [["msg-check"], [" Sent "], "sent"],
  [["msg-dblcheck"], [" Delivered "], "delivered"],
  [["msg-dblcheck"], [" Read "], "read"],
  [["tail-out"], [], null],
];
for (const [iconNames, iconLabels, expected] of DELIVERY_CASES) {
  test(`parseDeliveryStatus ${iconNames} ${iconLabels} → ${expected}`, () => assert.equal(parseDeliveryStatus(iconNames, iconLabels), expected));
}

test("parseChatRows reads name, time, preview and unread count, ordered by position", () => {
  const rawRows = [
    { top: 72, title: "Ibu", text: "Ibu\nYesterday\nJangan lupa makan\n2", unreadLabel: "2 unread messages" },
    { top: 0, title: "Kantor Group", text: "Kantor Group\n10:42\n~ Andi: meeting jam 3", unreadLabel: null },
    { top: 144, title: "", text: "", unreadLabel: null },
  ];
  assert.deepEqual(parseChatRows(rawRows), [
    { name: "Kantor Group", time: "10:42", last_message: "~ Andi: meeting jam 3", unread_count: 0 },
    { name: "Ibu", time: "Yesterday", last_message: "Jangan lupa makan", unread_count: 2 },
  ]);
});

test("parseChatRows counts a chat marked as unread (badge without a number) as 1 unread", () => {
  const [chat] = parseChatRows([{ top: 0, title: "Budi", text: "Budi\n09:00\nok", unreadLabel: "Unread" }]);
  assert.equal(chat.unread_count, 1);
  assert.equal(chat.last_message, "ok");
});

test("mergeRawChatRows keeps rows already seen once, by list position, and keeps two chats with the same name", () => {
  const firstBatch = [{ top: 0, title: "A" }, { top: 72, title: "Budi" }];
  const merged = mergeRawChatRows(firstBatch, [{ top: 72, title: "Budi" }, { top: 144, title: "Budi" }, { top: 216, title: "C" }]);
  assert.deepEqual(merged.map((row) => [row.top, row.title]), [[0, "A"], [72, "Budi"], [144, "Budi"], [216, "C"]]);
});

const LOGIN_STATUS_CASES = [
  [{ hasChatList: true, hasQrCode: false }, "logged_in"],
  [{ hasChatList: true, hasQrCode: true }, "logged_in"],
  [{ hasChatList: false, hasQrCode: true }, "needs_login"],
  [{ hasChatList: false, hasQrCode: false }, "loading"],
  [null, "loading"],
];
for (const [signals, expected] of LOGIN_STATUS_CASES) {
  test(`determineLoginStatus ${JSON.stringify(signals)} → ${expected}`, () => assert.equal(determineLoginStatus(signals), expected));
}

test("findNewOutgoingMessage ignores known and incoming messages", () => {
  const rawRows = [
    { dataId: "true_6281@c.us_OLD", prePlainText: null, text: "new", iconNames: ["msg-dblcheck"], iconLabels: [] },
    { dataId: "false_6281@c.us_IN", prePlainText: null, text: "new", iconNames: [], iconLabels: [] },
    { dataId: "true_6281@c.us_NEW", prePlainText: null, text: "new", iconNames: ["msg-time"], iconLabels: [] },
  ];
  assert.equal(findNewOutgoingMessage(rawRows, new Set(["OLD"]), { text: "new" }).id, "NEW");
  assert.equal(findNewOutgoingMessage(rawRows, new Set(["OLD"]), { text: "new" }).status, "pending");
  assert.equal(findNewOutgoingMessage(rawRows, new Set(["OLD", "NEW"]), { text: "new" }), null);
});

test("findNewOutgoingMessage only confirms a new outgoing message with the sent text", () => {
  const rawRows = [
    { dataId: "true_6281@c.us_OTHER", prePlainText: null, text: "sent from the phone meanwhile", iconNames: ["msg-check"], iconLabels: [] },
  ];
  assert.equal(findNewOutgoingMessage(rawRows, new Set(), { text: "halo" }), null);
});

const SENT_CONTENT_CASES = [
  [{ text: "a\nb" }, "a\nb", true],
  [{ text: "  halo   dunia \n" }, "halo dunia", true],
  [{ text: "*bold* and _it_ 😀" }, "bold and it ", true],
  [{ text: "halo" }, "halo!", false],
  [{ text: "halo" }, null, false],
  [{ text: `${"long message ".repeat(20)}end` }, `${"long message ".repeat(10)}... Read more`, true],
  [{ text: "short" }, "sho... Read more", false],
  [{ caption: "lihat", fileName: "p.png" }, "lihat", true],
  [{ caption: "lihat", fileName: "p.png" }, null, false],
  [{ caption: "", fileName: "invoice.pdf" }, null, true],
  [{ caption: "", fileName: "invoice.pdf" }, "invoice.pdf 2 pages", true],
  [{ caption: "", fileName: "invoice.pdf" }, "some other text", false],
];
for (const [expectedContent, bubbleText, expected] of SENT_CONTENT_CASES) {
  test(`matchesSentContent ${JSON.stringify(expectedContent).slice(0, 50)} vs ${JSON.stringify(bubbleText)?.slice(0, 40)} → ${expected}`, () =>
    assert.equal(matchesSentContent({ text: bubbleText }, expectedContent), expected));
}

const EDITABLE_TEXT_CASES = [
  ["halo", "halo", true],
  ["a\nb", "a\n\nb", true],
  ["halo", "\u00a0halo\u200b ", true],
  ["halo", "draft from yesterday halo", false],
  ["halo", "", false],
  ["halo", null, false],
  ["", "", true],
  ["", "leftover", false],
];
for (const [intendedText, composerText, expected] of EDITABLE_TEXT_CASES) {
  test(`isSameEditableText ${JSON.stringify(intendedText)} vs composer ${JSON.stringify(composerText)} → ${expected}`, () =>
    assert.equal(isSameEditableText(composerText, intendedText), expected));
}

test("findMismatchedChatId returns the first message whose chat is not the phone number", () => {
  const row = (dataId) => ({ dataId, prePlainText: null, text: "x", iconNames: [], iconLabels: [] });
  assert.equal(findMismatchedChatId([row("false_628123456789@c.us_A"), row("true_628123456789@c.us_B")], "628123456789"), null);
  assert.equal(findMismatchedChatId([], "628123456789"), null);
  assert.equal(findMismatchedChatId([row("false_6281234567890@c.us_A")], "628123456789"), "6281234567890@c.us");
  assert.equal(findMismatchedChatId([row("false_98765432101234@lid_A")], "628123456789"), "98765432101234@lid");
});

test("buildDesktopUserAgent drops the Headless marker and matches the platform", () => {
  assert.equal(
    buildDesktopUserAgent("159.0.8154.6", "darwin"),
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.8154.6 Safari/537.36",
  );
  assert.match(buildDesktopUserAgent("159.0.1.2", "linux"), /X11; Linux x86_64.*Chrome\/159\.0\.1\.2/);
  assert.doesNotMatch(buildDesktopUserAgent("159.0.1.2", "win32"), /Headless/);
});

test("isUnsupportedBrowserPage recognises WhatsApp's update-your-browser page", () => {
  assert.equal(isUnsupportedBrowserPage("WhatsApp works with Google Chrome 100+\nTo use WhatsApp, update Chrome"), true);
  assert.equal(isUnsupportedBrowserPage("Scan to log in"), false);
  assert.equal(isUnsupportedBrowserPage(null), false);
});

test("classifyLaunchError maps a missing browser to setup_required", () => {
  const error = classifyLaunchError(new Error("browserType.launchPersistentContext: Executable doesn't exist at /x/chrome"));
  assert.equal(error.kind, "setup_required");
  assert.match(error.message, /playwright install chromium/);
});

test("classifyLaunchError explains a locked profile", () => {
  const error = classifyLaunchError(new Error("Failed to create a ProcessSingleton for your profile directory"));
  assert.equal(error.kind, "browser_error");
  assert.match(error.message, /profile .*in use/i);
});

test("classifyLaunchError keeps other failures as browser_error", () => {
  const error = classifyLaunchError(new Error("boom"));
  assert.equal(error.kind, "browser_error");
  assert.match(error.message, /boom/);
});

const SEARCH_RESULT_ROWS = [
  { top: 0, title: "", text: "CHATS", unreadLabel: null },
  { top: 40, title: "Budi", text: "Budi\n10:00\nhalo", unreadLabel: null },
  { top: 112, title: "", text: "CONTACTS", unreadLabel: null },
  { top: 152, title: "Budi Santoso", text: "Budi Santoso\nHey there! I am using WhatsApp.", unreadLabel: null },
  { top: 224, title: "", text: "MESSAGES", unreadLabel: null },
  { top: 264, title: "Kantor Group", text: "Kantor Group\n09:00\nbudi sudah datang", unreadLabel: null },
];

test("parseSearchRows drops section headers and message hits and tags each row's kind", () => {
  assert.deepEqual(
    parseSearchRows(SEARCH_RESULT_ROWS).map((row) => [row.kind, row.name]),
    [["chat", "Budi"], ["contact", "Budi Santoso"]],
  );
});

test("parseSearchRows reads Indonesian section headers", () => {
  const rawRows = [
    { top: 0, title: "", text: "Obrolan", unreadLabel: null },
    { top: 40, title: "Ibu", text: "Ibu\n10:00\nmakan", unreadLabel: null },
    { top: 112, title: "", text: "Pesan", unreadLabel: null },
    { top: 152, title: "Ibu", text: "Ibu\n08:00\nmakan siang", unreadLabel: null },
  ];
  assert.deepEqual(parseSearchRows(rawRows).map((row) => [row.kind, row.last_message]), [["chat", "makan"]]);
});

test("parseSearchRows treats rows without any header as chats", () => {
  const [chat] = parseSearchRows([{ top: 0, title: "Budi", text: "Budi\n10:00\nhalo", unreadLabel: null }]);
  assert.deepEqual(chat, { name: "Budi", time: "10:00", last_message: "halo", unread_count: 0, kind: "chat" });
});
