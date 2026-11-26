# Terms-of-Service risk audit

Checked on 2026-11-19 against the providers' current published terms. Each rating is recorded in
[`plugin-status.json`](../plugin-status.json) (`tos_risk`, `tos_notes`) and shown in the root README table, the
plugin READMEs and the release catalog. This is an engineering risk review, not legal advice.

**Ratings:** `none`: used as the provider intends. `low`: official API with content, spam or personal-data rules that
careless use can break. `medium`: the provider's automation or data-protection rules restrict what agents commonly
do. `high`: the access itself is against the terms, or the terms forbid the automation the plugin enables. Accounts can
be banned.

Where a source could not be fetched directly (JavaScript-only portals, geo-blocked pages), the entry says
**unverified**. Re-check those by hand before relying on them.

## Summary

| Plugin | Risk | Main issue | Official alternative |
|--------|------|------------|----------------------|
| google-maps-scraper | **high** | Scraping Google Maps; the Maps terms bar building listing or telemarketing lists | `google-maps-platform` |
| whatsapp-web | **high** | Unofficial client of a personal account; automated access is banned | `whatsapp-api` |
| fonnte | **high** | Unofficial, WhatsApp Web based gateway | `whatsapp-api`, `qontak` |
| wablas | **high** | QR-linked device mode is an unofficial gateway | `whatsapp-api`, `qontak` |
| linkedin-api | **high** | API Terms forbid using the APIs to automate posting | none (human approval per post) |
| computer-control | medium | Driving WhatsApp Desktop is the same automated access WhatsApp forbids | `whatsapp-api` |
| x-api | medium | Automation Rules: consent for automated replies and DMs, no keyword auto-replies | — |
| tiktok-api | medium | Unaudited apps post SELF_ONLY; per-post consent UX required | — |
| apollo, hunter | medium | Personal-data enrichment: GDPR and UU PDP 27/2022 | — |
| threads-api, meta-api, youtube-api, youtube-transcript, web-browser, web-search | low | Spam, consent and scraping rules | — |
| shopee-api, tiktok-shop-api, lazada | low | Partner programme requirements | — |
| upwork | low | Agents act on a real Upwork account; Upwork meters searches and writes | — (it is Upwork's own MCP server) |
| whatsapp-api, qontak, twilio, vonage, email senders, chat bots | low | Opt-in and anti-spam rules | — |

## google-maps-scraper
- **Risk: high.**
- **Clauses:**
  - [Google Terms of Service](https://policies.google.com/terms) forbid "using automated means to access content from
    any of our services in violation of the machine-readable instructions on our web pages (for example, robots.txt)"
    and bypassing protective measures. Google may suspend access for scraping.
  - [Google Maps/Google Earth Additional Terms](https://maps.google.com/help/terms_maps) (modified 2026-01-27): no
    "mass download or create bulk feeds of the content" (§2.3), and no use of Maps to build a "business listings
    database, mailing list, or telemarketing list" (§2.4). Collecting business phone numbers into a lead list matches
    §2.4 almost word for word.
- **Official alternative:** the Places API in [`google-maps-platform`](../google-maps-platform/). The
  [Maps Platform Terms](https://cloud.google.com/maps-platform/terms) also restrict caching and scraping (place IDs may
  be stored). **Unverified:** the page came back truncated, so the exact caching periods were not confirmed.
- **Mitigation in the plugin:** a README warning, `max_results` defaulting to 20 (capped at 100), and a `blocked` error when a CAPTCHA
  appears. It does not try to get around blocks.
- **Missing:** no per-day volume cap. The warning now names the official plugin.

## whatsapp-web
- **Risk: high.**
- **Clauses:**
  - [WhatsApp Terms of Service](https://www.whatsapp.com/legal/terms-of-service) forbid "bulk messaging,
    auto-messaging, auto-dialing, and the like". They also forbid accessing or using the Services "through automated
    or other means" without authorization. WhatsApp may suspend or terminate accounts at any time.
  - WhatsApp's [unofficial apps FAQ](https://faq.whatsapp.com/1217634902127718/) says unofficial apps violate the
    terms. Accounts may be temporarily or permanently banned.
- **Mitigation in the plugin:**
  - A README warning that names `whatsapp-api`.
  - Sends are spaced at least 30 s apart by default, with a persistent daily cap. Sending is blocked if the counter is
    corrupt.
  - Sends are never retried.
- **Missing:** nothing technical makes it compliant. It stays experimental and is for low-volume personal use only.

## computer-control
- **Risk: medium.** Generic macOS app control is fine. Driving WhatsApp Desktop (the `whatsapp_desktop_send`
  recipe) is the same "automated or other means" that WhatsApp's terms forbid. The terms make no distinction between
  UI automation and a headless browser.
- **Mitigation in the plugin:** an app allowlist is required. `whatsapp_desktop_send` is a workflow node only, never
  an agent tool, and every check fails closed.
- **Missing:** no per-day send cap for the WhatsApp recipe. The safer course is to use `whatsapp-api` for anything
  beyond occasional personal sends.

## web-browser
- **Risk: low.**
- **Rules:**
  - robots.txt is not a contract in itself, but some sites write it into their terms (Google does).
  - Each site's own terms apply, and logging in means accepting them.
  - In hiQ v. LinkedIn, the court found in 2022 that hiQ breached LinkedIn's User Agreement by scraping, and the case
    settled. This is from secondary reporting and was not re-verified.
- **Mitigation in the plugin:** it is read-only (no clicking, typing or logins) and reaches public hosts only. It
  respects robots.txt by default (`WEB_BROWSER_RESPECT_ROBOTS`).
- **Missing:** no per-host rate limit beyond one page per call.

## youtube-transcript and youtube-api
- **Risk: low.**
- **Clauses:** the [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
  require that you "must not … scrape" (§III.E.6). They also bar using "any technology other than YouTube API
  Services to access or retrieve API Data" (§III.I.14) and using undocumented APIs (§III.D.7).
  [`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download) "requires the user to have
  permission to edit the video".
- **Mitigation in the plugin:** youtube-transcript uses only `captions.list` and `captions.download`. It answers
  `permission_denied` for videos the user can't edit and explains why it does not scrape `timedtext`. `parse_captions`
  works only on files the user already has. youtube-api uses the Data API only.

## x-api
- **Risk: medium.**
- **Clauses:**
  - The [X Developer Policy](https://docs.x.com/developer-terms/policy) says write actions "must follow the
    Automation Rules". You must "Always get explicit consent before sending people automated replies or Direct
    Messages", and "A person authenticating into your service does not by itself constitute consent". It forbids
    "bulk, aggressive, or spammy actions" and circumventing rate limits.
  - [X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation): no automated posting about trending
    topics, and no automated replies based on keyword searches alone. **Unverified:** the page returned 403, so this
    wording comes from search snippets.
- **Mitigation in the plugin:**
  - Official API v2 only.
  - It honours `x-rate-limit-reset`.
  - Token refresh is node only.
  - x-api 0.2.0: agent tools need `X_TOOL_ALLOW_POST=1` for posts, replies, quotes and reposts,
    `X_TOOL_ALLOW_ENGAGE=1` for likes and hiding replies, and `X_TOOL_ALLOW_DM=1` plus every recipient in
    `X_TOOL_RECIPIENT_ALLOWLIST` (exact user or conversation ids) for DMs. `delete_post` is node only.
- **Missing:** the agent opt-ins are **fixed** in x-api 0.2.0. The Automation Rules (no keyword auto-replies, no
  trend posting) still depend on how the user configures the agent.

## linkedin-api
- **Risk: high** (official API, but the terms forbid the use an agent plugin invites).
- **Clauses:**
  - The [LinkedIn API Terms of Use](https://www.linkedin.com/legal/l/api-terms-of-use) (revised 2022-12-13) say you
    may not "use the Content or the APIs to automate posting on the LinkedIn Services" (§3.1(26)). They also forbid
    scraping (§3.1(24)), caching or storing Content (§4.1), and using data for anything other than letting your users
    use it (§3.1(9)). Legally valid consent is required (§5.2).
  - The [User Agreement](https://www.linkedin.com/legal/user-agreement) (§8.2) bars bots or other unauthorized
    automated methods that "send or redirect messages, create, comment on, like, share, or re-share posts".
  - **Unverified:** the Community Management API restrictions page returned 404.
- **Mitigation in the plugin:**
  - Official REST API only.
  - It uses no browser automation and stores nothing.
  - The README now has a warning box.
  - linkedin-api 0.2.0: agent tools need `LINKEDIN_TOOL_ALLOW_POST=1` to create or edit posts and comments and
    `LINKEDIN_TOOL_ALLOW_ENGAGE=1` for reactions; deletes are node only.
- **Missing:** the agent opt-ins are **fixed** in linkedin-api 0.2.0. The terms still forbid automated posting even
  with the opt-in, so have a person write or approve every post, for example with a human-approval step before the
  node. There is no more permissive official alternative.

## tiktok-api
- **Risk: medium.**
- **Clauses:**
  - The [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines) limit unaudited
    API clients to `SELF_ONLY` posts, for up to 5 users per 24 h.
  - Audited apps must show a preview and the creator's nickname, and need explicit user agreement. The privacy level
    must be chosen manually, with no default. Interaction toggles start off and commercial content must be disclosed.
    The limit is about 15 posts per day per creator.
  - The [Developer Terms](https://www.tiktok.com/legal/page/global/tik-tok-developer-terms-of-service/en) (modified
    2025-12-26) bar robots that collect user information, bypassing access restrictions, and spam.
  - **Unverified:** the Business API terms (comments and DMs).
- **Mitigation in the plugin:**
  - Official Open API and Business API.
  - `PULL_FROM_URL` needs a verified domain.
  - Token refresh is node only.
- **Agent policy (tiktok-api 0.3.0, fixed):** direct posts, comments and replies need `TIKTOK_TOOL_ALLOW_POST=1` as
  agent tools; inbox drafts (finished by the creator in the app) stay free. Comment moderation and likes need
  `TIKTOK_TOOL_ALLOW_ENGAGE=1`, DMs need `TIKTOK_TOOL_ALLOW_DM=1`, and `delete_comment` is node only.
- **Missing:** unattended posting still doesn't fit the per-post consent UX. Prefer inbox drafts for agents and keep a
  human confirmation step before `publish_*` nodes. The plugin is also experimental because the Business API field names are unverified.

## threads-api and meta-api
- **Risk: low.**
- **Clauses:**
  - The [Meta Platform Terms](https://developers.facebook.com/terms) (updated 2026-02-03) limit Platform Data to
    permitted purposes, with no selling or licensing.
  - The [Developer Policies](https://developers.facebook.com/devpolicy): get consent before publishing on someone's
    behalf (§1.7), no spam or bots acting at very high frequency (§5.6.b), and honour stop-messaging requests (§5.2.b).
  - [Messenger policy](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview): a 24 h
    standard messaging window, with message tags only for approved uses.
  - The [Threads API](https://developers.facebook.com/docs/threads/overview) allows 250 API posts and 1,000 replies
    per profile per 24 h.
- **Mitigation in the plugin:**
  - meta-api documents the 24 h window and the `HUMAN_AGENT` tag, and retries using Meta's regain-access estimate.
  - Both plugins use official Graph APIs only.
- **Missing:** **fixed** for threads-api 0.3.0: publishing, replies and reposts need `THREADS_TOOL_ALLOW_POST=1` as
  agent tools, reply moderation needs `THREADS_TOOL_ALLOW_ENGAGE=1`, and `delete_thread` is node only.
  meta-api 0.2.0 (**fixed**): publishing and comment replies need `META_TOOL_ALLOW_POST=1`, comment moderation and
  likes need `META_TOOL_ALLOW_ENGAGE=1`, `send_message` needs `META_TOOL_ALLOW_DM=1` and the recipient in
  `META_TOOL_RECIPIENT_ALLOWLIST`, and deletes are node only.

## Marketplaces: shopee-api, tiktok-shop-api, lazada
- **Risk: low** (official, partner-gated APIs). All three portals render with JavaScript only, so the terms text was
  **unverified**. The points below come from the platforms' public developer guides and integrator notes.
  - **Shopee Open Platform:** a registered developer app (Partner ID and key), seller authorization (renewed about
    yearly), and the [Data Protection Policy](https://open.shopee.com/developer-guide/32) and
    [Partner Rules](https://open.shopee.com/developer-guide/34).
  - **TikTok Shop Partner Center:** register as a partner, pass app review and request only the scopes you need
    ([partner.tiktokshop.com](https://partner.tiktokshop.com)).
  - **Lazada Open Platform:** accept the Developer Agreement at sign-up. A "Seller In-house APP" is reviewed before
    use ([open.lazada.com](https://open.lazada.com)).
- **Mitigation in the plugins:**
  - Signed official APIs.
  - Price, stock and shipping writes and token refresh are node only.
  - `api_request` is GET-only for tools.
- **Missing:** none for ToS. All three are experimental because their request signing has never been accepted by a
  live account.

## upwork
- **Risk: low.** The plugin points the desktop app at Upwork's own MCP server (`https://mcp.upwork.com/mcp`),
  the access Upwork offers for agents, signed in with the user's account over OAuth.
- **Clauses:** Upwork publishes its MCP terms and current rate limits at <https://www.upwork.com/ai/mcp>. That page
  refuses automated fetchers (HTTP 403), so it was **not read** for this audit: read it before automating. What the
  server itself enforces, from Upwork's agent plugin skills: write tools return a preview to confirm, money and
  legally binding steps (offers, milestones) are never completed by the server (it returns a `finalize_url`), and
  searches, profile reads and writes are metered (`retry_after_seconds`).
- **Mitigation in the plugin:** only `find_*`, `get_*`, `list_*` and `search_*` tools run without asking (and never
  one whose name says it sends); the builder guide asks for an approval before `confirm_preview`, one focused
  search per run, no write loops, and never inventing facts or amounts.

## Prospecting and enrichment: apollo, hunter (and zerobounce)
- **Risk: medium** (apollo, hunter); **low** (zerobounce).
- **Clauses:**
  - [Apollo terms](https://www.apollo.io/terms): no reselling or disclosing its data (§3(d)(2)), no use that violates
    marketing laws such as CAN-SPAM, CASL or the TCPA (§3(d)(4)), and no bots or scraping (§3(f)(4)). You are solely
    responsible for the lawfulness of your use (§6(c)).
  - [Hunter terms](https://hunter.io/terms-of-service): you are an independent controller under the GDPR (§11).
    Abusive or excessive API use can be suspended (§4).
  - **GDPR:** a lawful basis is needed, usually legitimate interest under
    [Art. 6(1)(f)](https://gdpr-info.eu/art-6-gdpr/) with a documented balancing test.
    [Art. 14](https://gdpr-info.eu/art-14-gdpr/) requires telling people the source of their data, the purposes and
    their rights within one month, or at the first message.
  - **Indonesia, [UU PDP No. 27/2022](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022):** fully
    enforceable since 17 Oct 2024 (Pasal 74).
    - It needs a lawful basis (Pasal 20), such as explicit consent or a legitimate interest.
    - It grants rights of access, erasure and objection.
    - Administrative fines reach 2% of annual revenue (Pasal 57).
    - Unlawfully collecting someone else's personal data carries up to 5 years and Rp5 billion (Pasal 67).
  - **ZeroBounce:** acts as a processor and offers a DPA and an EU host. The DPA page was read from a search snippet
    only (**unverified**).
- **Mitigation in the plugins:**
  - Credit-consuming calls are never retried.
  - Bulk enrichment and contact or lead writes need opt-ins (`APOLLO_TOOL_ALLOW_BULK_ENRICHMENT`,
    `APOLLO_TOOL_ALLOW_CONTACT_WRITES`, `HUNTER_TOOL_ALLOW_LEAD_WRITES`).
  - Sequences, phone reveal with webhooks, and deletes are node only.
  - zerobounce supports the EU host.
- **Missing:** compliance sits with the user. Record a lawful basis, include an Art. 14 notice with an opt-out in the
  first outreach email, and honour erasure requests. The plugins can't enforce this.

## Bulk WhatsApp gateways (fonnte, wablas)
- **Risk: high.** Both are unofficial gateways.
- **Findings:**
  - **Fonnte** ([fonnte.com](https://fonnte.com)) states that it is an unofficial service ("Layanan fonnte merupakan
    layanan unofficial") that works through WhatsApp Web. It warns that mass sending will most likely get the number
    banned and that "apapun yang dilakukan, resiko banned tetap ada" (whatever you do, the ban risk remains). It also
    says it is not responsible for bans.
  - **Wablas** ([wablas.com](https://wablas.com)) offers two products. One links "your whatsapp account" by scanning a
    QR code (unofficial). The other resells the official Cloud API. No Meta Business Solution Provider status was
    found. This plugin uses the device (QR) API.
  - Both break [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service) on automated or
    unauthorized access and bulk or auto-messaging. The
    [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy) requires opt-in permission and
    approved templates outside the 24 h window.
- **Mitigation in the plugins:**
  - Agent sends need `*_TOOL_ALLOW_SEND=1` and an exact-number `*_TOOL_RECIPIENT_ALLOWLIST`.
  - Group sends are node only.
  - Sends are never retried.
  - The READMEs now have a warning box that names `whatsapp-api` and `qontak`.
- **Missing:** no per-minute send cap of their own. Fonnte and Wablas pace sends on their side (Wablas allows 200
  requests per minute).

## Official WhatsApp: whatsapp-api, qontak, twilio, vonage
- **Risk: low.**
- **Rules:** the [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy) requires opt-in. Automation
  is allowed inside the 24 h window with a route to a human, and templates are needed outside it. Qontak markets
  itself as an official WhatsApp BSP and Meta Business Partner
  ([qontak.com](https://qontak.com/en/features/whatsapp-bsp/)). This was not checked against Meta's partner
  directory.
- **Rate limits (whatsapp-api):** Meta's current limits are documented in the
  [whatsapp-api README](../whatsapp-api/README.md#rate-limits):
  - **Messaging limit:** 250, 2,000, 10,000, 100,000 or unlimited users per 24 h, shared per business portfolio.
  - **Throughput:** 80 messages/s per number (up to 1,000/s).
  - **Pair rate limit:** one message every 6 s to the same user (131056).
  - **Spam rate limit:** 131048.
- **Mitigation:**
  - whatsapp-api 0.3.0 adds a per-process limiter for agent tool sends: `WHATSAPP_TOOL_SEND_RATE_LIMIT` per minute
    (default 20, `0` turns it off), plus the 6 s pair spacing.
  - whatsapp-api 0.4.0: agent tool sends of every message type (text, replies, templates, media, location,
    interactive messages and reactions) need `WHATSAPP_TOOL_ALLOW_SEND=1` and the recipient in
    `WHATSAPP_TOOL_RECIPIENT_ALLOWLIST` (exact E.164 numbers, or `+digits*` prefixes of at least 4 digits; unset
    refuses every agent send). `mark_as_read` stays free. Deletes are node only. `update_business_profile` needs
    `WHATSAPP_TOOL_ALLOW_PROFILE=1` and `create_template` needs `WHATSAPP_TOOL_ALLOW_TEMPLATES=1`.
  - qontak, twilio and vonage tool sends need an opt-in and a recipient allowlist.
- **Missing:** nothing for agent sends (**fixed** in whatsapp-api 0.4.0). Recipients' opt-in to the business is
  still the user's responsibility.

## Everything else
The other plugins use official APIs as the providers intend: databases, storage, AI models, developer tools,
payments, CRMs, local tools and public data. Their rating is `none`, or `low` where sending email or messages is
covered by anti-spam rules (gmail-api, microsoft-graph, email, brevo, mailchimp, sendgrid, resend, slack, discord,
telegram-bot, line-messaging, microsoft-teams) or the output is subject to ad and content policies (meta-ads,
tiktok-ads, google-ads, google-business-profile-api). Public data sources ask for attribution (BMKG, CoinGecko,
Open-Meteo) or a descriptive User-Agent (Wikipedia, which the plugin sends). web-search results come under the
provider's terms; SerpAPI itself scrapes search engines and takes on that risk.
