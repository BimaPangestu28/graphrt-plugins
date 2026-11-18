// Brings the app to the front and moves keyboard focus to an element. Input: {app, ref}.
function main(input) {
  var runningApp = findRunningApp(input.app);
  var target = resolveRef(appElementFor(runningApp), input.ref);
  activateApp(runningApp);
  var status = setAttributeValue(target.element, "AXFocused", $.NSNumber.numberWithBool(true));
  if (status !== AX_SUCCESS) fail("action_failed", "Could not focus " + target.path + " (AX error " + status + ")");
  return { element: readElementRecord(target.element, target.path) };
}
