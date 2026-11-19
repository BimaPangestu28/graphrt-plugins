import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { FAKE_CREDENTIAL } from "../lib/shared/rest-contract-context.mjs";
import { restDefinition, wrapZeroBounceDefinition } from "../definition.mjs";

// The generated suite calls api_request as a tool with an arbitrary path, which the tool path allowlist refuses
// (tested in zerobounce.test.mjs), so the contract runs without that one guard.
const pluginDefinition = wrapZeroBounceDefinition(restDefinition, { guardApiRequestPaths: false });

const API = "https://api.zerobounce.net/v2";
const BULK = "https://bulkapi.zerobounce.net/v2";

describeRestPluginContract(pluginDefinition, {
  operations: {
    validate_email: {
      args: { email: "ada@example.com", ip_address: "1.1.1.1", validation_timeout: 20, activity_data: true },
      request: { method: "GET", url: `${API}/validate`, query: { email: "ada@example.com", ip_address: "1.1.1.1", timeout: "20", activity_data: "true" } },
      response: { body: { address: "ada@example.com", status: "valid", sub_status: "" } },
      expect: { data: { address: "ada@example.com", status: "valid", sub_status: "" } },
    },
    validate_batch: {
      args: { email_batch: [{ email_address: "ada@example.com", ip_address: null }, { email_address: "bob@example.com" }], verify_plus: true },
      request: {
        method: "POST",
        url: `${API}/validatebatch`,
        query: "absent",
        json: { email_batch: [{ email_address: "ada@example.com", ip_address: null }, { email_address: "bob@example.com" }], verify_plus: true, api_key: FAKE_CREDENTIAL },
      },
      response: { body: { email_batch: [{ address: "ada@example.com", status: "valid" }], errors: [] } },
    },
    get_credits: { args: {}, request: { method: "GET", url: `${API}/getcredits`, query: "absent" }, response: { body: { Credits: "2375" } }, expect: { data: "2375" } },
    get_api_usage: { args: { start_date: "2026-11-01", end_date: "2026-11-18" }, request: { method: "GET", url: `${API}/getapiusage`, query: { start_date: "2026-11-01", end_date: "2026-11-18" } } },
    send_file: {
      args: { file: "https://files.contract.example/list.csv", email_address_column: 2, has_header_row: true, remove_duplicate: false },
      request: { method: "POST", url: `${BULK}/sendfile`, query: "absent", multipart: { file: "list.csv", email_address_column: "2", has_header_row: "true", remove_duplicate: "false", api_key: FAKE_CREDENTIAL } },
      response: { body: { success: true, message: "File Accepted", file_id: "f1" } },
    },
    get_file_status: { args: { file_id: "f1" }, request: { method: "GET", url: `${BULK}/filestatus`, query: { file_id: "f1" } }, response: { body: { success: true, file_status: "Complete", complete_percentage: "100%" } } },
    get_file: { args: { file_id: "f1", download_type: "combined" }, request: { method: "GET", url: `${BULK}/getfile`, query: { file_id: "f1", download_type: "combined" } } },
    delete_file: { args: { file_id: "f1" }, request: { method: "GET", url: `${BULK}/deletefile`, query: { file_id: "f1" } }, response: { body: { success: true, message: "File Deleted" } } },
  },
});
