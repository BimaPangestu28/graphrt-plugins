// Brings a running app to the front. Input: {app}.
function main(input) {
  var runningApp = findRunningApp(input.app);
  activateApp(runningApp);
  return { app: appNameOf(runningApp), pid: runningApp.processIdentifier, frontmost: true };
}
