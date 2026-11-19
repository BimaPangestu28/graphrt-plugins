# replicate operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `replicate.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_account` | The account that owns the API token (type, username, name) |  |
| `search` | Search models, collections and docs by text (beta); models include generated descriptions and tags | **query**, limit |
| `list_models` | List public models, newest version first by default | sort_by, sort_direction, cursor |
| `get_model` | A model with its description, run count, default example and latest version (with its input/output schema) | **model_owner**, **model_name** |
| `list_model_versions` | List a model's versions, newest first | **model_owner**, **model_name**, cursor |
| `get_model_version` | A model version with its OpenAPI input/output schema | **model_owner**, **model_name**, **version_id** |
| `list_collections` | List curated model collections | cursor |
| `get_collection` | A collection with its models, e.g. text-to-image | **collection_slug** |
| `list_hardware` | Hardware SKUs available for models and deployments |  |
| `run_model` | Run an official model (no version needed), e.g. black-forest-labs/flux-schnell, and wait for the output (paid). Output files are saved to $REPLICATE_OUTPUT_DIR | **model_owner**, **model_name**, **input**, cancel_after, wait |
| `create_prediction` | Run a specific model version and wait for the output (paid). Output files are saved to $REPLICATE_OUTPUT_DIR | **version**, **input**, cancel_after, wait |
| `run_deployment` | Run one of your deployments and wait for the output (paid; deployments also bill for idle instances). Output files are saved to $REPLICATE_OUTPUT_DIR | **deployment_owner**, **deployment_name**, **input**, cancel_after, wait |
| `get_prediction` | A prediction's status (starting, processing, succeeded, failed, canceled), output, error, logs and metrics | **prediction_id** |
| `list_predictions` | List your predictions, newest first (100 per page) | created_after, created_before, source, cursor |
| `cancel_prediction` | Cancel a running prediction (billing stops; repeating it is harmless) | **prediction_id** |
| `api_request` | Call any Replicate HTTP API endpoint that has no dedicated operation, e.g. path "/v1/account". Only the API's own host is allowed. | method, **path**, query, body |
