// Finds the CGWindowID of one of an app's windows, for `screencapture -l <id>`: capturing by
// window id shows only that window, never whatever overlaps its rectangle. Input: {app, window}.
var NORMAL_WINDOW_LAYER = 0;

function listOnScreenWindows() {
  var options = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options, $.kCGNullWindowID))) || [];
}

function boundsMatchFrame(bounds, frame) {
  return Boolean(bounds) &&
    Math.abs(bounds.X - frame.position[0]) <= FRAME_TOLERANCE && Math.abs(bounds.Y - frame.position[1]) <= FRAME_TOLERANCE &&
    Math.abs(bounds.Width - frame.size[0]) <= FRAME_TOLERANCE && Math.abs(bounds.Height - frame.size[1]) <= FRAME_TOLERANCE;
}

/** The window number owned by `processIdentifier` whose bounds equal the Accessibility frame, or null. */
function findWindowNumber(processIdentifier, frame) {
  var windowInfos = listOnScreenWindows();
  for (var index = 0; index < windowInfos.length; index++) {
    var windowInfo = windowInfos[index];
    if (windowInfo.kCGWindowOwnerPID !== processIdentifier || windowInfo.kCGWindowLayer !== NORMAL_WINDOW_LAYER) continue;
    if (boundsMatchFrame(windowInfo.kCGWindowBounds, frame)) return windowInfo.kCGWindowNumber;
  }
  return null;
}

function main(input) {
  var runningApp = findRunningApp(input.app);
  var windowElement = windowAt(appElementFor(runningApp), input.window, input.app);
  var frame = readWindowFrame(windowElement);
  if (!frame) fail("action_failed", "Window " + input.window + " of \"" + input.app + "\" has no frame");
  var windowNumber = findWindowNumber(runningApp.processIdentifier, frame);
  if (windowNumber === null) {
    fail("not_found", "Window " + input.window + " of \"" + input.app + "\" is not on screen (minimised, or on another Space?)");
  }
  return { window_id: windowNumber, x: frame.position[0], y: frame.position[1], width: frame.size[0], height: frame.size[1] };
}
