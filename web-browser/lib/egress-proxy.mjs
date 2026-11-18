/**
 * A per-operation HTTP proxy on 127.0.0.1 that every browser context uses.
 * It is the enforcement point that Playwright routing cannot be on its own:
 *
 * - Redirect hops never reach `context.route` handlers, but they do reach the proxy,
 *   so every hop (and every sub-request, preconnect and tunnel) is host-checked here.
 * - The proxy resolves the host itself and connects to the exact address it checked
 *   (DNS pinning), so a rebinding DNS server cannot swap in an internal address
 *   after the check. Chromium never resolves proxied host names itself.
 * - It counts every byte received from upstream servers and cuts all connections
 *   once the operation's download budget is spent.
 *
 * - It only serves clients that present this operation's random credentials
 *   (`Proxy-Authorization: Basic`), so other local processes cannot use it.
 *
 * https traffic is tunnelled with CONNECT (end-to-end TLS; Chromium still checks
 * certificates). Before contacting the server, the proxy reads the start of
 * the tunnel: a TLS handshake record passes; plaintext passes only as an http
 * request head without `Upgrade` (Playwright's own fetcher tunnels plain http).
 * So a `ws://` WebSocket, which Chromium always sends as a tunnelled upgrade, is
 * cut before it reaches the server. Upgrade requests on plain proxied http are
 * refused too. `wss://` is TLS like any https tunnel and cannot be told apart
 * here; page-hardening.mjs removes the WebSocket APIs from pages and workers.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { normalizeHostname } from "./address-policy.mjs";
import { shortenUrl } from "./url-policy.mjs";

export const BLOCKED_HEADER = "x-graphrt-blocked";
const HOP_BY_HOP_HEADERS = ["connection", "proxy-connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"];
const DEFAULT_SOCKET_IDLE_MS = 30000;
const MAX_RECORDED_BLOCKS = 50;
const TLS_HANDSHAKE_RECORD = 0x16;
const MAX_TUNNEL_PREAMBLE_BYTES = 16 * 1024;
const HEADER_END = "\r\n\r\n";
const PROXY_USERNAME = "graphrt-web-browser";
const AUTHENTICATION_REQUIRED_RESPONSE =
  'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="graphrt-web-browser"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

/**
 * Starts an egress proxy for one operation.
 *
 * @param options - Proxy options (object)
 * @param options.hostGuard - From createHostGuard (object)
 * @param options.maxResponseBytes - Download budget for everything the page loads (number)
 * @param options.socketIdleMs - Idle timeout for each connection (number, default 30000)
 * @returns `{url, credentials: {username, password}, stats(), close()}`; `stats()` gives
 *   `{bytesReceived, budgetExceeded, blocked: [{target, reason}], blockedHosts: Set}` (Promise<object>)
 *
 * @example
 * const proxy = await startEgressProxy({ hostGuard, maxResponseBytes: 15 * 1024 * 1024 });
 * const context = await browser.newContext({ proxy: { server: proxy.url, bypass: "<-loopback>", ...proxy.credentials } });
 * // ... browse ...
 * await proxy.close();
 */
export async function startEgressProxy({ hostGuard, maxResponseBytes, socketIdleMs = DEFAULT_SOCKET_IDLE_MS }) {
  const state = { bytesReceived: 0, budgetExceeded: false, blocked: [], blockedHosts: new Set(), sockets: new Set() };
  const trackSocket = (socket) => {
    state.sockets.add(socket);
    socket.setTimeout?.(socketIdleMs, () => socket.destroy());
    socket.on("close", () => state.sockets.delete(socket));
    return socket;
  };
  const countBytes = (byteCount) => {
    state.bytesReceived += byteCount;
    if (state.bytesReceived <= maxResponseBytes || state.budgetExceeded) return;
    state.budgetExceeded = true;
    console.error(`[web-browser] download budget of ${maxResponseBytes} bytes spent; cutting all connections`);
    for (const socket of state.sockets) socket.destroy();
  };
  const credentials = { username: PROXY_USERNAME, password: randomBytes(24).toString("hex") };
  const expectedAuthorization = Buffer.from(`Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`);
  const isAuthorized = (request) => {
    const presented = Buffer.from(String(request.headers["proxy-authorization"] ?? ""));
    return presented.length === expectedAuthorization.length && timingSafeEqual(presented, expectedAuthorization);
  };
  const context = { hostGuard, state, trackSocket, countBytes, isAuthorized };
  const server = http.createServer((request, response) =>
    forwardHttpRequest(context, request, response).catch((forwardError) => failRequest(response, forwardError)),
  );
  server.on("connection", trackSocket);
  server.on("connect", (request, clientSocket, head) =>
    openTunnel(context, request, clientSocket, head).catch((tunnelError) => failSocket(clientSocket, tunnelError)),
  );
  server.on("upgrade", (request, clientSocket) => {
    if (!isAuthorized(request)) return requireAuthentication(clientSocket);
    refuseSocket(context, clientSocket, request.url, "WebSocket connections are not allowed");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    credentials,
    stats: () => ({ bytesReceived: state.bytesReceived, budgetExceeded: state.budgetExceeded, blocked: [...state.blocked], blockedHosts: new Set(state.blockedHosts) }),
    close: () => closeServer(server, state.sockets),
  };
}

async function forwardHttpRequest(context, request, response) {
  if (!context.isAuthorized(request)) {
    response.writeHead(407, { "proxy-authenticate": 'Basic realm="graphrt-web-browser"', connection: "close" });
    return response.end();
  }
  const target = parseAbsoluteHttpUrl(request.url);
  if (!target) return refuseHttp(context, response, request.url, "only absolute http:// requests are proxied");
  const pinnedAddress = await checkTarget(context, target.hostname, request.url);
  if (!pinnedAddress.ok) return refuseHttp(context, response, request.url, pinnedAddress.reason);
  const upstreamRequest = http.request({
    host: target.hostname,
    port: target.port || 80,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers: withoutHopByHopHeaders(request.headers),
    lookup: createPinnedLookup(pinnedAddress.address),
    agent: false,
  });
  upstreamRequest.on("socket", context.trackSocket);
  upstreamRequest.on("response", (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode, upstreamResponse.statusMessage, withoutHopByHopHeaders(upstreamResponse.headers));
    upstreamResponse.on("data", (chunk) => context.countBytes(chunk.length));
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on("error", () => (response.headersSent ? response.destroy() : response.writeHead(502).end()));
  request.pipe(upstreamRequest);
}

async function openTunnel(context, request, clientSocket, head) {
  if (!context.isAuthorized(request)) return requireAuthentication(clientSocket);
  const target = parseConnectTarget(request.url);
  if (!target) return refuseSocket(context, clientSocket, request.url, "malformed CONNECT target");
  const pinnedAddress = await checkTarget(context, target.hostname, request.url);
  if (!pinnedAddress.ok) return refuseSocket(context, clientSocket, request.url, pinnedAddress.reason);
  // Answer first and look at what the client sends before contacting the server.
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const preamble = await readTunnelPreamble(clientSocket, head);
  if (!preamble) return clientSocket.destroy();
  const refusal = describeTunnelRefusal(preamble);
  if (refusal) {
    recordBlock(context.state, request.url, refusal);
    return clientSocket.destroy();
  }
  connectTunnelUpstream(context, clientSocket, { address: pinnedAddress.address, port: target.port, firstChunk: preamble });
}

// Reads until the tunnel's start can be judged: a TLS record byte, a complete http head, or the size cap.
function readTunnelPreamble(clientSocket, head) {
  return new Promise((resolve) => {
    let buffered = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    const isJudgeable = () => buffered.length > 0 && (buffered[0] === TLS_HANDSHAKE_RECORD || buffered.includes(HEADER_END) || buffered.length >= MAX_TUNNEL_PREAMBLE_BYTES);
    const finish = (result) => {
      clientSocket.off("data", onData);
      clientSocket.off("close", onClose);
      clientSocket.pause();
      resolve(result);
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (isJudgeable()) finish(buffered);
    };
    const onClose = () => finish(null);
    clientSocket.on("error", () => {});
    if (isJudgeable()) return resolve(buffered);
    clientSocket.on("data", onData);
    clientSocket.once("close", onClose);
  });
}

/**
 * Judges the first bytes of a CONNECT tunnel (see module docs).
 *
 * @param preamble - First bytes the client sent (Buffer)
 * @returns Refusal reason, or null when the tunnel may proceed (string | null)
 */
export function describeTunnelRefusal(preamble) {
  if (preamble[0] === TLS_HANDSHAKE_RECORD) return null;
  const text = preamble.subarray(0, MAX_TUNNEL_PREAMBLE_BYTES).toString("latin1");
  const headerEnd = text.indexOf(HEADER_END);
  if (headerEnd === -1 || !/^[A-Z]+ \S+ HTTP\/1\.[01]\r\n/.test(text)) return "a tunnel must carry TLS or a plain http request";
  if (/^(upgrade:|connection:[^\r\n]*\bupgrade\b)/im.test(text.slice(0, headerEnd))) return "WebSocket and other upgraded connections are not allowed";
  return null;
}

function connectTunnelUpstream(context, clientSocket, { address, port, firstChunk }) {
  const upstreamSocket = context.trackSocket(net.connect({ host: address, port }));
  upstreamSocket.on("connect", () => {
    upstreamSocket.write(firstChunk);
    upstreamSocket.on("data", (chunk) => context.countBytes(chunk.length));
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
  upstreamSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstreamSocket.destroy());
  clientSocket.on("close", () => upstreamSocket.destroy());
}

// Resolves and checks the host; the first checked address is the one we connect to.
async function checkTarget(context, hostname, targetLabel) {
  if (context.state.budgetExceeded) return { ok: false, reason: "the download budget for this page is spent" };
  try {
    const addresses = await context.hostGuard.resolvePublicAddresses(hostname);
    return { ok: true, address: addresses[0] };
  } catch (checkError) {
    if (checkError instanceof PluginError && checkError.kind === "permission_denied") context.state.blockedHosts.add(normalizeHostname(hostname));
    return { ok: false, reason: checkError.message ?? String(checkError), target: targetLabel };
  }
}

function failRequest(response, forwardError) {
  console.error(`[web-browser] proxy request failed: ${forwardError?.message ?? forwardError}`);
  if (response.headersSent) response.destroy();
  else response.writeHead(502).end();
}

function failSocket(clientSocket, tunnelError) {
  console.error(`[web-browser] proxy tunnel failed: ${tunnelError?.message ?? tunnelError}`);
  clientSocket.destroy();
}

function refuseHttp(context, response, targetLabel, reason) {
  recordBlock(context.state, targetLabel, reason);
  response.writeHead(403, { "content-type": "text/plain; charset=utf-8", [BLOCKED_HEADER]: "1" });
  response.end(`Blocked by graphrt web-browser: ${reason}\n`);
}

function requireAuthentication(clientSocket) {
  clientSocket.on("error", () => {});
  clientSocket.end(AUTHENTICATION_REQUIRED_RESPONSE);
}

function refuseSocket(context, clientSocket, targetLabel, reason) {
  recordBlock(context.state, targetLabel, reason);
  clientSocket.end(`HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  clientSocket.on("error", () => {});
}

function recordBlock(state, targetLabel, reason) {
  console.error(`[web-browser] blocked ${shortenUrl(targetLabel)}: ${reason}`);
  if (state.blocked.length < MAX_RECORDED_BLOCKS) state.blocked.push({ target: shortenUrl(targetLabel), reason });
}

function parseAbsoluteHttpUrl(requestUrl) {
  try {
    const parsedUrl = new URL(requestUrl);
    return parsedUrl.protocol === "http:" && !parsedUrl.username && !parsedUrl.password ? parsedUrl : null;
  } catch {
    return null;
  }
}

/**
 * Parses a CONNECT request target (`host:port` or `[v6]:port`).
 *
 * @param connectTarget - The request-target of a CONNECT line (string)
 * @returns `{hostname, port}` or null when malformed (object | null)
 */
export function parseConnectTarget(connectTarget) {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^\s:/@[\]]+):(\d{1,5})$/.exec(String(connectTarget ?? ""));
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { hostname: normalizeHostname(match[1]), port };
}

/**
 * Builds a `lookup` for http.request/net.connect that always answers with one pre-checked address.
 *
 * @param address - IP address that passed the host guard (string)
 * @returns dns.lookup-compatible function (function)
 */
export function createPinnedLookup(address) {
  const family = net.isIP(address);
  return (hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    if (options?.all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

function withoutHopByHopHeaders(headers) {
  const forwardedHeaders = { ...headers };
  const connectionTokens = String(headers.connection ?? "").split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
  for (const headerName of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) delete forwardedHeaders[headerName];
  return forwardedHeaders;
}

function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}
