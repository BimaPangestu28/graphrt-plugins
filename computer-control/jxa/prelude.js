// Shared JXA helpers, prepended to every script in this directory by lib/jxa-runner.mjs.
//
// Contract: each script defines `main(input)` and returns a JSON-serialisable value.
// The input arrives as JSON on stdin and is never part of the script source.
// `run()` prints `{"ok":true,"result":...}` or `{"ok":false,"error":{kind,message,number}}`.
// Known failure kinds: not_found, stale_ref, invalid_input, permission_denied, accessibility_denied, action_failed.
//
// Side effects go through small helpers (frontmostProcessIdentifier, keystrokeText, pressKeyStep,
// postMouseClick, processIdentifierAtPoint, snapshotPasteboard…) so test/jxa-harness.mjs can fake them.
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

var AX_SUCCESS = 0;
var MAX_TEXT_LENGTH = 200;
var REGULAR_ACTIVATION_POLICY = 0;
var REF_FINGERPRINT_SEPARATOR = "#";
var FRAME_TOLERANCE = 2;
var ELEMENT_ATTRIBUTES = [
  "AXRole", "AXSubrole", "AXTitle", "AXValue", "AXDescription", "AXPlaceholderValue",
  "AXEnabled", "AXFocused", "AXPosition", "AXSize", "AXChildren",
];

function ScriptFailure(kind, message) {
  this.kind = kind;
  this.message = message;
}

function fail(kind, message) {
  throw new ScriptFailure(kind, message);
}

function readInput() {
  var inputData = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var inputText = $.NSString.alloc.initWithDataEncoding(inputData, $.NSUTF8StringEncoding).js;
  return inputText ? JSON.parse(inputText) : {};
}

function describeFailure(error) {
  if (error instanceof ScriptFailure) return { kind: error.kind, message: error.message };
  var message = error && error.message ? error.message : String(error);
  return { kind: "script_error", message: message, number: error && error.errorNumber };
}

function run() {
  try {
    return JSON.stringify({ ok: true, result: main(readInput()) });
  } catch (error) {
    return JSON.stringify({ ok: false, error: describeFailure(error) });
  }
}

function waitUntil(predicate, timeoutSeconds) {
  var deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    delay(0.05);
  }
  return predicate();
}

// ---------- apps ----------

function listRunningApps() {
  return $.NSWorkspace.sharedWorkspace.runningApplications.js;
}

function objcTextOf(objcValue) {
  return isMissing(objcValue) ? "" : objcValue.js;
}

function appNameOf(runningApp) {
  return objcTextOf(runningApp.localizedName);
}

function bundleIdentifierOf(runningApp) {
  return objcTextOf(runningApp.bundleIdentifier);
}

// Regular apps have a Dock icon; agents and helpers (accessory/prohibited policy) are never targets.
function isRegularApp(runningApp) {
  return Number(runningApp.activationPolicy) === REGULAR_ACTIVATION_POLICY;
}

/**
 * Same rule as normalizeAppKey in lib/allowlist.mjs: NFC, ASCII-only lower-casing, and no key (null)
 * for names holding characters NFC rewrites on their own, such as the Kelvin sign.
 */
function normalizeAppKey(appName) {
  var trimmedName = String(appName === null || appName === undefined ? "" : appName).trim();
  var characters = Array.from(trimmedName);
  for (var index = 0; index < characters.length; index++) {
    if (characters[index].normalize("NFC") !== characters[index]) return null;
  }
  return trimmedName.normalize("NFC").replace(/[A-Z]/g, function (letter) { return letter.toLowerCase(); });
}

function matchesAppKey(runningApp, wantedKey) {
  return normalizeAppKey(appNameOf(runningApp)) === wantedKey || normalizeAppKey(bundleIdentifierOf(runningApp)) === wantedKey;
}

function describeApp(runningApp) {
  return appNameOf(runningApp) + " (" + (bundleIdentifierOf(runningApp) || "no bundle id") + ", pid " + runningApp.processIdentifier + ")";
}

/** Finds the one running regular app whose name or bundle id matches; fails when none or several match. */
function findRunningApp(appName) {
  var wantedKey = normalizeAppKey(appName);
  var matches = wantedKey === null ? [] : listRunningApps().filter(function (runningApp) {
    return isRegularApp(runningApp) && matchesAppKey(runningApp, wantedKey);
  });
  if (matches.length === 0) fail("not_found", "App \"" + appName + "\" is not running; start it with open_app");
  if (matches.length > 1) {
    fail("invalid_input", "Several running apps match \"" + appName + "\": " + matches.map(describeApp).join(", ") +
      "; pass the bundle id instead (and allow it in COMPUTER_CONTROL_ALLOWED_APPS)");
  }
  return matches[0];
}

function frontmostBundleIdentifier() {
  var frontmostApp = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return isMissing(frontmostApp) || isMissing(frontmostApp.bundleIdentifier) ? "" : frontmostApp.bundleIdentifier.js;
}

// While the screen is locked the login window is frontmost and macOS blocks synthetic input.
function assertScreenUnlocked() {
  if (frontmostBundleIdentifier() === "com.apple.loginwindow") {
    fail("screen_locked", "The screen is locked (the login window is frontmost); macOS blocks input to apps until it is unlocked");
  }
}

function frontmostProcessIdentifier() {
  var frontmostApp = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return isMissing(frontmostApp) ? -1 : Number(frontmostApp.processIdentifier);
}

/**
 * Every input script calls this right before each key step, text chunk and click: input must never
 * reach another app because the user (or a dialog) took focus while the script was running.
 */
function assertFrontmost(processIdentifier, appName) {
  if (frontmostProcessIdentifier() !== processIdentifier) {
    fail("permission_denied", "focus left " + appName + " (another app is now frontmost); stopped before sending more input");
  }
}

var systemEventsApp = null;

function systemEvents() {
  if (systemEventsApp === null) systemEventsApp = Application("System Events");
  return systemEventsApp;
}

// System Events is more reliable than NSRunningApplication.activate for background callers.
function activateApp(runningApp) {
  assertScreenUnlocked();
  var processes = systemEvents().processes.whose({ unixId: runningApp.processIdentifier });
  if (processes.length === 0) fail("not_found", "App \"" + appNameOf(runningApp) + "\" has no process");
  processes[0].frontmost = true;
  var isFrontmost = waitUntil(function () {
    return frontmostProcessIdentifier() === runningApp.processIdentifier;
  }, 2);
  if (!isFrontmost) fail("action_failed", "Could not bring \"" + appNameOf(runningApp) + "\" to the front");
}

// ---------- accessibility ----------

function requireAccessibility() {
  if (!$.AXIsProcessTrusted()) fail("accessibility_denied", "Accessibility permission is not granted");
}

function appElementFor(runningApp) {
  requireAccessibility();
  return $.AXUIElementCreateApplication(runningApp.processIdentifier);
}

function copyAttribute(element, attributeName) {
  var valueRef = Ref();
  var status = $.AXUIElementCopyAttributeValue(element, $(attributeName), valueRef);
  if (status !== AX_SUCCESS) return null;
  return ObjC.castRefToObject(valueRef[0]);
}

function setAttributeValue(element, attributeName, objcValue) {
  return $.AXUIElementSetAttributeValue(element, $(attributeName), objcValue);
}

function isAttributeSettable(element, attributeName) {
  var settableRef = Ref();
  var status = $.AXUIElementIsAttributeSettable(element, $(attributeName), settableRef);
  return status === AX_SUCCESS && settableRef[0] === true;
}

function performElementAction(element, actionName) {
  return $.AXUIElementPerformAction(element, $(actionName));
}

function isMissing(objcValue) {
  return objcValue === undefined || objcValue === null || (objcValue.isNil && objcValue.isNil());
}

function truncateText(text) {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + "…" : text;
}

// AXValue structs are read from their description; AXValueGetValue crashes through the bridge.
function parseAxStruct(description) {
  var point = /x:(-?[\d.]+) y:(-?[\d.]+)/.exec(description);
  if (point && description.indexOf("CGPoint") !== -1) return [Math.round(Number(point[1])), Math.round(Number(point[2]))];
  var size = /w:(-?[\d.]+) h:(-?[\d.]+)/.exec(description);
  if (size && description.indexOf("CGSize") !== -1) return [Math.round(Number(size[1])), Math.round(Number(size[2]))];
  return null;
}

function toJsValue(objcValue) {
  if (isMissing(objcValue)) return null;
  if (objcValue.isKindOfClass($.NSString)) return truncateText(objcValue.js);
  if (objcValue.isKindOfClass($.NSAttributedString)) return truncateText(objcValue.string.js);
  if (objcValue.isKindOfClass($.NSNumber)) {
    return objcValue.className.js === "__NSCFBoolean" ? objcValue.boolValue : objcValue.doubleValue;
  }
  if (objcValue.isKindOfClass($.NSArray)) return null;
  return parseAxStruct(objcValue.description.js);
}

/** Reads a text attribute in full (no truncation), for confirming typed text. Null when unreadable. */
function readFullText(element, attributeName) {
  var objcValue = copyAttribute(element, attributeName);
  if (isMissing(objcValue)) return null;
  if (objcValue.isKindOfClass($.NSString)) return objcValue.js;
  if (objcValue.isKindOfClass($.NSAttributedString)) return objcValue.string.js;
  return null;
}

function nonEmptyText(value) {
  if (value === null || value === undefined) return null;
  var text = String(value);
  return text.trim() === "" ? null : text;
}

/**
 * Hash (FNV-1a, 7 base-36 characters) of what identifies an element to a reader: role, subrole, title,
 * description, placeholder, and the value of static text. Focus, position and editable values are left
 * out, so the fingerprint survives typing and scrolling but not a different element taking the path.
 */
function elementFingerprint(record) {
  var parts = [record.role, record.subrole, record.title, record.description, record.placeholder, record.role === "AXStaticText" ? record.value : null];
  var identity = parts.map(function (part) { return part === null || part === undefined ? "" : String(part); }).join("\u0001");
  var hash = 0x811c9dc5;
  for (var index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ("000000" + hash.toString(36)).slice(-7);
}

/** Builds an element record from converted attribute values (ELEMENT_ATTRIBUTES order, children excluded). */
function buildElementRecord(path, depth, values) {
  var valueAt = function (index) { return values[index] === undefined ? null : values[index]; };
  var rawValue = valueAt(3);
  var record = {
    ref: path,
    depth: depth,
    role: valueAt(0) || "AXUnknown",
    subrole: nonEmptyText(valueAt(1)),
    title: nonEmptyText(valueAt(2)),
    value: rawValue === null || typeof rawValue === "object" ? null : rawValue,
    description: nonEmptyText(valueAt(4)),
    placeholder: nonEmptyText(valueAt(5)),
    enabled: valueAt(6) === false ? false : true,
    focused: valueAt(7) === true,
    position: valueAt(8),
    size: valueAt(9),
  };
  record.ref = path + REF_FINGERPRINT_SEPARATOR + elementFingerprint(record);
  return record;
}

function readElement(element, path, depth) {
  var valuesRef = Ref();
  var status = $.AXUIElementCopyMultipleAttributeValues(element, $(ELEMENT_ATTRIBUTES), 0, valuesRef);
  if (status !== AX_SUCCESS) {
    var unreadableRecord = buildElementRecord(path, depth, []);
    unreadableRecord.error = status;
    return { record: unreadableRecord, children: null };
  }
  var values = ObjC.castRefToObject(valuesRef[0]);
  var convertedValues = [];
  for (var index = 0; index < ELEMENT_ATTRIBUTES.length - 1; index++) convertedValues.push(toJsValue(values.objectAtIndex(index)));
  var childList = values.objectAtIndex(ELEMENT_ATTRIBUTES.length - 1);
  var children = !isMissing(childList) && childList.isKindOfClass($.NSArray) ? childList : null;
  return { record: buildElementRecord(path, depth, convertedValues), children: children };
}

function readElementRecord(element, path) {
  return readElement(element, path, 0).record;
}

function describeRecord(record) {
  var label = record.title || record.description || nonEmptyText(record.value) || record.placeholder;
  return String(record.role).replace(/^AX/, "") + (label ? " \"" + truncateText(String(label)) + "\"" : "");
}

function hasText(record) {
  return Boolean(record.title || record.description || record.placeholder || nonEmptyText(record.value));
}

/**
 * Depth-first walk. `visit(record)` returns false to stop. Stops after `maxVisited` elements.
 * Returns `{visited, stoppedEarly, depthLimited}`.
 */
function walkTree(rootElement, rootPath, options, visit) {
  var state = { visited: 0, stoppedEarly: false, depthLimited: false };
  function visitElement(element, path, depth) {
    if (state.stoppedEarly) return;
    if (state.visited >= options.maxVisited) { state.stoppedEarly = true; return; }
    state.visited += 1;
    var snapshot = readElement(element, path, depth);
    if (visit(snapshot.record) === false) { state.stoppedEarly = true; return; }
    if (!snapshot.children || snapshot.children.count === 0) return;
    if (depth >= options.maxDepth) { state.depthLimited = true; return; }
    for (var index = 0; index < snapshot.children.count && !state.stoppedEarly; index++) {
      visitElement(snapshot.children.objectAtIndex(index), path + "/" + (index + 1), depth + 1);
    }
  }
  visitElement(rootElement, rootPath, 0);
  return state;
}

function windowsOf(appElement) {
  var windowList = copyAttribute(appElement, "AXWindows");
  return isMissing(windowList) ? null : windowList;
}

function windowAt(appElement, windowIndex, appName) {
  var windowList = windowsOf(appElement);
  var windowCount = windowList ? Number(windowList.count) : 0;
  if (windowIndex < 1 || windowIndex > windowCount) {
    fail("not_found", "\"" + appName + "\" has no window " + windowIndex + " (it has " + windowCount + "); call list_windows");
  }
  return windowList.objectAtIndex(windowIndex - 1);
}

function staleRef(path) {
  fail("stale_ref", "Element " + path + " no longer exists; call read_ui again");
}

function splitRef(ref) {
  var parts = String(ref).split(REF_FINGERPRINT_SEPARATOR);
  return { path: parts[0], fingerprint: parts.length > 1 ? parts[1] : null };
}

/** Resolves a path like "w1/3/2" (1-based window, then 1-based child indexes) to an element. */
function resolveRefPath(appElement, path) {
  var parts = String(path).split("/");
  var windowList = windowsOf(appElement);
  var windowIndex = Number(parts[0].slice(1));
  if (!windowList || windowIndex > Number(windowList.count)) staleRef(path);
  var element = windowList.objectAtIndex(windowIndex - 1);
  for (var partIndex = 1; partIndex < parts.length; partIndex++) {
    var childList = copyAttribute(element, "AXChildren");
    var childIndex = Number(parts[partIndex]);
    if (isMissing(childList) || childIndex > Number(childList.count)) staleRef(path);
    element = childList.objectAtIndex(childIndex - 1);
  }
  return { element: element, window: windowList.objectAtIndex(windowIndex - 1), windowIndex: windowIndex };
}

/**
 * Resolves a ref like "w1/3/2#0a1b2c3" and, when it carries a fingerprint, checks the element at that
 * path is still the one that was read: a UI that shifted must never redirect a click or a value.
 * Returns `{element, window, windowIndex, path, record}`.
 */
function resolveRef(appElement, ref) {
  var parsedRef = splitRef(ref);
  var target = resolveRefPath(appElement, parsedRef.path);
  target.path = parsedRef.path;
  target.record = readElementRecord(target.element, parsedRef.path);
  if (parsedRef.fingerprint !== null && elementFingerprint(target.record) !== parsedRef.fingerprint) {
    fail("stale_ref", "Element " + parsedRef.path + " is now " + describeRecord(target.record) + ", not the element read before; call read_ui again");
  }
  return target;
}

function readWindowFrame(windowElement) {
  var record = readElementRecord(windowElement, "w");
  return record.position && record.size ? { position: record.position, size: record.size } : null;
}

function isInsideFrame(frame, x, y) {
  return x >= frame.position[0] && y >= frame.position[1] &&
    x < frame.position[0] + frame.size[0] && y < frame.position[1] + frame.size[1];
}

function isInsideAnyWindow(appElement, x, y) {
  var windowList = windowsOf(appElement);
  for (var index = 0; windowList && index < Number(windowList.count); index++) {
    var frame = readWindowFrame(windowList.objectAtIndex(index));
    if (frame && isInsideFrame(frame, x, y)) return true;
  }
  return false;
}

function centreOf(record) {
  if (!record.position || !record.size) fail("action_failed", "Element " + record.ref + " has no position or size to click");
  return [record.position[0] + record.size[0] / 2, record.position[1] + record.size[1] / 2];
}

function focusedElementOf(appElement) {
  var element = copyAttribute(appElement, "AXFocusedUIElement");
  if (isMissing(element)) fail("action_failed", "The app has no focused element; focus one with focus_element first");
  return element;
}

// Identity of a text box that may grow upwards while typing: role, left edge and bottom edge.
function matchesExpectedFocus(record, expected) {
  if (record.role !== expected.role || !record.position || !record.size) return false;
  return Math.abs(record.position[0] - expected.left) <= FRAME_TOLERANCE &&
    Math.abs(record.position[1] + record.size[1] - expected.bottom) <= FRAME_TOLERANCE;
}

/** Fails unless the app's focused element is the expected one (`{role, left, bottom}`). */
function assertFocusedElementMatches(appElement, expected) {
  var record = readElementRecord(focusedElementOf(appElement), "focused");
  if (!matchesExpectedFocus(record, expected)) {
    fail("action_failed", "Keyboard focus moved to " + describeRecord(record) + " instead of the expected " + expected.role + "; stopped");
  }
}

// ---------- input ----------

function keystrokeText(text) {
  systemEvents().keystroke(text);
}

function pressKeyStep(step) {
  var options = step.modifiers.length ? { using: step.modifiers } : {};
  if (typeof step.key_code === "number") systemEvents().keyCode(step.key_code, options);
  else systemEvents().keystroke(step.character, options);
}

/** Pid of the app owning the element on screen at (x, y), or null when nothing can be hit-tested. */
function processIdentifierAtPoint(x, y) {
  var elementRef = Ref();
  if ($.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(), x, y, elementRef) !== AX_SUCCESS) return null;
  var processIdentifierRef = Ref();
  if ($.AXUIElementGetPid(elementRef[0], processIdentifierRef) !== AX_SUCCESS) return null;
  return Number(processIdentifierRef[0]);
}

/** Checked right before posting a click: the app is frontmost and owns what is under the point. */
function assertPointBelongsTo(runningApp, x, y) {
  var appName = appNameOf(runningApp);
  assertFrontmost(runningApp.processIdentifier, appName);
  var ownerProcessIdentifier = processIdentifierAtPoint(x, y);
  if (ownerProcessIdentifier !== runningApp.processIdentifier) {
    var owner = ownerProcessIdentifier === null ? "nothing that can be hit-tested" : "another app (pid " + ownerProcessIdentifier + ")";
    fail("permission_denied", "Point (" + x + ", " + y + ") is covered by " + owner + ", not " + appName + "; nothing clicked");
  }
}

var MOUSE_EVENT_TYPES = { left: { down: 1, up: 2, button: 0 }, right: { down: 3, up: 4, button: 1 } };
var MOUSE_MOVED_EVENT = 5;
var HID_EVENT_TAP = 0;
var CLICK_STATE_FIELD = 1;

function postMouseClick(x, y, buttonName, clickCount) {
  var eventTypes = MOUSE_EVENT_TYPES[buttonName] || MOUSE_EVENT_TYPES.left;
  var point = $.CGPointMake(x, y);
  $.CGEventPost(HID_EVENT_TAP, $.CGEventCreateMouseEvent(null, MOUSE_MOVED_EVENT, point, eventTypes.button));
  delay(0.05);
  for (var clickNumber = 1; clickNumber <= clickCount; clickNumber++) {
    var downEvent = $.CGEventCreateMouseEvent(null, eventTypes.down, point, eventTypes.button);
    var upEvent = $.CGEventCreateMouseEvent(null, eventTypes.up, point, eventTypes.button);
    $.CGEventSetIntegerValueField(downEvent, CLICK_STATE_FIELD, clickNumber);
    $.CGEventSetIntegerValueField(upEvent, CLICK_STATE_FIELD, clickNumber);
    $.CGEventPost(HID_EVENT_TAP, downEvent);
    $.CGEventPost(HID_EVENT_TAP, upEvent);
    delay(0.03);
  }
}

// ---------- clipboard ----------

function readClipboardText() {
  var clipboardText = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
  return isMissing(clipboardText) ? null : clipboardText.js;
}

function writeClipboardText(text) {
  var pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  pasteboard.setStringForType($(text), $.NSPasteboardTypeString);
}

/** Copies every item and every type (text, RTF, images, file URLs…) on the clipboard. */
function snapshotPasteboard() {
  var items = $.NSPasteboard.generalPasteboard.pasteboardItems;
  var snapshot = [];
  for (var itemIndex = 0; !isMissing(items) && itemIndex < Number(items.count); itemIndex++) {
    var item = items.objectAtIndex(itemIndex);
    var types = item.types;
    var entries = [];
    for (var typeIndex = 0; typeIndex < Number(types.count); typeIndex++) {
      var type = types.objectAtIndex(typeIndex);
      var data = item.dataForType(type);
      if (!isMissing(data)) entries.push({ type: type, data: data });
    }
    snapshot.push(entries);
  }
  return snapshot;
}

function restorePasteboard(snapshot) {
  var pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (snapshot.length === 0) return;
  var restoredItems = snapshot.map(function (entries) {
    var item = $.NSPasteboardItem.alloc.init;
    entries.forEach(function (entry) { item.setDataForType(entry.data, entry.type); });
    return item;
  });
  pasteboard.writeObjects($(restoredItems));
}

// ---------- end of prelude ----------
