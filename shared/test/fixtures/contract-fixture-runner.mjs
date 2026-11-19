/**
 * Runs describeRestPluginContract on the demo plugin with a deliberately wrong case, selected by
 * CONTRACT_FIXTURE_VARIANT, so rest-plugin-testing.test.mjs can check that the generated tests fail.
 */
import { defineRestPlugin } from "../../lib/rest-plugin.mjs";
import { describeRestPluginContract } from "../../lib/rest-plugin-testing.mjs";
import { DEMO_CONTRACT_CASES } from "./demo-contract-cases.mjs";
import { demoSpec } from "./demo-rest-spec.mjs";

const variant = process.env.CONTRACT_FIXTURE_VARIANT;
const operations = structuredClone(DEMO_CONTRACT_CASES.operations);
const variants = {
  "wrong-path": () => {
    operations.get_item.request.url = "https://api.example.com/v1/items/WRONG";
  },
  "missing-case": () => {
    delete operations.list_pages;
  },
  "wrong-json": () => {
    operations.send_message.request.json = { text: "hi" };
  },
  "wrong-query": () => {
    operations.list_cursor.request.query = { status: "open" };
  },
  "wrong-data": () => {
    operations.get_item.expect.data = { id: "other" };
  },
  "wrong-file": () => {
    operations.upload_blob.request.file = { contentType: "audio/wav" };
  },
  "missing-query": () => {
    delete operations.list_links.request.query;
  },
};
variants[variant]();
describeRestPluginContract(defineRestPlugin(demoSpec()), { operations });
