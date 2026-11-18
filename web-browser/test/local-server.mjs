/**
 * A tiny local HTTP server for tests. It listens on 127.0.0.1 by default, which
 * the plugin refuses for callers; tests opt in with `allowedTestHosts` only.
 * Servers on `::1` serve as INTERNAL targets: no test ever allowlists them.
 */
import http from "node:http";

/**
 * Starts a server answering from a route table.
 *
 * @param routes - `{"/path": (request, response, server) => void}`; unknown paths get 404 (object)
 * @param options - `{host}`: listen address, "127.0.0.1" (default) or "::1" (object, optional)
 * @returns `{origin, port, hits: string[], upgrades: string[], connectionCount(), close()}` (Promise<object>)
 */
export async function startLocalServer(routes, { host = "127.0.0.1" } = {}) {
  const hits = [];
  const upgrades = [];
  let connectionCount = 0;
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    const handler = routes[new URL(request.url, "http://local").pathname];
    if (!handler) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    handler(request, response, serverInfo);
  });
  server.on("connection", () => {
    connectionCount += 1;
  });
  // Any WebSocket handshake that arrives is recorded and dropped.
  server.on("upgrade", (request, socket) => {
    upgrades.push(request.url);
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const serverInfo = {
    port: server.address().port,
    origin: `http://${urlHost}:${server.address().port}`,
    hits,
    upgrades,
    connectionCount: () => connectionCount,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return serverInfo;
}

/**
 * Builds a route handler that answers with HTML.
 *
 * @param html - Response body (string | (serverInfo) => string)
 * @param headers - Extra headers (object, optional)
 * @returns Route handler (function)
 */
export function htmlRoute(html, headers = {}) {
  return (request, response, serverInfo) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
    response.end(typeof html === "function" ? html(serverInfo) : html);
  };
}

/**
 * Builds a route handler that redirects.
 *
 * @param location - Target URL (string | (serverInfo) => string)
 * @param status - Redirect status (number, default 302)
 * @returns Route handler (function)
 */
export function redirectRoute(location, status = 302) {
  return (request, response, serverInfo) => {
    response.writeHead(status, { location: typeof location === "function" ? location(serverInfo) : location });
    response.end();
  };
}
