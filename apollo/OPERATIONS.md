# apollo operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `apollo.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `search_people` | People API Search over Apollo's database by title, seniority, location and employer filters (no credits; returns names, titles and employers but no emails or phones; use enrich_person for those) | person_titles, include_similar_titles, person_seniorities, person_locations, q_keywords, contact_email_status, organization_locations, organization_not_locations, organization_num_employees_ranges, organization_ids, organization_industry_tag_ids, q_organization_domains_list, revenue_min, revenue_max, currently_using_any_of_technology_uids, cursor, limit |
| `search_organizations` | Companies in Apollo's database by name, location, headcount, industry, revenue, technology and funding (1 credit per page of up to 100) | q_organization_name, q_organization_keyword_tags, organization_locations, organization_not_locations, organization_num_employees_ranges, organization_ids, organization_industry_tag_ids, q_organization_domains_list, revenue_min, revenue_max, currently_using_any_of_technology_uids, cursor, limit |
| `enrich_person` | Match one person (by email, name + employer, LinkedIn URL or id) and return their profile and work email (1 credit when data is found) | first_name, last_name, name, email, hashed_email, organization_name, domain, person_id, linkedin_url, reveal_personal_emails |
| `enrich_person_with_callback` | enrich_person plus phone reveal or waterfall enrichment; Apollo delivers those results to webhook_url (mobile numbers cost 8 credits) | first_name, last_name, name, email, hashed_email, organization_name, domain, person_id, linkedin_url, reveal_personal_emails, reveal_phone_number, run_waterfall_email, run_waterfall_phone, **webhook_url** |
| `bulk_enrich_people` | Enrich up to 10 people in one call (1 credit per person found) (as an agent tool only when APOLLO_TOOL_ALLOW_BULK_ENRICHMENT=1) | **details**, reveal_personal_emails |
| `enrich_organization` | Company profile by domain: industry, headcount, revenue, location, funding, technologies (1 credit) | domain, linkedin_url, website, name |
| `bulk_enrich_organizations` | Enrich up to 10 companies in one call (1 credit per company) (as an agent tool only when APOLLO_TOOL_ALLOW_BULK_ENRICHMENT=1) | **details** |
| `search_contacts` | Contacts in your Apollo account by keywords, stage and list | q_keywords, contact_stage_ids, contact_label_ids, sort_by_field, sort_ascending, cursor, limit |
| `get_contact` | One contact of your Apollo account | **contact_id** |
| `create_contact` | Add a contact to your Apollo account (run_dedupe: overwrite a matching contact instead of creating a duplicate) (as an agent tool only when APOLLO_TOOL_ALLOW_CONTACT_WRITES=1) | first_name, last_name, organization_name, job_title, account_id, email, website_url, label_names, contact_stage_id, present_raw_address, direct_phone, corporate_phone, mobile_phone, typed_custom_fields, run_dedupe |
| `update_contact` | Change fields of a contact (as an agent tool only when APOLLO_TOOL_ALLOW_CONTACT_WRITES=1) | **contact_id**, first_name, last_name, organization_name, job_title, account_id, email, website_url, label_names, contact_stage_id, present_raw_address, direct_phone, corporate_phone, mobile_phone, typed_custom_fields |
| `list_contact_stages` | Contact stage ids and names |  |
| `search_accounts` | Accounts (companies) in your Apollo account by name, stage and list | q_organization_name, account_stage_ids, account_label_ids, sort_by_field, sort_ascending, cursor, limit |
| `search_sequences` | Sequences (emailer campaigns) by name | q_name, cursor, limit |
| `list_email_accounts` | Linked mailboxes (ids for add_contacts_to_sequence) |  |
| `add_contacts_to_sequence` | Enrol contacts in a sequence; Apollo then emails them on the sequence's schedule from the chosen mailbox | **sequence_id**, contact_ids, label_names, **send_email_from_email_account_id**, sequence_status, sequence_active_in_other_campaigns, sequence_unverified_email |
| `get_api_usage` | Rate-limit usage per endpoint (minute, hour, day); needs a master API key |  |
| `api_request` | Call any Apollo.io API endpoint that has no dedicated operation, e.g. path "/contact_stages". Only the API's own host is allowed. Agent tools may only read paths under /contacts, /contact_stages, /accounts, /account_stages, /email_accounts, /emailer_campaigns, /labels, /users, /auth/health. | method, **path**, query, body |
