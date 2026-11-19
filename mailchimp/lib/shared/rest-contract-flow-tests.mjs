/**
 * Generated contract tests about multi-step flows (rest-plugin-testing.mjs): limit/cursor pagination for every
 * style, async jobs that finish, fail and time out, and downloads into the output directory.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPath, writePath } from "./object-path.mjs";
import { buildValueAtPath, FAKE_JOB_ID, jobCreatedResponse, jobStatusResponse, runContractOperation, successResponses } from "./rest-contract-context.mjs";

const NEXT_CURSOR_VALUE = "contract-next-cursor";
const PENDING_STATUS = "contract-pending";
const DOWNLOAD_URL = "https://cdn.contract.example/contract-file.png";
const BASE64_VALUE = Buffer.from("CONTRACT-BASE64").toString("base64");

/**
 * Lists the flow tests for a contract.
 *
 * @param contract - Contract context (object)
 * @returns `[{name, run}]` (object[])
 */
export function buildFlowTests(contract) {
  return contract.casedOperations.flatMap((operation) => [...paginationTests(contract, operation), ...jobTests(contract, operation), ...downloadTests(contract, operation)]);
}

// --- pagination -------------------------------------------------------------------------------------

function paginationTests(contract, operation) {
  if (!operation.pagination) return [];
  const style = operation.pagination.style;
  const isUrlStyle = style === "link" || style === "nextUrl";
  return [{
    name: `${operation.name} maps limit/cursor (${style} pagination) and returns next_cursor`,
    run: () => (isUrlStyle ? checkUrlPagination(contract, operation) : checkFieldPagination(contract, operation)),
  }];
}

function paginationLimit(contract, operation) {
  const generatedOperation = contract.pluginDefinition.operations.find((candidate) => candidate.name === operation.name);
  const limitSchema = generatedOperation.parameters.properties.limit;
  return limitSchema ? Math.min(2, limitSchema.maximum ?? 2) : undefined;
}

function buildItemsBody(response, items) {
  return response.dataPath ? writePath({}, response.dataPath, items) : items;
}

function describeFieldPagination(operation, pageSize) {
  const response = operation.response;
  const items = Array.from({ length: pageSize }, (unused, index) => ({ id: `contract-item-${index + 1}`, contract_item: index }));
  const objectBody = () => (response.dataPath ? writePath({}, response.dataPath, items) : {});
  const styles = {
    cursor: () => {
      const body = objectBody();
      writePath(body, response.cursorPath, NEXT_CURSOR_VALUE);
      if (response.hasMorePath) writePath(body, response.hasMorePath, true);
      return { cursor: "contract-cursor", cursorWireName: response.cursorParam, cursorWireValue: "contract-cursor", limitWireName: response.limitParam, expectedNextCursor: NEXT_CURSOR_VALUE, body };
    },
    lastItem: () => {
      const lastItemCursor = response.lastItemCursor;
      const lastItems = items.map((item, index) => writePath({ ...item }, lastItemCursor.itemIdPath, `contract-id-${index + 1}`));
      const body = buildItemsBody(response, lastItems);
      if (lastItemCursor.hasMorePath) writePath(body, lastItemCursor.hasMorePath, true);
      return { cursor: "contract-cursor", cursorWireName: lastItemCursor.param, cursorWireValue: "contract-cursor", limitWireName: response.limitParam, expectedNextCursor: `contract-id-${pageSize}`, body };
    },
    page: () => {
      const currentPage = (response.pagePagination.firstPage ?? 1) + 1;
      const body = withTotal(buildItemsBody(response, items), response.pagePagination.totalPagesPath, 1000);
      return { cursor: String(currentPage), cursorWireName: response.pagePagination.pageParam, cursorWireValue: currentPage, limitWireName: response.pagePagination.sizeParam, expectedNextCursor: String(currentPage + 1), body };
    },
    offset: () => {
      const body = withTotal(buildItemsBody(response, items), response.offsetPagination.totalPath, 1000);
      return { cursor: "10", cursorWireName: response.offsetPagination.offsetParam, cursorWireValue: 10, limitWireName: response.offsetPagination.limitParam, expectedNextCursor: String(10 + pageSize), body };
    },
  };
  return styles[operation.pagination.style]();
}

async function checkFieldPagination(contract, operation) {
  const { args } = contract.operationCases[operation.name];
  const limit = paginationLimit(contract, operation);
  const pagination = describeFieldPagination(operation, limit ?? 2);
  const pageArgs = { ...args, cursor: pagination.cursor, ...(limit === undefined ? {} : { limit }) };
  const { output, error, calls } = await runContractOperation(contract, operation.name, pageArgs, { responses: [{ body: pagination.body }] });
  if (error) throw error;
  assertPaginationParam(operation, calls[0], pagination.cursorWireName, pagination.cursorWireValue);
  if (limit !== undefined) assertPaginationParam(operation, calls[0], pagination.limitWireName, limit);
  assert.equal(output.next_cursor, pagination.expectedNextCursor, "next_cursor");
}

function withTotal(body, totalPath, total) {
  if (totalPath && body && typeof body === "object" && !Array.isArray(body)) writePath(body, totalPath, total);
  return body;
}

function assertPaginationParam(operation, call, wireName, expectedValue) {
  const sentValue = operation.pagination.paramsIn === "body" ? readPath(call.json ?? Object.fromEntries(new URLSearchParams(call.body ?? "")), wireName) : new URL(call.url).searchParams.get(wireName);
  assert.equal(String(sentValue), String(expectedValue), `pagination param ${wireName}`);
}

async function checkUrlPagination(contract, operation) {
  const { args } = contract.operationCases[operation.name];
  const response = operation.response;
  const limit = paginationLimit(contract, operation);
  const nextUrl = `${contract.baseUrlFor(operation).href.replace(/\/$/, "")}/contract-next?contract_page=2`;
  const firstResponse = response.nextLinkHeader
    ? { body: buildItemsBody(response, [{}]), headers: { link: `<${nextUrl}>; rel="next"` } }
    : { body: writePath(response.dataPath ? writePath({}, response.dataPath, [{}]) : {}, response.nextUrlPath, nextUrl) };
  const first = await runContractOperation(contract, operation.name, limit === undefined ? args : { ...args, limit }, { responses: [firstResponse] });
  if (first.error) throw first.error;
  if (limit !== undefined) assert.equal(new URL(first.calls[0].url).searchParams.get(response.limitParam), String(limit), "limit param");
  assert.equal(first.output.next_cursor, nextUrl, "next_cursor is the next URL");
  const second = await runContractOperation(contract, operation.name, { ...args, cursor: nextUrl }, { responses: [{ body: buildItemsBody(response, []) }] });
  if (second.error) throw second.error;
  assert.equal(new URL(second.calls[0].url).searchParams.get("contract_page"), "2", "the cursor URL is requested");
  assert.equal(second.output.next_cursor, null);
  const escaping = await runContractOperation(contract, operation.name, { ...args, cursor: "https://outside.contract.example/steal" }, { source: "tool" });
  assert.equal(escaping.error?.kind, "invalid_input", "a cursor outside the base URL is refused");
}

// --- jobs ------------------------------------------------------------------------------------------------

function jobTests(contract, operation) {
  if (!operation.job) return [];
  const { args } = contract.operationCases[operation.name];
  const job = operation.job;
  const tests = [{
    name: `${operation.name} job: done returns the job id, status and result`,
    run: async () => {
      const { output, error, calls } = await runContractOperation(contract, operation.name, args, { responses: successResponses(contract, operation) });
      if (error) throw error;
      assert.equal(output.data.job_id, FAKE_JOB_ID);
      assert.equal(output.data.status, job.doneValues[0]);
      assert.ok(calls.slice(1).some((call) => call.url.includes(FAKE_JOB_ID)), "the status is polled with the job id");
    },
  }];
  if (job.failedValues?.length) {
    tests.push({
      name: `${operation.name} job: failed is reported with the job id and is not retryable`,
      run: async () => {
        const failedStatus = jobStatusResponse(operation, job.failedValues[0], job.errorPath ? { [job.errorPath]: "contract failure reason" } : {});
        const { error } = await runContractOperation(contract, operation.name, args, { responses: [jobCreatedResponse(contract, operation), failedStatus] });
        assert.equal(error?.kind, "api_error");
        assert.equal(error.retryable, false);
        assert.match(error.message, new RegExp(FAKE_JOB_ID));
      },
    });
  }
  tests.push({
    name: `${operation.name} job: timeout returns the job id with retryable false`,
    run: async () => {
      const pendingStatuses = Array.from({ length: 20 }, () => jobStatusResponse(operation, PENDING_STATUS));
      const { error } = await runContractOperation(contract, operation.name, args, { responses: [jobCreatedResponse(contract, operation), ...pendingStatuses], environment: { GRAPHRT_JOB_TIMEOUT_MS: "1" } });
      assert.equal(error?.kind, "timeout");
      assert.equal(error.retryable, false);
      assert.match(error.message, new RegExp(FAKE_JOB_ID));
    },
  });
  return tests;
}

// --- downloads ----------------------------------------------------------------------------------------------

function downloadTests(contract, operation) {
  const saveTo = operation.download?.saveTo;
  if (!saveTo) return [];
  const usesUrls = Boolean(saveTo.urlPaths?.length);
  const resultValue = usesUrls ? buildValueAtPath(saveTo.urlPaths[0], DOWNLOAD_URL) : buildValueAtPath(saveTo.base64Paths[0], BASE64_VALUE);
  return [{
    name: `${operation.name} saves ${usesUrls ? "result URLs" : "base64 fields"} into $${saveTo.envDir}`,
    run: async () => {
      const outputDirectory = join(contract.scratchDirectory, `${operation.name}-downloads`);
      const { args } = contract.operationCases[operation.name];
      const responses = [...downloadResultResponses(contract, operation, resultValue), { body: "CONTRACT-FILE", headers: { "content-type": "image/png" } }];
      const { output, error } = await runContractOperation(contract, operation.name, args, { responses, environment: { [saveTo.envDir]: outputDirectory } });
      if (error) throw error;
      const [savedFile] = output.data.saved_files;
      assert.ok(savedFile?.path, `a file is saved: ${JSON.stringify(output.data.saved_files)}`);
      assert.ok(savedFile.path.startsWith(outputDirectory) && existsSync(savedFile.path));
    },
  }];
}

function downloadResultResponses(contract, operation, resultValue) {
  if (operation.job) return successResponses(contract, operation, resultValue);
  const dataPath = operation.response?.dataPath;
  return [{ body: dataPath ? writePath({}, dataPath, resultValue) : resultValue }];
}
