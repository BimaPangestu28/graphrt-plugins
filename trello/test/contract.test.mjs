import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition } from "../definition.mjs";

const TRELLO = "https://api.trello.com/1";
const API_KEY = "contract-api-key-0001";

// The contract runs on the unwrapped definition; the board and api_request guards are tested in trello.test.mjs.
describeRestPluginContract(restDefinition, {
  environment: { TRELLO_API_KEY: API_KEY },
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `OAuth oauth_consumer_key="${API_KEY}", oauth_token="${credential}"`),
  operations: {
    get_me: { args: { fields: "id,username" }, request: { method: "GET", url: `${TRELLO}/members/me`, query: { fields: "id,username" } }, response: { body: { id: "m1" } }, expect: { data: { id: "m1" } } },
    list_boards: { args: {}, request: { method: "GET", url: `${TRELLO}/members/me/boards`, query: { filter: "open" } } },
    get_board: { args: { board_id: "AbCd1234" }, request: { method: "GET", url: `${TRELLO}/boards/AbCd1234`, query: "absent" } },
    list_lists: { args: { board_id: "b1", filter: "all", fields: "name" }, request: { method: "GET", url: `${TRELLO}/boards/b1/lists`, query: { filter: "all", fields: "name" } } },
    list_board_cards: { args: { board_id: "b1" }, request: { method: "GET", url: `${TRELLO}/boards/b1/cards`, query: "absent" } },
    list_list_cards: { args: { list_id: "l1", fields: "name,due" }, request: { method: "GET", url: `${TRELLO}/lists/l1/cards`, query: { fields: "name,due" } } },
    get_card: { args: { card_id: "c/1" }, request: { method: "GET", url: `${TRELLO}/cards/c%2F1`, query: "absent" } },
    search: {
      args: { query: "label:urgent", board_ids: ["b1", "b2"], cards_limit: 20 },
      request: { method: "GET", url: `${TRELLO}/search`, query: { query: "label:urgent", modelTypes: "cards", idBoards: "b1,b2", cards_limit: "20" } },
    },
    list_card_actions: { args: { card_id: "c1" }, request: { method: "GET", url: `${TRELLO}/cards/c1/actions`, query: { filter: "commentCard" } } },
    list_card_checklists: { args: { card_id: "c1" }, request: { method: "GET", url: `${TRELLO}/cards/c1/checklists`, query: "absent" } },
    list_board_labels: { args: { board_id: "b1" }, request: { method: "GET", url: `${TRELLO}/boards/b1/labels`, query: "absent" } },
    list_board_members: { args: { board_id: "b1" }, request: { method: "GET", url: `${TRELLO}/boards/b1/members`, query: "absent" } },
    create_list: { args: { board_id: "b1", name: "Doing", list_position: "bottom" }, request: { method: "POST", url: `${TRELLO}/lists`, query: "absent", json: { idBoard: "b1", name: "Doing", pos: "bottom" } } },
    create_card: {
      args: { list_id: "l1", name: "Ship", description: "Release notes", due: "2026-12-01T09:00:00Z", member_ids: ["m1"], label_ids: ["lab1"], card_position: "top" },
      request: { method: "POST", url: `${TRELLO}/cards`, query: "absent", json: { idList: "l1", name: "Ship", desc: "Release notes", due: "2026-12-01T09:00:00Z", idMembers: ["m1"], idLabels: ["lab1"], pos: "top" } },
    },
    update_card: { args: { card_id: "c1", closed: true, list_id: "l2", due_complete: true, card_position: "2" }, request: { method: "PUT", url: `${TRELLO}/cards/c1`, query: "absent", json: { pos: "2", dueComplete: true, idList: "l2", closed: true } } },
    add_comment: { args: { card_id: "c1", text: "Done" }, request: { method: "POST", url: `${TRELLO}/cards/c1/actions/comments`, query: "absent", json: { text: "Done" } } },
    create_checklist: { args: { card_id: "c1", name: "QA", checklist_position: "top" }, request: { method: "POST", url: `${TRELLO}/cards/c1/checklists`, query: "absent", json: { name: "QA", pos: "top" } } },
    add_checklist_item: { args: { checklist_id: "k1", name: "Smoke test", checked: false, item_position: "bottom" }, request: { method: "POST", url: `${TRELLO}/checklists/k1/checkItems`, query: "absent", json: { name: "Smoke test", pos: "bottom", checked: false } } },
    update_checklist_item: { args: { card_id: "c1", check_item_id: "i1", state: "complete" }, request: { method: "PUT", url: `${TRELLO}/cards/c1/checkItem/i1`, query: "absent", json: { state: "complete" } } },
    add_label_to_card: { args: { card_id: "c1", label_id: "lab1" }, request: { method: "POST", url: `${TRELLO}/cards/c1/idLabels`, query: "absent", json: { value: "lab1" } } },
    add_member_to_card: { args: { card_id: "c1", member_id: "m1" }, request: { method: "POST", url: `${TRELLO}/cards/c1/idMembers`, query: "absent", json: { value: "m1" } } },
    delete_card: { args: { card_id: "c1" }, request: { method: "DELETE", url: `${TRELLO}/cards/c1`, query: "absent", body: "absent" } },
  },
});
