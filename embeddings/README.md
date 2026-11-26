# embeddings

**Status:** beta · **ToS risk:** none. OpenAI-compatible /embeddings API for several providers; unit-tested with fakes, checked live only with an invalid key. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for text embeddings that does not tie a workflow to one
provider. It calls the OpenAI-compatible `POST /embeddings` endpoint that OpenAI, Mistral, Gemini, Voyage AI, Ollama
and many other hosts serve, and adds `rank_by_similarity`: semantic search over a short list that returns scores,
not vectors. Both operations are workflow nodes and agent tools.

**Why this plugin exists next to `openai`, `mistral`, `gemini` and `ollama`:** those plugins already embed, each in
its own request and response shape. This one is a thin provider-agnostic wrapper: switch `EMBEDDINGS_PROVIDER` and a
retrieval or deduplication workflow keeps working unchanged. Provider-specific options (Gemini task types,
batch embedding, Mistral dtypes) stay in the provider plugins.

## Features
- **`embed_texts`:** up to 1000 texts; `data[]` holds `{index, embedding}` in the OpenAI shape for every provider.
  Optional `dimensions` (OpenAI, Gemini, Ollama), `output_dimension` (Voyage, Mistral codestral-embed) and
  `input_type` (Voyage)
- **`rank_by_similarity`:** embeds a `query` and up to 999 `documents` in one call and returns the `top_k` matches as
  `{index, document, score}` (cosine similarity), best first

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An API key for the provider you choose (OpenAI, Mistral, Gemini AI Studio or Voyage AI), or a running Ollama

## Installation
```bash
graphrt plugin install ./embeddings
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `EMBEDDINGS_PROVIDER` | no | `openai` (default), `mistral`, `gemini`, `voyage`, `ollama` or `custom` |
| `EMBEDDINGS_API_KEY` | yes | The provider's API key, sent as `Authorization: Bearer`. For Ollama any non-empty value (e.g. `ollama`): Ollama ignores it |
| `EMBEDDINGS_MODEL` | no | Model used when a call names none (required for `custom`) |
| `EMBEDDINGS_BATCH_SIZE` | no | Texts per request for `rank_by_similarity` (1-1000); default per provider below |
| `EMBEDDINGS_BASE_URL` | for `custom` | Base URL that serves `/embeddings`, e.g. `https://api.together.xyz/v1` or `http://localhost:1234/v1`; also overrides a provider's URL (https, or http on localhost only) |

| Provider | Base URL | Default model | Texts per request |
|----------|----------|---------------|------------------:|
| `openai` | `https://api.openai.com/v1` | `text-embedding-3-small` | 1000 |
| `mistral` | `https://api.mistral.ai/v1` | `mistral-embed` | 100 (Mistral limits by tokens; conservative) |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-embedding-001` | 100 |
| `voyage` | `https://api.voyageai.com/v1` | `voyage-4` | 1000 |
| `ollama` | `http://127.0.0.1:11434/v1` | `nomic-embed-text` (pull it first) | 1000 |
| `custom` | `EMBEDDINGS_BASE_URL` | `EMBEDDINGS_MODEL` | 100 |

`rank_by_similarity` splits the query and documents into requests of that size. `embed_texts` sends one request,
so keep `input` within the provider's limit (at most 100 texts for Gemini).

The provider and URL come only from the environment: an agent cannot point the key at another host. A node can
override the key with `access_token` (from a secret; needs `--trust-plugin embeddings`).

## Pricing
Embeddings are billed per input token by the provider (cents per million tokens for small models); Ollama is free.
See the provider's pricing page. An agent with these tools can spend (a little) money.

## Quick Start
```bash
EMBEDDINGS_PROVIDER=openai EMBEDDINGS_API_KEY=sk-... graphrt run embeddings/example.yaml --plugins .
```
The example ranks three FAQ entries against a question.

## Usage
```yaml
- id: best
  type: embeddings.rank_by_similarity
  query: "{{#start.question#}}"
  documents: "{{#faq.data.answers#}}"
  top_k: 3
- id: answer
  type: answer
  answer: "{{#best.data.matches.0.document#}}"
```
- Scores are only comparable within one model; use the same model for everything you compare or store.
- `embed_texts` results for agents are cut at 20,000 characters (vectors are long); use `rank_by_similarity` from
  agents and `embed_texts` from nodes (nodes always get everything).

## Agent policy
Both operations are agent tools. **Retries:** embeddings are paid, so `embed_texts` and each request of
`rank_by_similarity` are never retried after a 5xx, timeout or network error (the provider may already have billed
them); the error says "outcome unknown" and to check usage, and a failed later request of `rank_by_similarity` says
how many requests already succeeded. 429 is retried: nothing ran. There is no `api_request`, because the provider's
other endpoints differ.

## Errors
| Kind | When |
|------|------|
| `auth_error` | missing or invalid key |
| `invalid_input` | unknown `EMBEDDINGS_PROVIDER`, `custom` without `EMBEDDINGS_BASE_URL` or model, bad parameters for the provider (e.g. `input_type` outside Voyage) |
| `rate_limited` | 429 from the provider (retried) |
| `api_error` | the provider returned fewer vectors than texts, or a 5xx |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite; `test/embeddings.test.mjs` covers the provider table,
default models and the ranking. Verified live with invalid keys against OpenAI and Voyage (clean `auth_error`).

## License
Apache-2.0
