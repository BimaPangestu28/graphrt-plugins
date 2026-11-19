# trello

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Trello REST API](https://developer.atlassian.com/cloud/trello/rest/)
(v1). It reads boards, lists, cards, comments, checklists, labels and members, and creates and updates lists,
cards, comments and checklists. Every operation is a workflow node; reads and (board-limited) writes are also agent
tools. Built with the declarative REST layer ([docs/declarative-plugins.md](../docs/declarative-plugins.md)).

## Features
- **Reads:** `get_me`, `list_boards`, `get_board`, `list_lists`, `list_board_cards`, `list_list_cards`, `get_card`,
  `search` (Trello search operators such as `label:urgent due:week`), `list_card_actions` (comments by default),
  `list_card_checklists`, `list_board_labels`, `list_board_members`
- **Writes:** `create_list`, `create_card`, `update_card` (rename, describe, dates, move between lists, members,
  labels, archive with `closed: true`), `add_comment`, `create_checklist`, `add_checklist_item`,
  `update_checklist_item` (check/uncheck), `add_label_to_card`, `add_member_to_card`
- **Node only:** `delete_card`
- **`api_request`:** any other endpoint under `https://api.trello.com/1` (agent tools: GET on an allowlist of read paths)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Trello account and a Power-Up/API key

## Installation
```bash
graphrt plugin install ./trello
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Meaning |
|---|---|---|
| `TRELLO_API_KEY` | yes | The API key of your Power-Up |
| `TRELLO_TOKEN` | yes | A user token for that key (a node's `access_token` overrides it) |
| `TRELLO_TOOL_BOARD_ALLOWLIST` | for agent writes | Comma-separated board ids agent tools may write to, or `*` for any board |

**Getting credentials:** create a Power-Up at <https://trello.com/power-ups/admin>, open its *API key* tab and
generate the key. On the same page, follow the *Token* link (or open
`https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<KEY>`) and approve it
to get a token. Use `scope=read` for a read-only token. A board id is the `id` returned by `get_board` (the short
link from the board URL also works as `board_id` for reads, but the allowlist compares full ids).

The key and token are sent in Trello's documented `Authorization: OAuth oauth_consumer_key="…", oauth_token="…"`
header, never in URLs, and both are redacted from errors and results.

**Rate limits:** 300 requests per 10 s per key, 100 per 10 s per token, and 100 per 900 s on `/1/members/`. A
429 (`API_TOKEN_LIMIT_EXCEEDED` / `API_KEY_LIMIT_EXCEEDED`) is reported as `rate_limited`. The API is free.

## Quick Start
```bash
TRELLO_API_KEY=... TRELLO_TOKEN=... graphrt run trello/example.yaml --plugins .
```
The example lists your open boards and the lists of the first one.

## Usage
```yaml
- id: card
  type: trello.create_card
  list_id: "{{#start.list_id#}}"
  name: "Follow up with {{#start.customer#}}"
  due: "2026-12-01T09:00:00Z"
- id: note
  type: trello.add_comment
  card_id: "{{#card.data.id#}}"
  text: "Created by the intake workflow"
```
- `data` is Trello's JSON: an object for single resources, an array for lists. Use `fields` to keep results small.
- `description` maps to Trello's `desc`, and `list_position`, `card_position`, `checklist_position` and `item_position` to `pos`; `member_ids` and `label_ids` to `idMembers` and
  `idLabels`.
- Trello has no pagination on these endpoints; `search` returns at most `cards_limit` cards (default 10).

## Agent policy
- Reads are tools.
- Writes are tools only on boards in `TRELLO_TOOL_BOARD_ALLOWLIST`; while it is unset, tool writes are refused. A
  public or shared board is a place where an agent could copy private data, so the plugin reads the target's
  board first (`/cards/{id}`, `/lists/{id}` or `/checklists/{id}` with `fields=idBoard`) and refuses other boards.
  Moving a card checks both the card's board and the destination list's board.
- `delete_card` is node only. Inviting people to a board is not offered (use a workflow node with `api_request`).
- `api_request` as a tool is GET-only and limited to boards, lists, cards, checklists, labels, actions,
  organizations, search and members; token, webhook and application paths are refused.
- Workflow nodes are not limited.

## Errors
Trello answers errors in plain text (`invalid token`, `unauthorized permission requested`) or as
`{"message", "error"}`. 401 is `auth_error`, 403 `permission_denied`, 404 `not_found`, 429 `rate_limited`. Writes
are never retried after a timeout or 5xx; the error says how to check whether the write happened.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite on every operation; `test/trello.test.mjs` covers the
auth header, the board allowlist and the api_request allowlist. Not verified with a real Trello account; the live
check used invalid credentials and got a clean `auth_error`.

## License
Apache-2.0
