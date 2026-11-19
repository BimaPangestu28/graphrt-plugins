# replicate-video operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `replicate-video.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `run_model` | Run an official or latest-version model by owner/name, e.g. google/veo-3 or kwaivgi/kling-v2.1 (paid; waits and saves the video) | **model_owner**, **model_name**, **input**, cancel_after, wait |
| `run_version` | Run a specific model version (64-character version id, or owner/name:version) (paid; waits and saves the output) | **version**, **input**, cancel_after, wait |
| `run_model_with_webhook` | Run an official or latest-version model by owner/name, e.g. google/veo-3 or kwaivgi/kling-v2.1 (paid; waits and saves the video); Replicate also POSTs the prediction to webhook on every update | **model_owner**, **model_name**, **input**, cancel_after, **webhook**, webhook_events_filter, wait |
| `run_version_with_webhook` | Run a specific model version (64-character version id, or owner/name:version) (paid; waits and saves the output); Replicate also POSTs the prediction to webhook on every update | **version**, **input**, cancel_after, **webhook**, webhook_events_filter, wait |
| `get_prediction` | Status (starting, processing, succeeded, failed, canceled, aborted), logs, metrics and output of a prediction; saves the output when it succeeded | **prediction_id** |
| `cancel_prediction` | Cancel a running prediction (its partial cost is still billed) | **prediction_id** |
| `list_predictions` | Predictions made with the API token's account, newest first | created_after, created_before, cursor |
| `get_model` | A model's description, run count, default example and latest version (with its input/output schema) | **model_owner**, **model_name** |
| `list_model_versions` | A model's versions, newest first | **model_owner**, **model_name**, cursor |
| `get_collection` | Models in a Replicate collection, e.g. text-to-video or image-to-video | **collection_slug** |
| `search_models` | Search public models, collections and docs, e.g. "lip sync video" | **query**, limit |
| `get_account` | The account (user or organization) that owns the API token |  |
| `api_request` | Call any Replicate HTTP API endpoint that has no dedicated operation, e.g. path "/account". Only the API's own host is allowed. | method, **path**, query, body |
