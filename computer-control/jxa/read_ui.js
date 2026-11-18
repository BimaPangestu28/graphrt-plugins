// Reads a window's Accessibility tree (or the sub-tree under root_ref).
// Input: {app, window, root_ref, max_depth, max_elements, text_only, max_visited}.
function resolveRoot(appElement, input) {
  if (input.root_ref) {
    var target = resolveRef(appElement, input.root_ref);
    return { element: target.element, path: target.path };
  }
  return { element: windowAt(appElement, input.window, input.app), path: "w" + input.window };
}

function main(input) {
  var runningApp = findRunningApp(input.app);
  var root = resolveRoot(appElementFor(runningApp), input);
  var elements = [];
  var hitElementLimit = false;
  var walk = walkTree(root.element, root.path, { maxDepth: input.max_depth, maxVisited: input.max_visited }, function (record) {
    if (input.text_only && !hasText(record)) return true;
    if (elements.length >= input.max_elements) { hitElementLimit = true; return false; }
    elements.push(record);
    return true;
  });
  return {
    app: appNameOf(runningApp),
    root_ref: root.path,
    elements: elements,
    truncated: hitElementLimit || walk.stoppedEarly,
    depth_limited: walk.depthLimited,
    visited: walk.visited,
  };
}
