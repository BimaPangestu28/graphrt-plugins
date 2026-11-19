import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MESSAGE_SELECT = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview,conversationId,webLink";
const EVENT_SELECT = "id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeeting,webLink,showAs";
const page = (items) => ({ body: { value: items, "@odata.nextLink": `${GRAPH}/me/messages?$skip=25` } });

describeRestPluginContract(pluginDefinition, {
  operations: {
    get_me: { args: {}, request: { method: "GET", url: `${GRAPH}/me`, query: "absent" }, response: { body: { id: "u1", mail: "ada@example.com" } } },
    list_users: {
      args: { filter: "startswith(displayName,'Ada')", select: ["id", "mail"], limit: 5 },
      request: { method: "GET", url: `${GRAPH}/users`, query: { $filter: "startswith(displayName,'Ada')", $select: "id,mail", $top: "5" } },
      response: { body: { value: [{ id: "u2" }] } },
      expect: { data: [{ id: "u2" }] },
    },
    get_user: { args: { user_id: "ada@example.com" }, request: { method: "GET", url: `${GRAPH}/users/ada%40example.com`, query: "absent" } },
    list_mail_folders: { args: {}, request: { method: "GET", url: `${GRAPH}/me/mailFolders`, query: { $top: "25" } }, response: { body: { value: [{ id: "f1", displayName: "Inbox" }] } } },
    list_messages: {
      args: { filter: "isRead eq false", order_by: "receivedDateTime desc", limit: 10 },
      request: { method: "GET", url: `${GRAPH}/me/messages`, query: { $filter: "isRead eq false", $orderby: "receivedDateTime desc", $select: MESSAGE_SELECT, $top: "10" } },
      response: page([{ id: "m1", subject: "Invoice" }]),
      expect: { data: [{ id: "m1", subject: "Invoice" }] },
    },
    list_folder_messages: {
      args: { folder_id: "inbox" },
      request: { method: "GET", url: `${GRAPH}/me/mailFolders/inbox/messages`, query: { $select: MESSAGE_SELECT, $top: "25" } },
      response: { body: { value: [] } },
    },
    get_message: {
      args: { message_id: "AAMkAD=", body_format: 'outlook.body-content-type="text"' },
      request: { method: "GET", url: `${GRAPH}/me/messages/AAMkAD%3D`, query: "absent", headers: { prefer: 'outlook.body-content-type="text"' } },
    },
    send_mail: {
      args: { to: ["ada@example.com"], cc: ["bob@example.org"], subject: "Report", body: "<p>Attached</p>", body_type: "html" },
      request: {
        method: "POST",
        url: `${GRAPH}/me/sendMail`,
        query: "absent",
        json: {
          message: {
            subject: "Report",
            body: { contentType: "HTML", content: "<p>Attached</p>" },
            toRecipients: [{ emailAddress: { address: "ada@example.com" } }],
            ccRecipients: [{ emailAddress: { address: "bob@example.org" } }],
          },
          saveToSentItems: true,
        },
      },
      response: { status: 202 },
    },
    create_draft: {
      args: { to: ["ada@example.com"], subject: "Draft", body: "Hello" },
      request: { method: "POST", url: `${GRAPH}/me/messages`, query: "absent", json: { subject: "Draft", body: { contentType: "Text", content: "Hello" }, toRecipients: [{ emailAddress: { address: "ada@example.com" } }] } },
      response: { status: 201, body: { id: "d1", isDraft: true } },
    },
    send_draft: { args: { message_id: "d1" }, request: { method: "POST", url: `${GRAPH}/me/messages/d1/send`, query: "absent", body: "absent" }, response: { status: 202 } },
    reply_to_message: {
      args: { message_id: "m1", reply_kind: "replyAll", comment: "Thanks, all" },
      request: { method: "POST", url: `${GRAPH}/me/messages/m1/replyAll`, query: "absent", json: { comment: "Thanks, all" } },
      response: { status: 202 },
    },
    update_message: {
      args: { message_id: "m1", is_read: true, flag_status: "flagged" },
      request: { method: "PATCH", url: `${GRAPH}/me/messages/m1`, query: "absent", json: { isRead: true, flag: { flagStatus: "flagged" } } },
    },
    move_message: { args: { message_id: "m1", destination_id: "archive" }, request: { method: "POST", url: `${GRAPH}/me/messages/m1/move`, query: "absent", json: { destinationId: "archive" } } },
    delete_message: { args: { message_id: "m1" }, request: { method: "DELETE", url: `${GRAPH}/me/messages/m1`, query: "absent", body: "absent" }, response: { status: 204 } },
    list_calendars: { args: {}, request: { method: "GET", url: `${GRAPH}/me/calendars`, query: { $top: "25" } }, response: { body: { value: [] } } },
    list_events: {
      args: { order_by: "start/dateTime" },
      request: { method: "GET", url: `${GRAPH}/me/events`, query: { $orderby: "start/dateTime", $select: EVENT_SELECT, $top: "25" } },
      response: { body: { value: [] } },
    },
    calendar_view: {
      args: { start_date_time: "2026-12-01T00:00:00Z", end_date_time: "2026-12-08T00:00:00Z" },
      request: { method: "GET", url: `${GRAPH}/me/calendarView`, query: { startDateTime: "2026-12-01T00:00:00Z", endDateTime: "2026-12-08T00:00:00Z", $select: EVENT_SELECT, $top: "25" } },
      response: { body: { value: [{ id: "e1" }] } },
      expect: { data: [{ id: "e1" }] },
    },
    get_event: { args: { event_id: "e1" }, request: { method: "GET", url: `${GRAPH}/me/events/e1`, query: "absent" } },
    create_event: {
      args: { subject: "Focus time", start_date_time: "2026-12-01T09:00:00", start_time_zone: "Asia/Jakarta", end_date_time: "2026-12-01T11:00:00", end_time_zone: "Asia/Jakarta", show_as: "busy" },
      request: {
        method: "POST",
        url: `${GRAPH}/me/events`,
        query: "absent",
        json: { subject: "Focus time", start: { dateTime: "2026-12-01T09:00:00", timeZone: "Asia/Jakarta" }, end: { dateTime: "2026-12-01T11:00:00", timeZone: "Asia/Jakarta" }, showAs: "busy" },
      },
      response: { status: 201, body: { id: "e2" } },
    },
    update_event: {
      args: { event_id: "e2", location: "Room 4" },
      request: { method: "PATCH", url: `${GRAPH}/me/events/e2`, query: "absent", json: { location: { displayName: "Room 4" } } },
    },
    delete_event: { args: { event_id: "e2" }, request: { method: "DELETE", url: `${GRAPH}/me/events/e2`, query: "absent", body: "absent" }, response: { status: 204 } },
  },
});
