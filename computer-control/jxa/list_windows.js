// Lists an app's windows in Accessibility order (usually front to back). Input: {app}.
var WINDOW_ATTRIBUTES = ["AXTitle", "AXPosition", "AXSize", "AXMinimized", "AXMain", "AXFocused"];

function describeWindow(windowElement, windowIndex) {
  var valuesRef = Ref();
  $.AXUIElementCopyMultipleAttributeValues(windowElement, $(WINDOW_ATTRIBUTES), 0, valuesRef);
  var values = ObjC.castRefToObject(valuesRef[0]);
  var valueAt = function (index) { return toJsValue(values.objectAtIndex(index)); };
  return {
    ref: "w" + windowIndex,
    index: windowIndex,
    title: nonEmptyText(valueAt(0)),
    position: valueAt(1),
    size: valueAt(2),
    minimized: valueAt(3) === true,
    main: valueAt(4) === true,
    focused: valueAt(5) === true,
  };
}

function main(input) {
  var runningApp = findRunningApp(input.app);
  var windowList = windowsOf(appElementFor(runningApp));
  var windows = [];
  for (var index = 0; windowList && index < windowList.count; index++) {
    windows.push(describeWindow(windowList.objectAtIndex(index), index + 1));
  }
  return { app: appNameOf(runningApp), windows: windows };
}
