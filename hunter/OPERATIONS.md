# hunter operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `hunter.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `domain_search` | Email addresses Hunter knows for a domain or company, with names, positions, sources and the email pattern (uses search credits) | domain, company, limit, offset, email_type, seniority, department, required_field, verification_status |
| `find_email` | The most likely email address of a person at a domain or company, with a confidence score (uses a search credit when an email is found) | domain, company, first_name, last_name, full_name, linkedin_handle, max_duration |
| `verify_email` | Deliverability of an email address: status valid, invalid, accept_all, webmail, disposable or unknown, with score and checks (uses a verification credit) | **email** |
| `count_emails` | How many addresses Hunter has for a domain or company, by type, department and seniority (free) | domain, company, email_type |
| `enrich_person` | Profile of the person behind an email address or LinkedIn handle: name, location, employment, social handles (uses 0.2 credit when found) | email, linkedin_handle |
| `enrich_company` | Company profile for a domain: name, industry, size, location, tech, social handles (uses 0.2 credit when found) | **domain** |
| `discover_companies` | Find companies by a natural-language query or filters (location, industry, headcount, technology, ...), with how many emails Hunter has for each (free) | query, organization, headquarters_location, industry, headcount, company_type, technology, keywords, limit, offset |
| `get_account` | Plan, reset date and remaining searches, verifications or credits |  |
| `list_leads` | Saved leads, optionally filtered by list, email, company, name or country | leads_list_id, email, first_name, last_name, company, country_code, cursor, limit |
| `get_lead` | One saved lead | **lead_id** |
| `create_lead` | Save a lead (an existing email gets the new list memberships instead) (as an agent tool only when HUNTER_TOOL_ALLOW_LEAD_WRITES=1) | **email**, first_name, last_name, job_position, company, company_industry, company_size, confidence_score, website, country_code, linkedin_url, phone_number, twitter, notes, source, leads_list_id, leads_list_ids, custom_attributes |
| `upsert_lead` | Create a lead, or update the lead with the same email (as an agent tool only when HUNTER_TOOL_ALLOW_LEAD_WRITES=1) | **email**, first_name, last_name, job_position, company, company_industry, company_size, confidence_score, website, country_code, linkedin_url, phone_number, twitter, notes, source, leads_list_id, leads_list_ids, custom_attributes |
| `update_lead` | Change fields of a lead (an empty string clears a custom attribute) (as an agent tool only when HUNTER_TOOL_ALLOW_LEAD_WRITES=1) | **lead_id**, email, first_name, last_name, job_position, company, company_industry, company_size, confidence_score, website, country_code, linkedin_url, phone_number, twitter, notes, source, leads_list_id, leads_list_ids, custom_attributes |
| `delete_lead` | Delete a lead | **lead_id** |
| `list_leads_lists` | Leads lists with their lead counts | cursor, limit |
| `get_leads_list` | One leads list with a page of its leads | **list_id**, limit, offset |
| `create_leads_list` | Create a leads list (as an agent tool only when HUNTER_TOOL_ALLOW_LEAD_WRITES=1) | **name** |
| `update_leads_list` | Rename a leads list (as an agent tool only when HUNTER_TOOL_ALLOW_LEAD_WRITES=1) | **list_id**, **name** |
| `delete_leads_list` | Delete a leads list | **list_id** |
| `api_request` | Call any Hunter API v2 endpoint that has no dedicated operation, e.g. path "/account". Only the API's own host is allowed. Agent tools may only read paths under /account, /email-count, /leads, /leads_lists, /leads-lists. | method, **path**, query, body |
