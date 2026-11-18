// Presses validated key combos in an app. Node parses and validates them first (and refuses
// system-wide shortcuts). Before every step the app must still be frontmost and, when
// `require_focus` ({role, left, bottom}) is given, that element must still have keyboard focus.
// Input: {app, steps: [{label, character | key_code, modifiers: ["command down", ...]}], require_focus?}.
var BETWEEN_STEPS_SECONDS = 0.08;

function main(input) {
  var runningApp = findRunningApp(input.app);
  var appName = appNameOf(runningApp);
  var appElement = appElementFor(runningApp);
  activateApp(runningApp);
  input.steps.forEach(function (step) {
    assertFrontmost(runningApp.processIdentifier, appName);
    if (input.require_focus) assertFocusedElementMatches(appElement, input.require_focus);
    pressKeyStep(step);
    delay(BETWEEN_STEPS_SECONDS);
  });
  return { app: appName, pressed: input.steps.length };
}
