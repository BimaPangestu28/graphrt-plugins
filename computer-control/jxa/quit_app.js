// Asks a running app to quit (like Cmd+Q; the app may still ask to save documents). Input: {app}.
function main(input) {
  var runningApp = findRunningApp(input.app);
  var accepted = runningApp.terminate;
  return { app: appNameOf(runningApp), quit_requested: accepted === true };
}
