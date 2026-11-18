// Types text into the focused element of an app. Input: {app, text, method, require_focus?}.
//   keystroke: System Events keystrokes in 200-character chunks, with a frontmost check before each.
//   insert:    sets AXSelectedText on the focused element (no keys, no clipboard), then reads it back.
//   paste:     puts the text on the clipboard, presses Cmd+V, reads the element back to confirm the
//              text arrived, and only then restores every item and type that was on the clipboard.
// Node normalises \r\n to \n before the text gets here.
var KEYSTROKE_CHUNK_LENGTH = 200;
var BETWEEN_CHUNKS_SECONDS = 0.05;
var PASTE_CONFIRM_SECONDS = 1.5;
var PASTE_STEP = { label: "cmd+v", character: "v", modifiers: ["command down"] };

/** Splits text into chunks of `chunkLength` code points (never inside a surrogate pair). */
function splitIntoChunks(text, chunkLength) {
  var characters = Array.from(text);
  var chunks = [];
  for (var start = 0; start < characters.length; start += chunkLength) chunks.push(characters.slice(start, start + chunkLength).join(""));
  return chunks;
}

function countOccurrences(haystack, needle) {
  if (haystack === null || !needle) return 0;
  var count = 0;
  for (var from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + needle.length)) count += 1;
  return count;
}

function countInElement(element, text) {
  var value = readFullText(element, "AXValue");
  return countOccurrences(value === null ? null : value.replace(/\r\n?/g, "\n"), text);
}

function typeByKeystrokes(target, text) {
  splitIntoChunks(text, KEYSTROKE_CHUNK_LENGTH).forEach(function (chunk) {
    assertFrontmost(target.pid, target.name);
    keystrokeText(chunk);
    delay(BETWEEN_CHUNKS_SECONDS);
  });
}

// AX writes go to this app's element directly, so they cannot land in another app.
function insertIntoFocusedElement(target, text) {
  var element = focusedElementOf(target.appElement);
  if (!isAttributeSettable(element, "AXSelectedText")) {
    fail("action_failed", "The focused element of " + target.name + " does not accept inserted text; use method keystroke or paste");
  }
  var countBefore = countInElement(element, text);
  var status = setAttributeValue(element, "AXSelectedText", $(text));
  if (status !== AX_SUCCESS) fail("action_failed", "Could not insert text into the focused element of " + target.name + " (AX error " + status + ")");
  if (countInElement(element, text) <= countBefore) {
    fail("action_failed", "Inserted text did not appear in the focused element of " + target.name + "; use method keystroke or paste");
  }
}

function pasteIntoFocusedElement(target, text) {
  var element = focusedElementOf(target.appElement);
  var countBefore = countInElement(element, text);
  var savedPasteboard = snapshotPasteboard();
  try {
    writeClipboardText(text);
    if (readClipboardText() !== text) fail("action_failed", "Could not put the text on the clipboard; nothing was pasted");
    assertFrontmost(target.pid, target.name);
    pressKeyStep(PASTE_STEP);
    var isConfirmed = waitUntil(function () { return countInElement(element, text) > countBefore; }, PASTE_CONFIRM_SECONDS);
    if (!isConfirmed) {
      fail("action_failed", "Could not confirm the pasted text in the focused element of " + target.name +
        " (it may not expose its text); the clipboard was restored, check the field before retrying");
    }
  } finally {
    restorePasteboard(savedPasteboard);
  }
}

var TEXT_METHODS = { keystroke: typeByKeystrokes, insert: insertIntoFocusedElement, paste: pasteIntoFocusedElement };

function main(input) {
  var typeText = TEXT_METHODS[input.method];
  if (!typeText) fail("invalid_input", "Unknown typing method \"" + input.method + "\"");
  var runningApp = findRunningApp(input.app);
  var target = { pid: runningApp.processIdentifier, name: appNameOf(runningApp), appElement: appElementFor(runningApp) };
  activateApp(runningApp);
  if (input.require_focus) assertFocusedElementMatches(target.appElement, input.require_focus);
  typeText(target, input.text);
  return { app: target.name, characters: input.text.length, method: input.method };
}
