# qontak operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `qontak.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_whatsapp_templates` | Approved and pending WhatsApp message templates (id, name, language, category, status, body) | status, query, offset, limit |
| `get_whatsapp_template` | One message template with its components | **template_id** |
| `list_integrations` | Connected channels (WhatsApp numbers and others); channel_integration_id for sends | target_channel |
| `list_rooms` | Conversation rooms (one per contact and channel) with their last message, status and agents | query, status, start_date, end_date, offset, limit |
| `get_room` | One conversation room | **room_id** |
| `list_room_histories` | History entries of a room (assignments, resolutions, sessions) | **room_id** |
| `send_whatsapp_template` | Send an approved WhatsApp template message to one number (a direct broadcast; billed per WhatsApp conversation) (as an agent tool only when QONTAK_TOOL_ALLOW_SEND=1) | **to_number**, **to_name**, **message_template_id**, **channel_integration_id**, language_code, parameters |
| `list_whatsapp_broadcasts` | Sent broadcasts (direct and bulk) with status counts | start_date, end_date, category, offset, limit |
| `get_whatsapp_broadcast` | One broadcast with template and status counts | **broadcast_id** |
| `get_whatsapp_broadcast_log` | Per-recipient delivery status of a broadcast (sent, delivered, read, failed with the WhatsApp error) | **broadcast_id**, offset, limit |
| `list_contacts` | CRM contacts, newest first | name, email, phone, crm_company_id, created_after, cursor, limit |
| `get_contact` | One CRM contact (person) | **contact_id** |
| `create_contact` | Create a CRM contact (person) (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **first_name**, last_name, job_title, email, telephone, crm_status_id, crm_company_id, crm_deal_ids, crm_source_id, address, city, province, country, zipcode, date_of_birth, creator_id, additional_fields |
| `update_contact` | Change fields of a CRM contact (person) (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **contact_id**, first_name, last_name, job_title, email, telephone, crm_status_id, crm_company_id, crm_deal_ids, crm_source_id, address, city, province, country, zipcode, date_of_birth, creator_id, additional_fields |
| `delete_contact` | Delete a CRM contact (person) | **contact_id** |
| `list_companies` | CRM companies, newest first | name, website, cursor, limit |
| `get_company` | One CRM company | **company_id** |
| `create_company` | Create a CRM company (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **name**, website, telephone, address, city, province, country, zipcode, crm_person_ids, creator_id, additional_fields |
| `update_company` | Change fields of a CRM company (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **company_id**, name, website, telephone, address, city, province, country, zipcode, crm_person_ids, creator_id, additional_fields |
| `delete_company` | Delete a CRM company | **company_id** |
| `list_deals` | CRM deals, newest first | name, cursor, limit |
| `get_deal` | One CRM deal | **deal_id** |
| `create_deal` | Create a CRM deal (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **name**, **crm_pipeline_id**, **crm_stage_id**, currency, size, closed_date, start_date, expired_date, crm_company_id, crm_lead_ids, crm_source_id, crm_priority_id, crm_lost_reason_id, creator_id, additional_fields |
| `update_deal` | Change fields of a CRM deal (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **deal_id**, name, crm_pipeline_id, crm_stage_id, currency, size, closed_date, start_date, expired_date, crm_company_id, crm_lead_ids, crm_source_id, crm_priority_id, crm_lost_reason_id, creator_id, additional_fields |
| `delete_deal` | Delete a CRM deal | **deal_id** |
| `list_tasks` | CRM tasks, newest first | task_name, crm_task_status_id, cursor, limit |
| `get_task` | One CRM task | **task_id** |
| `create_task` | Create a CRM task (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **name**, crm_person_id, crm_deal_id, crm_company_id, crm_task_status_id, crm_task_priority_id, crm_task_category_id, user_id, due_date, reminder_date, detail, next_step, additional_fields |
| `update_task` | Change fields of a CRM task (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **task_id**, name, crm_person_id, crm_deal_id, crm_company_id, crm_task_status_id, crm_task_priority_id, crm_task_category_id, user_id, due_date, reminder_date, detail, next_step, additional_fields |
| `delete_task` | Delete a CRM task | **task_id** |
| `list_notes` | CRM notes, newest first | crm_lead_id, crm_company_id, crm_deal_id, cursor, limit |
| `get_note` | One CRM note | **note_id** |
| `create_note` | Create a CRM note (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **note**, note_type, crm_person_id, crm_deal_id, crm_company_id, creator_id |
| `update_note` | Change fields of a CRM note (as an agent tool only when QONTAK_TOOL_ALLOW_CRM_WRITES=1) | **note_id**, note, note_type, crm_person_id, crm_deal_id, crm_company_id, creator_id |
| `delete_note` | Delete a CRM note | **note_id** |
| `list_pipelines` | Deal pipelines |  |
| `get_pipeline` | One deal pipeline | **pipeline_id** |
| `list_pipeline_stages` | Stages of a pipeline (crm_stage_id for deals) | **pipeline_id** |
| `api_request` | Call any Qontak Chat API endpoint that has no dedicated operation, e.g. path "/templates/whatsapp". Only the API's own host is allowed. Agent tools may only read paths under /templates, /rooms, /broadcasts. | method, **path**, query, body |
