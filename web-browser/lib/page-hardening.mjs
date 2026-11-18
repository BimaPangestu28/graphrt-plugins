/**
 * An init script that every page, frame and popup of a browser context runs
 * BEFORE any of its own scripts, and that is carried into every worker.
 *
 * It removes the APIs that open connections the egress proxy cannot police:
 * - WebRTC (`RTCPeerConnection` & co.) sends UDP straight from the renderer,
 *   around any HTTP proxy, to whatever STUN/TURN server or remote candidate a
 *   page names, including local addresses;
 * - WebSocket / WebSocketStream / WebTransport: a `wss:` socket is an opaque
 *   CONNECT tunnel to the proxy, so it could not be refused once allowed.
 *
 * Init scripts do not run in workers, so `Worker` and `SharedWorker` are
 * replaced with wrappers that start the worker from a blob whose first code is
 * this same script (nested workers are wrapped again from inside). Values the
 * wrapper relies on (Blob, URL.createObjectURL, JSON.stringify, the original
 * constructors) are captured before page scripts run, so a page cannot swap them.
 *
 * Known side effects (acceptable for read-only browsing): inside a wrapped
 * worker `self.location` is the wrapper's blob URL, so relative URLs used by the
 * worker script resolve against it and fail; `URL.revokeObjectURL` is delayed by
 * 30 s so a page may revoke a worker's blob URL right after `new Worker(...)`.
 *
 * The browser-wide `--force-webrtc-ip-handling-policy` switch (browser-session.mjs)
 * is a second, independent lock on WebRTC UDP.
 */

/** Globals deleted from every window and worker scope. */
export const BLOCKED_GLOBALS = [
  "WebSocket", "WebSocketStream", "WebSocketError", "WebTransport", "WebTransportError",
  "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate",
  "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver", "RTCDtlsTransport", "RTCIceTransport", "RTCSctpTransport",
  "RTCCertificate", "RTCDTMFSender", "RTCRtpScriptTransform", "RTCEncodedAudioFrame", "RTCEncodedVideoFrame",
];

/**
 * Arguments for `context.addInitScript(hardenScopeInPage, ...)`.
 *
 * @returns `{blockedGlobals, hardeningSource}` (object)
 */
export function buildHardeningArgument() {
  return { blockedGlobals: BLOCKED_GLOBALS, hardeningSource: hardenScopeInPage.toString() };
}

/**
 * Runs inside the page (and, as source text, inside workers). Self-contained:
 * Playwright and the worker wrapper serialise its source.
 *
 * @param argument - From buildHardeningArgument (object)
 * @returns nothing
 */
export function hardenScopeInPage({ blockedGlobals, hardeningSource }) {
  const scope = globalThis;
  for (const globalName of blockedGlobals) {
    try {
      delete scope[globalName];
    } catch {}
    if (globalName in scope) {
      try {
        Object.defineProperty(scope, globalName, { value: undefined, writable: false, configurable: false });
      } catch {}
    }
  }
  const captured = {
    Blob: scope.Blob,
    UrlConstructor: scope.URL,
    createObjectUrl: scope.URL?.createObjectURL,
    revokeObjectUrl: scope.URL?.revokeObjectURL,
    setTimer: scope.setTimeout,
    stringify: JSON.stringify,
    apply: Reflect.apply,
    construct: Reflect.construct,
    defineProperty: Object.defineProperty,
  };
  if (!captured.Blob || !captured.createObjectUrl) return;
  const quote = (value) => captured.apply(captured.stringify, JSON, [String(value)]);
  const singlePartIterable = (part) => {
    // Own iterator: the Blob constructor must not use the (page-replaceable) Array iterator.
    const parts = {};
    parts[Symbol.iterator] = () => {
      let isDone = false;
      return { next: () => (isDone ? { done: true, value: undefined } : ((isDone = true), { done: false, value: part })) };
    };
    return parts;
  };
  const toBlobUrl = (source) =>
    captured.apply(captured.createObjectUrl, captured.UrlConstructor, [new captured.Blob(singlePartIterable(source), { type: "text/javascript" })]);
  const prelude = `(${hardeningSource})(${captured.apply(captured.stringify, JSON, [{ blockedGlobals, hardeningSource }])});\n`;
  const preludeUrl = toBlobUrl(prelude);
  const buildWrapperUrl = (scriptUrl, isModule) =>
    toBlobUrl(isModule ? `import ${quote(preludeUrl)};\nimport ${quote(scriptUrl)};\n` : `${prelude}importScripts(${quote(scriptUrl)});\n`);
  const resolveScriptUrl = (scriptUrl) => {
    try {
      return new captured.UrlConstructor(String(scriptUrl), scope.location.href).href;
    } catch {
      return String(scriptUrl);
    }
  };
  const wrapWorkerConstructor = (constructorName) => {
    const OriginalWorker = scope[constructorName];
    if (typeof OriginalWorker !== "function") return;
    const WrappedWorker = function (scriptUrl, options) {
      if (!new.target) throw new TypeError(`Failed to construct '${constructorName}': Please use the 'new' operator.`);
      const workerOptions = typeof options === "string" ? { name: options } : { ...(options ?? {}) };
      const isModule = workerOptions.type === "module";
      const safeOptions = { name: workerOptions.name === undefined ? "" : String(workerOptions.name), type: isModule ? "module" : "classic" };
      if (workerOptions.credentials !== undefined) safeOptions.credentials = String(workerOptions.credentials);
      return captured.construct(OriginalWorker, [buildWrapperUrl(resolveScriptUrl(scriptUrl), isModule), safeOptions], new.target);
    };
    WrappedWorker.prototype = OriginalWorker.prototype;
    captured.defineProperty(OriginalWorker.prototype, "constructor", { value: WrappedWorker, writable: true, configurable: true });
    captured.defineProperty(scope, constructorName, { value: WrappedWorker, writable: true, configurable: true });
  };
  wrapWorkerConstructor("Worker");
  wrapWorkerConstructor("SharedWorker");
  if (captured.revokeObjectUrl) {
    scope.URL.revokeObjectURL = (objectUrl) => {
      captured.setTimer(() => captured.apply(captured.revokeObjectUrl, captured.UrlConstructor, [objectUrl]), 30000);
    };
  }
}
