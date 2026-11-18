// Presses an element (AXPress), falling back to a mouse click at its centre.
// Input: {app, ref, fallback_click}. The ref's fingerprint is checked before anything happens.
function clickAtCentre(runningApp, target) {
  var centre = centreOf(target.record);
  var windowFrame = readWindowFrame(target.window);
  if (!windowFrame || !isInsideFrame(windowFrame, centre[0], centre[1])) {
    fail("invalid_input", "The centre of " + target.path + " is outside its window (scrolled out of view?); nothing clicked");
  }
  activateApp(runningApp);
  if (target.windowIndex > 1) performElementAction(target.window, "AXRaise");
  assertPointBelongsTo(runningApp, centre[0], centre[1]);
  postMouseClick(centre[0], centre[1], "left", 1);
  return centre;
}

function main(input) {
  var runningApp = findRunningApp(input.app);
  var target = resolveRef(appElementFor(runningApp), input.ref);
  var pressStatus = performElementAction(target.element, "AXPress");
  if (pressStatus === AX_SUCCESS) return { method: "AXPress", element: target.record };
  if (!input.fallback_click) {
    fail("action_failed", "Element " + target.path + " does not support AXPress (AX error " + pressStatus + "); retry with fallback_click");
  }
  return { method: "click", point: clickAtCentre(runningApp, target), element: target.record };
}
