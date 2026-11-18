// Describes the app's focused element: role, frame and its full text value. Input: {app}.
// Used by the WhatsApp recipe to confirm focus before it clears, types or sends anything.
var MAX_FOCUSED_VALUE_LENGTH = 20000;

function main(input) {
  var runningApp = findRunningApp(input.app);
  var element = focusedElementOf(appElementFor(runningApp));
  var record = readElementRecord(element, "focused");
  var fullValue = readFullText(element, "AXValue");
  delete record.ref;
  delete record.depth;
  record.full_value = fullValue === null ? null : fullValue.slice(0, MAX_FOCUSED_VALUE_LENGTH);
  return record;
}
