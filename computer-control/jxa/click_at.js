// Clicks at screen coordinates, only inside one of the target app's windows and only when the
// hit-test says the app owns what is under the point. Input: {app, x, y, button, click_count}.
function main(input) {
  var runningApp = findRunningApp(input.app);
  var appElement = appElementFor(runningApp);
  activateApp(runningApp);
  if (!isInsideAnyWindow(appElement, input.x, input.y)) {
    fail("invalid_input", "Point (" + input.x + ", " + input.y + ") is outside every window of \"" + input.app + "\"; check list_windows");
  }
  assertPointBelongsTo(runningApp, input.x, input.y);
  postMouseClick(input.x, input.y, input.button, input.click_count);
  return { app: appNameOf(runningApp), point: [input.x, input.y], button: input.button, click_count: input.click_count };
}
