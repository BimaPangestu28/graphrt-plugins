/**
 * Hostile pages for the end-to-end tests: each one tries to escape the
 * plugin's network rules or to break its in-page readers. They report what
 * they could do as page text, so a test reads the verdict with fetch_page.
 */

const DONE_MARKER_SCRIPT = `function finishReport(reports) {
  document.getElementById("report").textContent = reports.join(" ");
  const doneMarker = document.createElement("div");
  doneMarker.id = "done";
  document.body.appendChild(doneMarker);
}`;

/**
 * A page that opens WebRTC peer connections with STUN servers and remote host
 * candidates on local UDP ports, from the page, a same-tick iframe and a popup.
 *
 * @param udpPorts - `{ipv4Port, ipv6Port}` of the UDP listeners (object)
 * @returns HTML (string)
 */
export function buildWebRtcPage({ ipv4Port, ipv6Port }) {
  return `<!doctype html><title>WebRTC</title><p id="report">pending</p><script>
${DONE_MARKER_SCRIPT}
const reports = [];
const iceServers = [{ urls: "stun:127.0.0.1:${ipv4Port}" }, { urls: "stun:[::1]:${ipv6Port}" }];
const remoteCandidates = ["candidate:1 1 udp 2122260223 127.0.0.1 ${ipv4Port} typ host", "candidate:2 1 udp 2122260223 ::1 ${ipv6Port} typ host"];
async function tryPeerConnection(label, scope) {
  const PeerConnection = scope && (scope.RTCPeerConnection || scope.webkitRTCPeerConnection);
  if (!PeerConnection) return reports.push(label + "=absent");
  reports.push(label + "=present");
  try {
    const local = new PeerConnection({ iceServers });
    local.createDataChannel("probe");
    await local.setLocalDescription(await local.createOffer());
    const remote = new PeerConnection();
    await remote.setRemoteDescription(local.localDescription);
    await remote.setLocalDescription(await remote.createAnswer());
    await local.setRemoteDescription(remote.localDescription);
    for (const candidate of remoteCandidates) await local.addIceCandidate({ candidate, sdpMid: "0", sdpMLineIndex: 0 }).catch(() => {});
  } catch (error) {}
}
const frame = document.createElement("iframe");
document.body.appendChild(frame);
let popup = null;
try { popup = window.open(""); } catch (error) {}
Promise.all([tryPeerConnection("main", window), tryPeerConnection("iframe", frame.contentWindow), tryPeerConnection("popup", popup)])
  .finally(() => setTimeout(() => finishReport(reports), 2500));
</script>`;
}

// Runs in the page AND (as source text) in every worker: opens WebSockets and fetches.
function probeNetworkFromScope(label, scope, targets) {
  const WebSocketConstructor = scope && scope.WebSocket;
  for (const httpUrl of targets.fetchUrls) {
    try { scope.fetch(httpUrl + "?from=" + label).catch(() => {}); } catch (error) {}
  }
  if (!WebSocketConstructor) return label + "=absent";
  for (const socketUrl of targets.socketUrls) {
    try { new WebSocketConstructor(socketUrl + "-" + label); } catch (error) {}
  }
  return label + "=present";
}

/**
 * A page that opens WebSockets (to a public and an internal server) and fetches
 * internal URLs from the page, a same-tick iframe and every kind of worker.
 *
 * @param targets - `{socketUrls: string[], fetchUrls: string[]}` (object)
 * @returns HTML (string)
 */
export function buildWebSocketPage(targets) {
  return `<!doctype html><title>WebSockets</title><p id="report">pending</p><script>
${DONE_MARKER_SCRIPT}
const targets = ${JSON.stringify(targets)};
${probeNetworkFromScope.toString()}
const reports = [probeNetworkFromScope("main", window, targets)];
const frame = document.createElement("iframe");
document.body.appendChild(frame);
reports.push(probeNetworkFromScope("iframe", frame.contentWindow, targets));
const workerBody = (label) => "const targets = " + JSON.stringify(targets) + ";\\n" + probeNetworkFromScope.toString() + "\\nconst workerReport = probeNetworkFromScope(" + JSON.stringify(label) + ", self, targets);\\n";
const blobUrl = (source) => URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
const collect = (port) => port.addEventListener("message", (event) => reports.push(String(event.data)));
function startWorker(label, url, options) {
  try {
    const worker = new Worker(url, options);
    collect(worker);
    worker.addEventListener("error", () => reports.push(label + "=failed"));
  } catch (error) { reports.push(label + "=threw"); }
}
startWorker("classic", blobUrl(workerBody("classic") + "postMessage(workerReport);"));
startWorker("module", blobUrl(workerBody("module") + "postMessage(workerReport);"), { type: "module" });
startWorker("url", "/probe-worker.js");
startWorker("nested", blobUrl(workerBody("outer") + "postMessage(workerReport);" +
  "const inner = new Worker(URL.createObjectURL(new Blob([" + JSON.stringify(workerBody("nested") + "postMessage(workerReport);") + "])));" +
  "inner.onmessage = (event) => postMessage(event.data);"));
try {
  const shared = new SharedWorker(blobUrl(workerBody("shared") + "onconnect = (event) => event.ports[0].postMessage(workerReport);"));
  shared.port.start();
  collect(shared.port);
} catch (error) { reports.push("shared=threw"); }
// Tampering with what a worker wrapper might use must not let a worker start without the hardening.
const tamperedTarget = blobUrl(workerBody("tampered") + "postMessage(workerReport);");
const escapeSource = workerBody("escaped") + "postMessage(workerReport);";
const escapeUrl = blobUrl(escapeSource);
const originalArrayIterator = Array.prototype[Symbol.iterator];
const OriginalBlob = Blob;
URL.createObjectURL = () => escapeUrl;
JSON.stringify = () => '"' + escapeUrl + '"';
Blob = function () { return new OriginalBlob([escapeSource]); };
Array.prototype[Symbol.iterator] = function* () { yield escapeSource; };
startWorker("tampered", tamperedTarget);
Array.prototype[Symbol.iterator] = originalArrayIterator;
setTimeout(() => finishReport(reports), 3000);
</script>`;
}

/**
 * Worker script served from a URL (not a blob) for the WebSocket page.
 *
 * @param targets - Same as buildWebSocketPage (object)
 * @returns JavaScript (string)
 */
export function buildProbeWorkerScript(targets) {
  return `const targets = ${JSON.stringify(targets)};\n${probeNetworkFromScope.toString()}\npostMessage(probeNetworkFromScope("url", self, targets));\n`;
}

/**
 * A page that tampers with the built-ins the snapshot reader uses, so a naive
 * reader would return 50 MB of text and ignore its caps.
 */
export const TAMPERING_PAGE = `<!doctype html><title>Tamper</title><p>alpha</p><p>beta</p><p class="price">gamma</p><script>
const hugeText = "A".repeat(50000000);
Object.defineProperty(Node.prototype, "nodeValue", { get() { return this.nodeType === 3 ? hugeText : null; }, configurable: true });
Object.defineProperty(Node.prototype, "textContent", { get() { return hugeText; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "innerText", { get() { return hugeText; }, configurable: true });
Element.prototype.getAttribute = function () { return hugeText; };
Math.max = () => Infinity;
Math.min = () => Infinity;
String.prototype.slice = function () { return String(this); };
Array.prototype.slice = function () { return this; };
window.getComputedStyle = () => { for (;;) {} };
</script>`;

/** A page whose main thread spins forever once loaded. */
export const BUSY_PAGE = `<!doctype html><title>Busy</title><p>busy page</p>
<script>addEventListener("load", () => setTimeout(() => { for (;;) {} }, 0));</script>`;
