# embeddings operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `embeddings.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `embed_texts` | Embed texts with the configured provider; data[] holds {index, embedding} with index pointing into input | **input**, model, dimensions, output_dimension, input_type |
| `rank_by_similarity` | Semantic search over a short list: embeds the query and documents and returns the top_k most similar documents with cosine scores | **query**, **documents**, top_k, model |
