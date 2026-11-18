// Finds elements in a window by role and/or a case-insensitive text match.
// Input: {app, window, root_ref, roles, text, exact, max_depth, max_results, max_visited}.
function matchesText(record, wantedText, exact) {
  var candidates = [record.title, record.value, record.description, record.placeholder];
  for (var index = 0; index < candidates.length; index++) {
    if (candidates[index] === null || candidates[index] === undefined) continue;
    var candidate = String(candidates[index]).trim().toLowerCase();
    if (exact ? candidate === wantedText : candidate.indexOf(wantedText) !== -1) return true;
  }
  return false;
}

function matchesRecord(record, wantedRoles, input) {
  if (wantedRoles.length && wantedRoles.indexOf(record.role.toLowerCase()) === -1) return false;
  if (input.text && !matchesText(record, input.text.trim().toLowerCase(), input.exact)) return false;
  return true;
}

function resolveSearchRoot(appElement, input) {
  if (input.root_ref) {
    var target = resolveRef(appElement, input.root_ref);
    return { element: target.element, path: target.path };
  }
  return { element: windowAt(appElement, input.window, input.app), path: "w" + input.window };
}

function main(input) {
  var runningApp = findRunningApp(input.app);
  var root = resolveSearchRoot(appElementFor(runningApp), input);
  var wantedRoles = (input.roles || []).map(function (role) { return String(role).toLowerCase(); });
  var matches = [];
  var hitResultLimit = false;
  var walk = walkTree(root.element, root.path, { maxDepth: input.max_depth, maxVisited: input.max_visited }, function (record) {
    if (!matchesRecord(record, wantedRoles, input)) return true;
    matches.push(record);
    // Stop at the limit instead of scanning on for one more match: walks are slow on big trees.
    hitResultLimit = matches.length >= input.max_results;
    return !hitResultLimit;
  });
  return {
    app: appNameOf(runningApp),
    root_ref: root.path,
    elements: matches,
    truncated: hitResultLimit || walk.stoppedEarly,
    depth_limited: walk.depthLimited,
    visited: walk.visited,
  };
}
