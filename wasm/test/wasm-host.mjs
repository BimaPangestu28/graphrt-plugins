/**
 * A minimal graphrt WebAssembly host for tests: loads a plugin module with Node's WebAssembly API and serves its
 * imports the way graphrt does (ABI version 1: `graphrt::log|chunk|progress|http`, a fresh instance per call).
 * `graphrt::http` is answered synchronously by the test's `respond` function, like a mock fetch.
 */
import { readFileSync } from "node:fs";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Compiles a module once.
 *
 * @param modulePath - Path of the .wasm file (string)
 * @returns `{describe, callTool}` (object)
 */
export function loadWasmPlugin(modulePath) {
  const compiled = new WebAssembly.Module(readFileSync(modulePath));
  return {
    describe: () => JSON.parse(withInstance(compiled, () => ({ error: { kind: "egress_denied", message: "no network" } }), (guest) => guest.call("graphrt_describe"))),
    /**
     * Runs `graphrt_tool_call` in a fresh instance.
     *
     * @param request - `{name, arguments, context, env}` (object)
     * @param respond - `(request) => {status, headers?, body} | {error: {kind, message}}` for each `graphrt::http` call (function)
     * @returns The guest's tool response (object)
     */
    callTool: (request, respond) => JSON.parse(withInstance(compiled, respond, (guest) => guest.call("graphrt_tool_call", JSON.stringify(request)))),
  };
}

function withInstance(compiled, respond, use) {
  let exports;
  const memoryBytes = () => new Uint8Array(exports.memory.buffer);
  const readText = (pointer, length) => decoder.decode(memoryBytes().slice(pointer, pointer + length));
  const writeText = (text) => {
    const bytes = encoder.encode(text);
    const pointer = exports.graphrt_alloc(bytes.length);
    memoryBytes().set(bytes, pointer);
    return [pointer, bytes.length];
  };
  const pack = ([pointer, length]) => BigInt.asIntN(64, (BigInt(pointer) << 32n) | BigInt(length));
  const imports = {
    graphrt: {
      log: () => {},
      chunk: () => {},
      progress: () => {},
      http: (pointer, length) => pack(writeText(JSON.stringify(respond(JSON.parse(readText(pointer, length)))))),
    },
  };
  exports = new WebAssembly.Instance(compiled, imports).exports;
  if (exports.graphrt_abi_version() !== 1) throw new Error("unsupported ABI version");
  const guest = {
    call: (exportName, input) => {
      const packed = BigInt.asUintN(64, input === undefined ? exports[exportName]() : exports[exportName](...writeText(input)));
      return readText(Number(packed >> 32n), Number(packed & 0xffffffffn));
    },
  };
  return use(guest);
}
