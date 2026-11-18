// Lists running apps that have a Dock icon (regular activation policy). Needs no permission.
function main() {
  return listRunningApps()
    .filter(isRegularApp)
    .map(function (runningApp) {
      return {
        name: appNameOf(runningApp),
        bundle_id: bundleIdentifierOf(runningApp) || null,
        pid: runningApp.processIdentifier,
        active: runningApp.active === true,
        hidden: runningApp.hidden === true,
      };
    });
}
