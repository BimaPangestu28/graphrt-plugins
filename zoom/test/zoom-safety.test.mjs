import { test } from "node:test";
import assert from "node:assert/strict";
import { isZoomToolReadPath, prepareMeetingUuid, stripBearerFields } from "../lib/zoom-tool-safety.mjs";

test("stripBearerFields removes start links, recording links and passcodes at any depth", () => {
  const meeting = {
    id: 1,
    join_url: "https://zoom.us/j/1?pwd=abc",
    start_url: "https://zoom.us/s/1?zak=secret",
    password: "123",
    encrypted_password: "abc",
    h323_password: "1",
    pstn_password: "2",
    settings: { host_video: true },
    recording_files: [{ id: "f1", file_type: "MP4", download_url: "https://zoom.us/rec/download/x", play_url: "https://zoom.us/rec/play/x" }],
    recording_play_passcode: "p",
    download_access_token: "jwt",
    share_url: "https://zoom.us/rec/share/x",
  };
  assert.deepEqual(stripBearerFields(meeting), { id: 1, join_url: "https://zoom.us/j/1?pwd=abc", settings: { host_video: true }, recording_files: [{ id: "f1", file_type: "MP4" }] });
  assert.deepEqual(stripBearerFields([{ meetings: [{ start_url: "x", topic: "t" }] }]), [{ meetings: [{ topic: "t" }] }]);
  assert.equal(stripBearerFields(null), null);
  assert.equal(stripBearerFields("text"), "text");
});

test("isZoomToolReadPath allows listed reads and refuses token, settings and unknown paths", () => {
  for (const allowed of ["/users", "/users/me", "/users/me/meetings", "/meetings/123/recordings", "/past_meetings/%252Fab%3D%3D/participants", "/report/users/me/meetings?from=2026-01-01", "/meetings/1/", "/Users/me"]) {
    assert.equal(isZoomToolReadPath(allowed), true, allowed);
  }
  for (const refused of ["/users/me/token", "/users/me/token?type=zak", "/users/me/settings", "/accounts/1", "/webhooks", "/users/me/meetings/../token", "/meetings/1/invitation", "/users/me.json/token", "//users", "/users/me\\token"]) {
    assert.equal(isZoomToolReadPath(refused), false, refused);
  }
});

test("isZoomToolReadPath decodes before matching and refuses encoded slashes, backslashes and bad encodings", () => {
  for (const refused of ["/users/me%2Ftoken", "/users/me%2ftoken", "/users/me%2fzak", "/users/me%5Ctoken", "/users/%6De/token", "/users/me%252Ftoken", "/users/me%25252Ftoken", "/users/me%E0%A4%A", "/meetings/%252E%252E/registrants", "/meetings/1/registrants", "/users/%2E%2E/token"]) {
    assert.equal(isZoomToolReadPath(refused), false, refused);
  }
  for (const allowed of ["/past_meetings/%252Fab%3D%3D/participants", "/meetings/%252F%252Fab%3D%3D/recordings", "/users/ada%40example.com/meetings"]) {
    assert.equal(isZoomToolReadPath(allowed), true, allowed);
  }
});

test("stripBearerFields also removes token fields (e.g. a ZAK reached through another read)", () => {
  assert.deepEqual(stripBearerFields({ token: "zak-secret", nested: [{ token: "x", topic: "t" }] }), { nested: [{ topic: "t" }] });
});

test("prepareMeetingUuid pre-encodes UUIDs Zoom wants double-encoded, and leaves others alone", () => {
  assert.equal(prepareMeetingUuid("/ajXp112QmuoKj4854875=="), "%2FajXp112QmuoKj4854875%3D%3D");
  assert.equal(prepareMeetingUuid("ab//cd=="), "ab%2F%2Fcd%3D%3D");
  assert.equal(prepareMeetingUuid("4444AAAiAAAAAiAiAiiAii=="), "4444AAAiAAAAAiAiAiiAii==");
  assert.equal(prepareMeetingUuid(85746065432), 85746065432);
  assert.equal(prepareMeetingUuid(undefined), undefined);
});
