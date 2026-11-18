/**
 * Runs describeRestPluginContract on the demo plugin with a deliberately wrong case, selected by argv[2], so
 * rest-plugin-testing.test.mjs can check that the generated tests fail. Run as `node --test <this file> <variant>`.
 */
import { defineRestPlugin } from "../../lib/rest-plugin.mjs";
import { describeRestPluginContract } from "../../lib/rest-plugin-testing.mjs";
import { DEMO_CONTRACT_CASES } from "./demo-contract-cases.mjs";
import { demoSpec } from "./demo-rest-spec.mjs";

const variant = process.env.CONTRACT_FIXTURE_VARIANT;
const operations = structuredClone(DEMO_CONTRACT_CASES.operations);
const variants = {
  "wrong-path": () => {
    operations.get_item.request.path = "/items/WRONG";
  },
  "missing-case": () => {
    delete operations.list_pages;
  },
  "wrong-json": () => {
    operations.send_message.request.json = { text: "hi" };
  },
};
variants[variant]();
describeRestPluginContract(defineRestPlugin(demoSpec()), { operations });
