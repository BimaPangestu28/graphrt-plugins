import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE = "https://us-central1-aiplatform.googleapis.com/v1/projects/my-project-1/locations/us-central1";
const OPERATION_NAME = "projects/my-project-1/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/a1b2c3";

// generate_video is hand-written (lib/generate-video.mjs) and tested in generate-video.test.mjs.
describeRestPluginContract(pluginDefinition, {
  environment: { GOOGLE_CLOUD_PROJECT: "my-project-1" },
  operations: {
    get_operation: {
      args: { model: "veo-3.1-generate-001", operation_name: OPERATION_NAME },
      request: {
        method: "POST",
        url: `${BASE}/publishers/google/models/veo-3.1-generate-001:fetchPredictOperation`,
        query: "absent",
        json: { operationName: OPERATION_NAME },
      },
      response: { body: { name: OPERATION_NAME, done: false } },
      expect: { data: { result: { name: OPERATION_NAME, done: false }, saved_files: [] } },
    },
  },
});
