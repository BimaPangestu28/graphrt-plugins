# pipedrive operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `pipedrive.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_persons` | Persons, filtered and sorted, with cursor pagination | filter_id, ids, owner_id, updated_since, updated_until, sort_by, sort_direction, custom_fields, org_id, deal_id, include_fields, cursor, limit |
| `get_person` | One person by id | **person_id** |
| `create_person` | Create a person | **name**, emails, phones, org_id, owner_id, visible_to, label_ids, custom_fields |
| `update_person` | Change fields of a person (only the given fields) | **person_id**, name, emails, phones, org_id, owner_id, visible_to, label_ids, custom_fields |
| `delete_person` | Mark a person deleted (removed for good after 30 days) | **person_id** |
| `search_persons` | Find persons by text; each item is {result_score, item} | **term**, fields, exact_match, organization_id, include_fields, cursor, limit |
| `list_organizations` | Organizations, filtered and sorted, with cursor pagination | filter_id, ids, owner_id, updated_since, updated_until, sort_by, sort_direction, custom_fields, include_fields, cursor, limit |
| `get_organization` | One organization by id | **organization_id** |
| `create_organization` | Create a organization | **name**, address, website, industry, owner_id, visible_to, label_ids, custom_fields |
| `update_organization` | Change fields of a organization (only the given fields) | **organization_id**, name, address, website, industry, owner_id, visible_to, label_ids, custom_fields |
| `delete_organization` | Mark a organization deleted (removed for good after 30 days) | **organization_id** |
| `search_organizations` | Find organizations by text; each item is {result_score, item} | **term**, fields, exact_match, cursor, limit |
| `list_deals` | Deals, filtered and sorted, with cursor pagination | filter_id, ids, owner_id, updated_since, updated_until, sort_by, sort_direction, custom_fields, person_id, org_id, pipeline_id, stage_id, status, include_fields, cursor, limit |
| `get_deal` | One deal by id | **deal_id** |
| `create_deal` | Create a deal | **deal_title**, value, currency, person_id, org_id, pipeline_id, stage_id, status, expected_close_date, probability, lost_reason, owner_id, visible_to, label_ids, custom_fields |
| `update_deal` | Change fields of a deal (only the given fields) | **deal_id**, deal_title, value, currency, person_id, org_id, pipeline_id, stage_id, status, expected_close_date, probability, lost_reason, owner_id, visible_to, label_ids, custom_fields |
| `delete_deal` | Mark a deal deleted (removed for good after 30 days) | **deal_id** |
| `search_deals` | Find deals by text; each item is {result_score, item} | **term**, fields, exact_match, person_id, organization_id, status, include_fields, cursor, limit |
| `list_activities` | Activitys, filtered and sorted, with cursor pagination | filter_id, ids, owner_id, updated_since, updated_until, sort_by, sort_direction, custom_fields, deal_id, lead_id, person_id, org_id, done, include_fields, cursor, limit |
| `get_activity` | One activity by id | **activity_id**, include_fields |
| `create_activity` | Create a activity | subject, activity_type, deal_id, lead_id, org_id, participants, due_date, due_time, duration, busy, done, note, public_description, priority, owner_id |
| `update_activity` | Change fields of a activity (only the given fields) | **activity_id**, subject, activity_type, deal_id, lead_id, org_id, participants, due_date, due_time, duration, busy, done, note, public_description, priority, owner_id |
| `delete_activity` | Mark a activity deleted (removed for good after 30 days) | **activity_id** |
| `list_pipelines` | Sales pipelines (ids for deals) | sort_by, sort_direction, cursor, limit |
| `list_stages` | Pipeline stages in order (ids for deals) | pipeline_id, sort_by, sort_direction, cursor, limit |
| `list_notes` | Notes, optionally of one deal, person, organization or lead (API v1, offset pagination) | deal_id, person_id, org_id, lead_id, user_id, sort, start_date, end_date, updated_since, cursor, limit |
| `get_note` | One note by id | **note_id** |
| `create_note` | Add a note to a deal, person, organization or lead (at least one link is needed) | **content**, deal_id, person_id, org_id, lead_id, pinned_to_deal_flag, pinned_to_person_flag, pinned_to_organization_flag |
| `update_note` | Change a note's text, links or pins | **note_id**, content, deal_id, person_id, org_id, lead_id, pinned_to_deal_flag, pinned_to_person_flag, pinned_to_organization_flag |
| `delete_note` | Delete a note | **note_id** |
| `get_current_user` | The token's user and company (ids for owner_id, company_domain) |  |
| `api_request` | Call any Pipedrive API endpoint that has no dedicated operation, e.g. path "/v1/dealFields". Only the API's own host is allowed. | method, **path**, query, body |
