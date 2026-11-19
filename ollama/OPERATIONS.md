# ollama operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `ollama.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `generate` | Complete a prompt with a local model (not streamed); the text is in response | **model**, **prompt**, system, suffix, images, raw, format, options, think, keep_alive |
| `chat` | Chat with a local model (not streamed); the reply is in message.content (tool calls in message.tool_calls) | **model**, **messages**, tools, format, options, think, keep_alive |
| `embed` | Embed texts with a local embedding model; embeddings[i] belongs to input[i] | **model**, **input**, truncate, dimensions, keep_alive |
| `list_models` | List the models installed locally, with size and details |  |
| `show_model` | Show a local model's details, parameters, template, license and capabilities | **model**, verbose |
| `list_running_models` | List models loaded in memory now |  |
| `get_version` | Get the Ollama server version |  |
| `pull_model` | Download a model from the Ollama library and wait until it is installed (can be many GB) | **model** |
| `copy_model` | Copy a local model to a new name (overwrites a model with that name) | **source**, **destination** |
| `delete_model` | Delete a local model and free its disk space | **model** |
| `api_request` | Call any Ollama API endpoint that has no dedicated operation, e.g. path "/api/tags". Only the API's own host is allowed. | method, **path**, query, body |
