# upwork

**Status:** beta · **ToS risk:** low. Upwork's official MCP server with OAuth sign-in; discovery checked live, sign-in and tools not yet tested end to end with a real account. See [plugin status](../README.md#plugin-status).

> **Warning:** agents act on your real Upwork account. Every action that changes something on Upwork
> (proposals, messages, job posts, offers) asks you first, and payments and contracts are always finished
> by you on upwork.com. Upwork limits how often searches and writes may run: read its MCP terms and
> limits at https://www.upwork.com/ai/mcp before automating.

## Overview
An **MCP server preset** (`runtime: mcp`): the plugin ships no code. Installing it adds Upwork's official
[MCP server](https://www.upwork.com/ai/mcp) (`https://mcp.upwork.com/mcp`, Streamable HTTP) to the graphrt
desktop app's Connections > MCP servers, where you sign in with your own Upwork account (OAuth in the
browser). Agents then use its tools as `upwork/<tool>`. Removing the plugin signs you out (the tokens are
revoked) and removes the server.

It works for freelancers (find jobs, write proposals, answer offers) and for clients (post jobs, find
freelancers, review proposals, invite, prepare offers). The server describes its own tools; there are about
30, listed in the desktop app after you sign in.

## Features
- **Approvals:** only tools named `find_*`, `get_*`, `list_*` or `search_*` run without asking (and never one
  whose name says it sends). Every other tool asks you first. You can let a single tool run on its own in
  Connections > MCP servers > Approvals.
- **Builder guide** ([`guide.md`](guide.md)): how agents select the account, read before writing, go through
  Upwork's preview then `confirm_preview`, show every `finalize_url`, and never invent facts or amounts.
- **Templates** on the New agent screen: morning jobs with proposal drafts (freelancer), review applicants
  (client), write a job post (client).

## Prerequisites
- The graphrt desktop app (it runs the OAuth sign-in and the MCP client). The graphrt CLI accepts the
  plugin (`graphrt plugin install`) but does not connect MCP presets yet.
- An Upwork account.

## Installation
Install **Upwork** from the Plugins page, then open Connections > MCP servers and press **Sign in to upwork**.

## Configuration
No settings. The sign-in happens in your browser; the tokens are kept in the OS keychain.

## License and attribution
The guide and the templates are adapted from the [Upwork Agent Plugin](https://github.com/upwork/upwork-agent-plugin)
(Apache-2.0, Copyright Upwork Inc.): see [`NOTICE`](NOTICE), [`LICENSE`](LICENSE) and the unmodified copies in
[`upstream/`](upstream/). "Upwork" is a trademark of Upwork Inc.; this plugin is not made or endorsed by Upwork.
