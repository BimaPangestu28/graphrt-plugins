# cloudflare operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `cloudflare.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `verify_token` | Check that the API token is valid and active (status, expiry) |  |
| `verify_account_token` | Check that an account-owned API token is valid and active (account tokens fail verify_token) | **account_id** |
| `list_accounts` | Accounts the token can access (ids for Workers) | name, direction, cursor, limit |
| `list_zones` | Zones (domains) the token can access | name, status, account_id, order, direction, cursor, limit |
| `get_zone` | One zone: status, plan, name servers, settings summary | **zone_id** |
| `list_dns_records` | DNS records of a zone, optionally filtered by type, exact name or content | **zone_id**, record_type, name, content, proxied, search, order, direction, cursor, limit |
| `get_dns_record` | One DNS record | **zone_id**, **record_id** |
| `create_dns_record` | Add a DNS record to a zone (changes where traffic goes; agent tools only for names in CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES) (as an agent tool only when CLOUDFLARE_TOOL_ALLOW_WRITE=1) | **zone_id**, **record_type**, **name**, **content**, ttl, proxied, priority, comment, tags |
| `update_dns_record` | Change fields of a DNS record (given fields only; agent tools only for names in CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES) (as an agent tool only when CLOUDFLARE_TOOL_ALLOW_WRITE=1) | **zone_id**, **record_id**, record_type, name, content, ttl, proxied, priority, comment, tags |
| `delete_dns_record` | Delete a DNS record | **zone_id**, **record_id** |
| `purge_cache` | Purge cached content of a zone: everything, or by URLs, cache tags, hostnames or prefixes (one kind per call) | **zone_id**, purge_everything, files, tags, hosts, prefixes |
| `list_workers` | Worker scripts of an account with created/modified times and handlers | **account_id**, tags |
| `get_worker_settings` | Settings of a Worker: bindings (names and types, never secret values), compatibility date and flags, observability | **account_id**, **script_name** |
| `list_worker_deployments` | Deployments of a Worker (which versions serve traffic, and their split) | **account_id**, **script_name** |
| `api_request` | Call any Cloudflare API endpoint that has no dedicated operation, e.g. path "/zones/<zone_id>/settings". Only the API's own host is allowed. | method, **path**, query, body |
