/**
 * Opens protected (encrypted) PDFs with qpdf, compiled to WebAssembly: no
 * program to install, the same on Windows, macOS and Linux, and it runs
 * inside the worker process on an in-memory file system, so it touches no
 * file on disk.
 *
 * Two kinds of protection exist. Most official forms open without a
 * password and are encrypted only to carry restrictions (no editing, no
 * copying); they are opened the way every PDF reader opens them, with the
 * empty password. A PDF that asks for a password opens only with the
 * password the caller gives. A password is never guessed, and it is never
 * part of a message, a log line or a result.
 *
 * The result is a copy without protection, which pdf-lib can read. Whether
 * the publisher allows the form to be filled in is reported, not decided,
 * here (see pdf-form.mjs).
 */
import { createRequire } from "node:module";
import { invalidInput } from "./errors.mjs";

const MAX_PASSWORD_LENGTH = 256;
const INPUT_PATH = "/protected.pdf";
const OUTPUT_PATH = "/opened.pdf";
const DETAILS_PATH = "/protection.json";
const PASSWORD_PATH = "/password.txt";
// qpdf exit codes: 0 done, 3 done with warnings about a damaged file it repaired, 2 failed.
const QPDF_SUCCESS_CODES = new Set([0, 3]);
const ENCRYPT_MARKER = Buffer.from("/Encrypt", "latin1");

export const PASSWORD_NEEDED_MESSAGE = "This PDF asks for a password when it is opened. Give that password as `password`; it is used only to open the file and is not saved or shown anywhere";
export const PASSWORD_WRONG_MESSAGE = "The password that was given is not a password of this PDF. Check it and try again; a form that opens without a password needs none";

/**
 * Says whether a PDF can be protected at all: the entry that switches protection on is always written in plain
 * bytes, so a file without it is opened without starting qpdf.
 *
 * @param bytes - PDF bytes (Uint8Array)
 * @returns False when the PDF is certainly not protected (boolean)
 */
export function mayBeProtected(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(ENCRYPT_MARKER);
}

function assertPassword(password) {
  if (password === undefined || password === null || password === "") return null;
  if (typeof password !== "string") throw invalidInput("`password` must be a text");
  if (password.length > MAX_PASSWORD_LENGTH || /[\r\n]/.test(password)) throw invalidInput(`\`password\` must be one line of at most ${MAX_PASSWORD_LENGTH} characters`);
  return password;
}

// The same password in the two ways PDF files store one: Unicode (256-bit protection), and one byte per
// character (the older 40-bit and 128-bit protection), which exists only for Western European characters.
// Both spell the password that was given; no other password is ever tried.
function passwordSpellings(password) {
  const unicodeBytes = Buffer.from(password, "utf8");
  const isSingleByte = [...password].every((character) => character.codePointAt(0) <= 0xff);
  return isSingleByte && unicodeBytes.length !== password.length ? [unicodeBytes, Buffer.from(password, "latin1")] : [unicodeBytes];
}

// One qpdf instance with its own in-memory files. Its messages are collected instead of going to this process's
// stderr, and the exit code it sets on the process is put back.
async function startQpdf() {
  const require = createRequire(import.meta.url);
  const createQpdf = require("@neslinesli93/qpdf-wasm");
  const wasmPath = require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm");
  const messageBytes = [];
  const collectMessage = (charCode) => {
    if (charCode !== null) messageBytes.push(charCode);
  };
  const qpdf = await createQpdf({ locateFile: () => wasmPath, noFSInit: true, preRun: [(module) => module.FS.init(() => null, () => {}, collectMessage)] });
  return {
    files: qpdf.FS,
    run(qpdfArguments) {
      messageBytes.length = 0;
      const exitCodeBefore = process.exitCode;
      try {
        return qpdf.callMain([...qpdfArguments]);
      } finally {
        process.exitCode = exitCodeBefore;
      }
    },
    readMessage: () => Buffer.from(messageBytes).toString("utf8"),
  };
}

// qpdf's own words for what is wrong with the file, without its program and file names.
function describeFailure(qpdfMessage) {
  const firstLine = qpdfMessage.split("\n").find((line) => line.trim() !== "") ?? "";
  return firstLine.replace(/^.*?\/protected\.pdf(?: \([^)]*\))?:\s*/, "").trim().slice(0, 200) || "qpdf could not read it";
}

/**
 * Opens a PDF that may be protected and returns a copy without protection.
 *
 * @param request - `{bytes, password}`; password is only for a PDF that asks for one (object)
 * @returns `{bytes, protection}`; protection is null for a PDF that is not protected (the bytes are then the ones given), otherwise `{isFillingAllowed, isOpenedWithPassword}` (object)
 * @throws PluginError kind `invalid_input` - When the PDF needs a password that was not given or is wrong, or cannot be read
 */
export async function openProtectedPdf({ bytes, password }) {
  const givenPassword = assertPassword(password);
  const qpdf = await startQpdf();
  qpdf.files.writeFile(INPUT_PATH, bytes);
  // In a file of the in-memory file system: an argument starting with "@" or "-" would be read as an option.
  const passwordArguments = givenPassword === null ? [] : [`--password-file=${PASSWORD_PATH}`];
  const hasOpened = (qpdfArguments) => {
    for (const passwordBytes of givenPassword === null ? [null] : passwordSpellings(givenPassword)) {
      if (passwordBytes !== null) qpdf.files.writeFile(PASSWORD_PATH, passwordBytes);
      if (QPDF_SUCCESS_CODES.has(qpdf.run([...passwordArguments, ...qpdfArguments]))) return true;
      if (!/invalid password/i.test(qpdf.readMessage())) return false;
    }
    return false;
  };
  const runOrRefuse = (qpdfArguments) => {
    if (hasOpened(qpdfArguments)) return;
    const qpdfMessage = qpdf.readMessage();
    if (/invalid password/i.test(qpdfMessage)) throw invalidInput(givenPassword === null ? PASSWORD_NEEDED_MESSAGE : PASSWORD_WRONG_MESSAGE);
    throw invalidInput(`The template is not a PDF that can be opened here: ${describeFailure(qpdfMessage)}`);
  };
  runOrRefuse(["--json", "--json-key=encrypt", INPUT_PATH, DETAILS_PATH]);
  // Only these entries are read; the rest of qpdf's report stays in the in-memory file.
  const { encrypted: isEncrypted, capabilities, ownerpasswordmatched: isOwnerPassword } = JSON.parse(Buffer.from(qpdf.files.readFile(DETAILS_PATH)).toString("utf8")).encrypt;
  if (!isEncrypted) return { bytes, protection: null };
  runOrRefuse(["--decrypt", INPUT_PATH, OUTPUT_PATH]);
  return {
    bytes: qpdf.files.readFile(OUTPUT_PATH),
    protection: {
      // PDF permission bits 9 (fill in form fields) and 6 (annotate, which includes filling in); the
      // permissions password lifts every restriction.
      isFillingAllowed: Boolean(isOwnerPassword || capabilities?.modifyforms || capabilities?.modifyannotations),
      isOpenedWithPassword: givenPassword !== null,
    },
  };
}
