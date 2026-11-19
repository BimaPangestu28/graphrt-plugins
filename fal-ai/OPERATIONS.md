# fal-ai operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `fal-ai.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `run_model` | Run a fal model through the queue and wait for the result (paid), e.g. model_id fal-ai/flux/schnell. Media URLs in the result are saved to $FAL_AI_OUTPUT_DIR | **model_id**, **input**, priority, start_timeout, wait |
| `get_request_status` | Status of a queued request: IN_QUEUE (with queue_position), IN_PROGRESS or COMPLETED (with error and error_type when it failed) | **owner**, **app**, **request_id**, logs |
| `get_request_result` | Result of a completed request (kept 1 hour, or 6 minutes when 10 KB or larger); media URLs are saved to $FAL_AI_OUTPUT_DIR | **owner**, **app**, **request_id** |
| `cancel_request` | Cancel a queued request (it never runs) or ask a running one to stop; repeating it is harmless | **owner**, **app**, **request_id** |
| `search_models` | Search fal model endpoints by text or category, or look up specific endpoint ids (with their OpenAPI schema when expanded) | q, category, status, sort, endpoint_id, expand, cursor, limit |
| `get_pricing` | Unit price of model endpoints (per image, video second, megapixel or GPU second) for your account | **endpoint_id** |
| `estimate_cost` | Estimate the cost of planned calls (historical_api_price: per call) or outputs (unit_price: per billing unit) | **estimate_type**, **endpoints** |
