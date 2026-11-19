/**
 * Generated contract tests for file inputs (rest-plugin-testing.mjs): every `file: true` param of a multipart or
 * bodyMode "file" operation is checked for the local-file allowlist (disabled without its env, files inside it are
 * sent, files outside it and symlinks out of it are refused), FIFOs and oversized files, non-https URLs, and, for
 * raw file uploads, redaction of the credential in the upload response.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePath } from "./object-path.mjs";
import { DEFAULT_MAX_FILE_BYTES } from "./rest-files.mjs";
import { runContractOperation, successResponses } from "./rest-contract-context.mjs";

const LOCAL_FILE_TEXT = "CONTRACT-LOCAL-FILE";

/**
 * Lists the file input tests for a contract.
 *
 * @param contract - Contract context (object)
 * @returns `[{name, run}]` (object[])
 */
export function buildFileInputTests(contract) {
  return contract.casedOperations.flatMap((operation) =>
    Object.entries(operation.params)
      .filter(([, paramSpec]) => paramSpec.file === true)
      .flatMap(([paramName, paramSpec]) => fileParamTests(contract, operation, { paramName, wireName: paramSpec.wireName ?? paramName })),
  );
}

function fileParamTests(contract, operation, fileParam) {
  const settings = (operation.bodyMode === "file" ? operation.fileBody : operation.multipart) ?? {};
  const fileInput = { ...fileParam, envName: settings.fileDirEnv, maxBytes: settings.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES };
  return [
    disabledLocalFileTest(contract, operation, fileInput),
    ...(fileInput.envName ? [allowlistTest(contract, operation, fileInput), unreadableFileTest(contract, operation, fileInput)] : []),
    plainHttpUrlTest(contract, operation, fileInput),
    ...uploadRedactionTests(contract, operation, fileInput),
  ];
}

function argsWithFile(contract, operation, fileInput, fileReference) {
  return { ...contract.operationCases[operation.name].args, [fileInput.paramName]: fileReference };
}

async function assertRefused(contract, operation, args, environment, label) {
  const { error, calls } = await runContractOperation(contract, operation.name, args, { environment });
  assert.equal(error?.kind, "invalid_input", `${label}: expected invalid_input, got ${error?.kind ?? "success"}`);
  assert.equal(calls.length, 0, `${label}: nothing is sent`);
}

function disabledLocalFileTest(contract, operation, fileInput) {
  const condition = fileInput.envName ? `$${fileInput.envName} is unset` : "the operation has no upload directory";
  return {
    name: `${operation.name} refuses a local \`${fileInput.paramName}\` when ${condition}`,
    run: () => assertRefused(contract, operation, argsWithFile(contract, operation, fileInput, "/etc/hosts"), fileInput.envName ? { [fileInput.envName]: "" } : {}, "local file"),
  };
}

function createUploadFixture(contract, operation) {
  const root = realpathSync(mkdtempSync(join(contract.scratchDirectory, `${operation.name}-files-`)));
  const allowedDirectory = join(root, "allowed");
  mkdirSync(allowedDirectory);
  const outsidePath = join(root, "outside.bin");
  writeFileSync(outsidePath, "CONTRACT-OUTSIDE");
  return { root, allowedDirectory, outsidePath };
}

function allowlistTest(contract, operation, fileInput) {
  return {
    name: `${operation.name} uploads a local \`${fileInput.paramName}\` inside $${fileInput.envName} and refuses one outside it or through a symlink`,
    run: async () => {
      const { allowedDirectory, outsidePath } = createUploadFixture(contract, operation);
      const insidePath = join(allowedDirectory, "inside.wav");
      writeFileSync(insidePath, LOCAL_FILE_TEXT);
      const environment = { [fileInput.envName]: allowedDirectory };
      const { error, calls } = await runContractOperation(contract, operation.name, argsWithFile(contract, operation, fileInput, insidePath), { environment, responses: successResponses(contract, operation) });
      if (error) throw error;
      assert.equal(await readUploadedText(operation, calls[0], fileInput), LOCAL_FILE_TEXT, "the local file's bytes are uploaded");
      const linkPath = join(allowedDirectory, "link.wav");
      symlinkSync(outsidePath, linkPath);
      await assertRefused(contract, operation, argsWithFile(contract, operation, fileInput, outsidePath), environment, "file outside the directory");
      await assertRefused(contract, operation, argsWithFile(contract, operation, fileInput, linkPath), environment, "symlink out of the directory");
      await assertRefused(contract, operation, argsWithFile(contract, operation, fileInput, "relative.wav"), environment, "relative path");
    },
  };
}

async function readUploadedText(operation, call, fileInput) {
  if (operation.bodyMode === "file") return Buffer.from(call.rawBody ?? []).toString();
  const uploadedFile = call.formData?.get(fileInput.wireName);
  return uploadedFile instanceof Blob ? uploadedFile.text() : undefined;
}

function unreadableFileTest(contract, operation, fileInput) {
  return {
    name: `${operation.name} refuses a FIFO and a \`${fileInput.paramName}\` over ${fileInput.maxBytes} bytes`,
    run: async () => {
      const { allowedDirectory } = createUploadFixture(contract, operation);
      const environment = { [fileInput.envName]: allowedDirectory };
      // A sparse file: over the cap without writing that many bytes.
      const oversizedPath = join(allowedDirectory, "oversized.wav");
      const fileDescriptor = openSync(oversizedPath, "w");
      ftruncateSync(fileDescriptor, fileInput.maxBytes + 1);
      closeSync(fileDescriptor);
      await assertRefused(contract, operation, argsWithFile(contract, operation, fileInput, oversizedPath), environment, "oversized file");
      const fifoPath = join(allowedDirectory, "pipe.wav");
      if (spawnSync("mkfifo", [fifoPath]).status !== 0) return;
      await assertRefused(contract, operation, argsWithFile(contract, operation, fileInput, fifoPath), environment, "FIFO");
    },
  };
}

function plainHttpUrlTest(contract, operation, fileInput) {
  return {
    name: `${operation.name} refuses a non-https \`${fileInput.paramName}\` URL`,
    run: () => assertRefused(contract, operation, argsWithFile(contract, operation, fileInput, "http://files.contract.example/clip.wav"), {}, "http URL"),
  };
}

function uploadRedactionTests(contract, operation, fileInput) {
  if (operation.bodyMode !== "file" || !contract.credential || operation.job || operation.response?.binary) return [];
  return [{
    name: `${operation.name} redacts a credential echoed in the upload response`,
    run: async () => {
      const dataPath = operation.response?.dataPath;
      const echoingBody = dataPath ? writePath({ contract_echo: contract.credential }, dataPath, { echo: contract.credential }) : { contract_echo: contract.credential };
      const { args } = contract.operationCases[operation.name];
      const { output, error } = await runContractOperation(contract, operation.name, args, { responses: [{ body: echoingBody }], source: operation.nodeOnly ? "node" : "tool" });
      if (error) throw error;
      assert.equal(JSON.stringify(output).includes(contract.credential), false, `credential leaked: ${JSON.stringify(output).slice(0, 300)}`);
      assert.ok(fileInput.paramName in args, "the case passes a file");
    },
  }];
}
