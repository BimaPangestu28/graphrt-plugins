// Sets AXValue on an element (text fields, text areas). Input: {app, ref, value}.
function main(input) {
  var runningApp = findRunningApp(input.app);
  var target = resolveRef(appElementFor(runningApp), input.ref);
  var status = setAttributeValue(target.element, "AXValue", $(input.value));
  if (status !== AX_SUCCESS) {
    fail("action_failed", "Could not set the value of " + target.path + " (AX error " + status + "); it may not be an editable text field");
  }
  return { element: readElementRecord(target.element, target.path) };
}
