# ollama

**Status:** beta · **ToS risk:** none. Local Ollama API; unit-tested with fakes, checked live only with no server running (network_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for a local [Ollama](https://ollama.com) server
([API reference](https://github.com/ollama/ollama/blob/main/docs/api.md)). It runs a *second* model on your own
machine, free and private: generate, chat (with tools and JSON schema output), embed, and manage installed models.
Requests are non-streaming. Every operation is a workflow node; pull, copy and delete are node only.

## Features
- **`generate`:** prompt completion with `system`, `suffix`, `images` (vision models), `format` (JSON schema),
  `options` (temperature, context size, ...), `think` (true/false or low/medium/high), `keep_alive`, `raw`
- **`chat`:** `messages` with `tools`, `format`, `options`, `think`
- **`embed`:** vectors for a list of texts (`truncate`, `dimensions`)
- **Models:** `list_models` (installed), `show_model`, `list_running_models` (loaded in memory), `get_version`
- **Node only:** `pull_model` (waits until the download is done), `copy_model`, `delete_model`
- **`api_request`:** any other endpoint of the server (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Ollama installed and running (`ollama serve`, or the desktop app), and a model pulled, e.g. `ollama pull llama3.2`

## Installation
```bash
graphrt plugin install ./ollama
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `OLLAMA_URL` | no | Server URL, default `http://127.0.0.1:11434`. Plain `http://` is allowed only for `localhost`, `127.0.0.1` and `[::1]`; a server on another machine must be behind https (a reverse proxy) |
| `OLLAMA_API_KEY` | no | Bearer token for a server behind an authenticating reverse proxy; sent as `Authorization: Bearer` and redacted. Without it no credential is sent |

Ollama has no authentication of its own: anyone who can reach the server can use it, so keep it on localhost or
behind an authenticating proxy (then set `OLLAMA_API_KEY`). A node can pass the token as `access_token` instead
(needs `--trust-plugin ollama`); agent tools never can.

## Pricing
Free: everything runs on your hardware. Large models need a lot of RAM/VRAM and can be slow on CPU.

## Quick Start
```bash
ollama serve &              # if it is not running yet
graphrt run ollama/example.yaml --plugins .
```
The example lists the installed models.

## Usage
```yaml
- id: label
  type: ollama.chat
  model: llama3.2
  messages:
    - { role: system, content: "Classify the ticket as billing, bug or other. Answer with one word." }
    - { role: user, content: "{{#start.ticket#}}" }
  options: { temperature: 0 }
- id: answer
  type: answer
  answer: "{{#label.data.message.content#}}"
```
- `generate` puts the text in `response`, `chat` in `message.content`; thinking models put their reasoning in
  `thinking`.
- The first call to a model loads it into memory (seconds to minutes); `keep_alive` keeps it loaded.
- Generation has a 600 s per-request timeout, `pull_model` 30 minutes (the plugin's host timeout). Agent tool results
  are cut at 100,000 characters (embeddings at 20,000); nodes always get everything.

## Agent policy
- **Node only:** `pull_model` (downloads gigabytes), `copy_model` (can overwrite a model), `delete_model`.
- **Retries:** generate, chat, embed and the model reads run on your own hardware at no cost, so they are agent tools
  and are retried after 5xx and network errors.
- `api_request` is GET-only for agents, so an agent cannot reach `/api/create`, `/api/push` or other writes.

## Errors
| Kind | When |
|------|------|
| `network_error` | the server is not running or not reachable (`ECONNREFUSED`) |
| `not_found` | the model is not installed (`model '...' not found`): pull it first |
| `invalid_input` | bad request, or `OLLAMA_URL` is invalid or plain http to a non-local host |
| `api_error` | the model failed to load (e.g. out of memory); Ollama's message is included |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Ollama-specific cases. Live check on a machine
without Ollama running: clean `network_error: connect ECONNREFUSED 127.0.0.1:11434`.

## License
Apache-2.0
