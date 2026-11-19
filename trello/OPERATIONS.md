# trello operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `trello.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_me` | The member who owns the token | fields |
| `list_boards` | Boards of the current member | filter, fields |
| `get_board` | One board | **board_id**, fields |
| `list_lists` | Lists (columns) of a board | **board_id**, filter, fields |
| `list_board_cards` | Open cards of a board | **board_id**, fields |
| `list_list_cards` | Cards in one list | **list_id**, fields |
| `get_card` | One card | **card_id**, fields |
| `search` | Search cards (and optionally boards) by text, with Trello's search operators (e.g. label:urgent due:week) | **query**, model_types, board_ids, cards_limit, partial |
| `list_card_actions` | Actions on a card; by default its comments (filter commentCard), newest first | **card_id**, filter |
| `list_card_checklists` | Checklists of a card with their items | **card_id** |
| `list_board_labels` | Labels defined on a board | **board_id** |
| `list_board_members` | Members of a board (ids for card assignment) | **board_id** |
| `create_list` | Add a list (column) to a board (agent tools: only on boards in TRELLO_TOOL_BOARD_ALLOWLIST) | **board_id**, **name**, list_position |
| `create_card` | Create a card in a list (agent tools: only on boards in TRELLO_TOOL_BOARD_ALLOWLIST) | **list_id**, **name**, description, card_position, due, start, due_complete, member_ids, label_ids |
| `update_card` | Change a card's name, description, dates, list (move within the board), members or labels, or archive it (closed: true) (agent tools: only on boards in TRELLO_TOOL_BOARD_ALLOWLIST) | **card_id**, name, description, card_position, due, start, due_complete, member_ids, label_ids, list_id, closed |
| `add_comment` | Comment on a card (board members may be notified of @mentions) (agent tools: only on boards in TRELLO_TOOL_BOARD_ALLOWLIST) | **card_id**, **text** |
| `create_checklist` | Add a checklist to a card (agent tools: only on boards in TRELLO_TOOL_BOARD_ALLOWLIST) | **card_id**, **name**, checklist_position |
| `add_checklist_item` | Add an item to a checklist (agent tools: only on boards in TRELLO_TOOL_BOARD_ALLOWLIST) | **checklist_id**, **name**, item_position, checked, due |
| `update_checklist_item` | Check or uncheck a checklist item, or rename it (agent tools: only on boards in TRELLO_TOOL_BOARD_ALLOWLIST) | **card_id**, **check_item_id**, state, name |
| `add_label_to_card` | Add one of the board's labels to a card (agent tools: only on boards in TRELLO_TOOL_BOARD_ALLOWLIST) | **card_id**, **label_id** |
| `add_member_to_card` | Assign a board member to a card (the member must already be on the board) (agent tools: only on boards in TRELLO_TOOL_BOARD_ALLOWLIST) | **card_id**, **member_id** |
| `delete_card` | Delete a card permanently (archive it with update_card closed: true instead) | **card_id** |
| `api_request` | Call any Trello REST API endpoint that has no dedicated operation, e.g. path "/boards/{board_id}/actions". Only the API's own host is allowed. Agent tools may only read boards, lists, cards, checklists, labels, actions, organizations, search and members (no tokens, webhooks or applications, and no tokens or webhooks query keys). | method, **path**, query, body |
