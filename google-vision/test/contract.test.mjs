import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://vision.googleapis.com/v1";
const imageRequest = { image: { source: { imageUri: "gs://bucket/cat.jpg" } }, features: [{ type: "LABEL_DETECTION", maxResults: 3 }] };
const fileRequest = { inputConfig: { content: "JVBERi0=", mimeType: "application/pdf" }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }], pages: [1] };

describeRestPluginContract(pluginDefinition, {
  operations: {
    annotate_images: {
      args: { requests: [imageRequest] },
      request: { method: "POST", url: `${API}/images:annotate`, query: "absent", json: { requests: [imageRequest] } },
      response: { body: { responses: [{ labelAnnotations: [{ description: "Cat", score: 0.98 }] }] } },
      expect: { data: { responses: [{ labelAnnotations: [{ description: "Cat", score: 0.98 }] }] } },
    },
    annotate_files: {
      args: { requests: [fileRequest] },
      request: { method: "POST", url: `${API}/files:annotate`, query: "absent", json: { requests: [fileRequest] } },
    },
  },
});
