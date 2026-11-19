import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

describeRestPluginContract(pluginDefinition, {
  environment: { EMBEDDINGS_PROVIDER: "voyage" },
  operations: {
    embed_texts: {
      args: { input: ["refund policy"], input_type: "query", output_dimension: 512 },
      request: {
        method: "POST",
        url: "https://api.voyageai.com/v1/embeddings",
        query: "absent",
        json: { input: ["refund policy"], output_dimension: 512, input_type: "query", model: "voyage-4" },
      },
      response: { body: { data: [{ index: 0, embedding: [0.1, 0.2] }], model: "voyage-4" } },
      expect: { data: { data: [{ index: 0, embedding: [0.1, 0.2] }], model: "voyage-4" } },
    },
  },
});
