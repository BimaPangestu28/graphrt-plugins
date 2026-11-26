# web-browser

**Status:** stable · **ToS risk:** low. Real-Chromium end-to-end suite and live reads of public pages, with SSRF refusals checked live (PR #24, #34). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for **read-only browsing of public web pages** in a
headless Chromium (Playwright). Workflows and agents can read a page as clean text or markdown, list its links,
pull values out with CSS selectors, and take screenshots. The plugin can't click, type or log in, and it won't let a
page reach your local network or a cloud metadata service.

## Features
- **`fetch_page`:** returns the final URL, HTTP status, title, meta description, language, canonical URL, and the
  readable main text. Optionally it also returns markdown (headings, lists, links, tables, code) and the links in the
  content. Text and links are capped.
- **`get_links`:** lists the page's unique http(s) links with their text. You can filter them by `scope` (`all`,
  `same_host`, `same_domain`) and by a wildcard `pattern` such as `*/blog/*`.
- **`extract`:** takes `fields`, which maps names to a CSS selector (the text of the first match) or to
  `{selector, attribute?, all?}`. It returns one value per field, or a list for `all: true`. The selectors are CSS
  only and are run by a fixed in-page function.
- **`screenshot`:** saves a PNG of the viewport, or of the full page up to `max_height` px, in
  `WEB_BROWSER_SCREENSHOT_DIR` and returns the path.
- **Waiting:** every operation takes `wait_until` (`load`, `domcontentloaded` or `networkidle`), an optional
  `wait_for_selector`, and `timeout_seconds` (5–60).
- **One browser per plugin process:**
  - Chromium starts on the first call and closes after `WEB_BROWSER_IDLE_MINUTES` without use, or when graphrt
    stops the plugin.
  - Each call gets a fresh browser context, so no cookies, storage or cache carry over. At most
    `WEB_BROWSER_MAX_PAGES` pages are open at once; further calls wait their turn.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Security model
Every page and every request the page makes is held to one rule: **http(s) to a public host only.** There are
two layers of checks and they are independent:

1. **Before the browser starts:** the URL must be `http:` or `https:` without `user:pass@`. Its host must not be
   `localhost` or `*.localhost`, and every address it resolves to must be public. robots.txt must allow it (see
   below).
2. **Inside the browser:**
   - **`context.route` (all requests):** every request must be http(s) to a public host. Images, media and fonts
     are skipped for text operations. A page may make at most 500 requests.
   - **Main-frame navigations:** the plugin fetches these itself, one hop at a time. Each redirect target's host
     and robots.txt are checked *before* that hop is requested.
   - **No WebRTC, WebSocket, WebSocketStream or WebTransport:** an init script removes these APIs from every
     page, frame and popup before the page's own scripts run, and is carried into every dedicated, shared,
     module and nested worker (`Worker`/`SharedWorker` are wrapped so the worker starts with it). WebRTC is also
     locked browser-wide with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, so even a page that
     found a way back to `RTCPeerConnection` could not send UDP.
   - **The egress proxy:** each operation runs its own HTTP proxy on 127.0.0.1, and the browser context sends all
     traffic through it, https and loopback included (CONNECT tunnels; the bypass list is set to `<-loopback>`
     explicitly, so this does not depend on Playwright defaults or environment variables). The proxy only
     serves clients that present that operation's random credentials. It resolves each host itself, refuses
     internal addresses, and **connects to the exact address it checked**. A tunnel must start with a TLS
     handshake or a plain http request without `Upgrade`, so a `ws://` WebSocket is cut before it reaches the
     server. It also counts the bytes downloaded and cuts every connection once `WEB_BROWSER_MAX_DOWNLOAD_MB`
     is spent.

The proxy matters because Playwright route handlers are not called for redirect hops, and because Chromium would
otherwise resolve DNS on its own.

**Refused addresses:**
- loopback (`127.0.0.0/8`, `::1`), `0.0.0.0/8` and `::`
- private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`)
- link-local (`169.254/16`, `fe80::/10`), which includes the metadata services `169.254.169.254` and
  `fd00:ec2::254`, and Azure's platform address `168.63.129.16`
- CGNAT (`100.64/10`)
- multicast and broadcast (`224/3`, `ff00::/8`)
- benchmarking and documentation ranges, ORCHIDv2 `2001:20::/28`
- every IPv6 form that embeds an IPv4 address: IPv4-compatible `::/96`, IPv4-mapped `::ffff:0:0/96`,
  IPv4-translated `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`, and Teredo
  `2001::/32`

Numeric host forms such as `http://2130706433/` or `http://0x7f.1/` are normalised first, so they are refused
too.

**Other locks:**
- Downloads are off (`acceptDownloads: false`), service workers are blocked, and TLS errors are not ignored.
- Tools can't run JavaScript, click, type, set headers or cookies, or choose a file path. The only scripts the
  plugin runs in the page are its own fixed readers in `lib/page-snapshot.mjs` and the hardening init script.
- **The readers can't be subverted by the page:** they run in a separate isolated world with untouched
  built-ins (a page that replaces `Math.max`, `String.prototype.slice`, DOM getters or `getComputedStyle`
  changes nothing for them), each read gets 8 s before the operation fails with `timeout` and its slot is
  freed, and Node checks every returned value against the same caps again before building any text.
- Screenshots older than 24 hours are deleted from `WEB_BROWSER_SCREENSHOT_DIR` whenever a new one is taken
  (only files with the plugin's generated names).
- Caps:
  - total time: `timeout_seconds` + 25 s, under the 90 s tool deadline
  - bytes downloaded: `WEB_BROWSER_MAX_DOWNLOAD_MB`
  - requests per page: 500
  - DOM snapshot: 30,000 nodes, 2 M text characters, 2 M attribute characters, depth 400
  - returned text: `max_chars`
  - links: `max_links` / `limit`
  - extracted values: 2,000 characters each, `max_matches` per field

**DNS rebinding:**
- **Covered:** browser traffic. The proxy pins each connection to the address it checked, so a DNS answer that
  changes between the check and the connection can't redirect the browser to an internal host.
- **Covered:** robots.txt requests, which also use a pinned connection.
- **Residual: Chromium's own background traffic** (component updates and similar). It does not go through the
  per-context proxy and is not under the plugin's control. It only talks to Chromium's own services.
- **Residual: `wss://` from a page that escapes the init script.** A `wss://` WebSocket is a TLS tunnel like
  any https request, so the proxy can only check its host (public hosts only), not refuse it. No way around
  the init script is known (it runs in every frame, popup and worker before page scripts); if one were found,
  the reachable hosts would still be public ones only.
- **Side effect of the worker wrapper:** inside a worker, `self.location` is a blob URL, so a worker script
  that loads further files by relative URL fails, and `URL.revokeObjectURL` takes effect after 30 s.
- **Residual: guard and proxy can see different answers.** The host check in step 1 and the route check can
  resolve to a different address than the one the proxy later uses. That's harmless, because only the
  proxy's address is ever contacted.
- **Not used:** `--host-resolver-rules` can map names, but it can't express "refuse private ranges", so it is
  not a fix.

**robots.txt** (on by default; turn off with `WEB_BROWSER_RESPECT_ROBOTS=0`):
- The plugin follows RFC 9309. Its product token is `graphrt-web-browser`; a `User-agent` line names it when
  the line's leading product name matches case-insensitively (`graphrt-web-browser/1.0` does). If no group
  names it, the `*` group applies. The longest matching rule wins, with `*` and `$` supported. Escaped
  unreserved characters are decoded before matching (`/%7Ejoe` equals `/~joe`).
- **Bounded work:** runs of `*` count as one; rules longer than 2 KB or with more than 32 `*` are ignored; a
  group keeps at most 2,000 rules (10,000 in all); one check may spend 1 M comparisons and is refused
  (disallowed) if it needs more.
- **2xx:** the rules apply.
- **4xx:** everything is allowed.
- **5xx and 429:** the whole site is disallowed for a minute.
- **Network failure:** the call fails with a retryable `network_error`.
- **Cache:** results are kept per origin for an hour, up to 100 origins.

**User agent:** a normal Chrome user agent with `graphrt-web-browser/0.2.1 (+https://github.com/Graphrt/graphrt-plugins)`
appended, so sites can identify the plugin. You can replace it with `WEB_BROWSER_USER_AGENT`.

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- About 150 MB of disk for Chromium

## Installation
```bash
cd web-browser
npm install
npx playwright install chromium
graphrt plugin install .
```
The plugin runs `node plugin.mjs` from its own directory, so `node_modules/` must sit next to it. A missing
Playwright or Chromium is reported as `setup_required`.

## Quick Start
```bash
graphrt run web-browser/example.yaml --plugins .
# Example Domain (200): This domain is for use in documentation examples ...
```

## Usage
```yaml
- { id: page, type: web-browser.fetch_page, url: "https://example.com/blog/post", include_markdown: true, max_chars: 8000 }
- { id: links, type: web-browser.get_links, url: "https://example.com/blog/", scope: same_host, pattern: "*/blog/20*" }
- { id: prices, type: web-browser.extract, url: "https://example.com/shop", fields: { title: "h1", prices: { selector: ".price", all: true }, next: { selector: "a.next", attribute: href } } }
- { id: shot, type: web-browser.screenshot, url: "https://example.com", full_page: true, max_height: 6000 }
```
- **Main content:**
  - **Which element:** the `<main>` / `[role=main]` element with the most text. If there is none, the
    `<article>` that holds at least half of all article text. Otherwise `<body>`.
  - **What's removed:** navigation, footers, asides, forms, buttons, dialogs, site headers without a heading, and
    landmarks or class/id names such as `navigation`, `banner`, `cookie`, `sidebar`, `advert`.
  - **Whole page:** pass `main_content_only: false` to get the whole body instead.
- **Pages that render with JavaScript:** use `wait_until: networkidle` or `wait_for_selector`. If the page never
  goes idle, the plugin returns what had loaded and adds a warning instead of failing.
- **Result extras:**
  - `blocked_requests` lists up to 20 requests the guards refused, such as trackers on private addresses.
  - `warnings` notes partial loads.
- **Agent tools:** all four operations are tools (`web-browser/fetch_page` and so on). They only read, apart from
  the screenshot file written into `WEB_BROWSER_SCREENSHOT_DIR`.

## Configuration
| Env var | Default | Description |
|---------|---------|-------------|
| `WEB_BROWSER_SCREENSHOT_DIR` | `~/.graphrt/web-browser/screenshots` | Where `screenshot` writes PNGs (created with mode 700; files are 600, names are generated) |
| `WEB_BROWSER_RESPECT_ROBOTS` | `1` | `0` ignores robots.txt |
| `WEB_BROWSER_IDLE_MINUTES` | `5` | Close the background browser after this many idle minutes |
| `WEB_BROWSER_MAX_PAGES` | `2` | Pages open at the same time (1–4); more calls wait |
| `WEB_BROWSER_MAX_DOWNLOAD_MB` | `15` | Bytes one operation may download in total (1–100) |
| `WEB_BROWSER_USER_AGENT` | *(Chrome UA + plugin token)* | Replaces the user agent (one line, max 300 characters) |
| `GRAPHRT_LIVE_VIEW_DIR` | *(unset)* | Set by a host that shows pages live (the graphrt desktop app): while an operation runs, its page is written there as a small JPEG (max 960×720, about 6 per second) and deleted when it ends. Frames stay on the machine and are never logged |

There is deliberately no setting that allows private hosts.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Not an http(s) URL, credentials in the URL, a file download, the download cap was spent before the page loaded, a bad selector, field spec or env value |
| `permission_denied` | The host (or a redirect target) is loopback, private, link-local, metadata or otherwise internal; robots.txt disallows the page |
| `not_found` | The host name does not resolve |
| `network_error` | Connection refused, reset or TLS failure; robots.txt could not be fetched (retryable) |
| `timeout` | Nothing loaded within `timeout_seconds`, `wait_for_selector` never matched, or the operation hit its deadline (retryable) |
| `setup_required` | Playwright or Chromium is not installed |
| `browser_error` | Chromium failed to start or a page step failed unexpectedly |
| `cancelled` | The run was cancelled; the page's context is closed at once |

HTTP error statuses (404, 500, …) are not errors: the page is returned with its `status`.

## Limitations
- No clicking, typing, logins or form submission in this version. They could be added later as node-only
  operations or behind an explicit opt-in.
- After a redirect chain, the browser requests the final URL once more itself. That request is host-checked
  by the proxy and its robots.txt was already checked, but if the server answers it with yet another redirect,
  robots.txt for that extra hop is checked only as it happens, and the page is then refused.
- `same_domain` means the page's host (without `www.`) and its subdomains. The plugin does not use the Public
  Suffix List.
- Content inside iframes, shadow DOM, images and canvas is not part of the text.
- The manifest asks for `secrets` and nodes accept an `access_token`, because of how the shared runner builds
  manifests for plugins that need network access. Neither is used.

## Development
```bash
npm test                                             # fakes and local sockets only: no browser starts
WEB_BROWSER_E2E=1 node --test test/e2e.test.mjs      # real Chromium against local test servers
```
The tests open 127.0.0.1 servers and make 127.0.0.1 "public" through the `allowedTestHosts` dependency. That
dependency exists only for tests and is never read from the environment. Servers on `::1` and UDP listeners
on `127.0.0.1`/`::1` stand for internal targets; the end-to-end tests run hostile pages (WebRTC, WebSockets
from every kind of worker, built-in tampering, a busy-looping page) and check that nothing reaches them.
- `lib/readable.mjs` holds the pure text, markdown and link functions over a DOM snapshot.
- `lib/page-snapshot.mjs` holds the fixed in-page readers.
- `lib/page-reader.mjs` runs them in an isolated world; `lib/snapshot-limits.mjs` re-checks their results.
- `lib/page-hardening.mjs` is the init script that removes WebRTC and WebSockets from pages and workers.
- `lib/egress-proxy.mjs` and `lib/request-guard.mjs` hold the network guards.

## License
Apache-2.0
