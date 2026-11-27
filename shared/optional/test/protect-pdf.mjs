/**
 * Test helper: protects a PDF the way publishers do. Lives in
 * shared/optional/test and is copied into the plugins that open protected
 * PDFs.
 */
import { createRequire } from "node:module";

/**
 * Protects a PDF the way publishers do, with qpdf (the package the plugin opens protected PDFs with).
 *
 * @param bytes - PDF bytes (Uint8Array)
 * @param protection - `{openPassword, permissionsPassword, bits, isFillingAllowed, restrictions}`; bits 40, 128 (RC4), "128-aes" or 256; `restrictions` replaces the qpdf switches that say what is allowed, e.g. ["--extract=n", "--modify=none"] (object)
 * @returns Protected PDF bytes (Uint8Array)
 */
export async function protectPdf(bytes, { openPassword = "", permissionsPassword = "publisher-only", bits = 256, isFillingAllowed = true, restrictions = null } = {}) {
  const require = createRequire(import.meta.url);
  // qpdf's remarks about old protection formats stay out of the test output.
  const qpdf = await require("@neslinesli93/qpdf-wasm")({ locateFile: () => require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm"), noFSInit: true, preRun: [(module) => module.FS.init(() => null, () => {}, () => {})] });
  qpdf.FS.writeFile("/plain.pdf", bytes);
  const keyBits = String(bits).replace("-aes", "");
  // The 40-bit format has one switch for both; the others keep "fill in forms" apart from "annotate".
  const fillingRestrictions = keyBits === "40" ? [`--modify=${isFillingAllowed ? "y" : "n"}`, `--annotate=${isFillingAllowed ? "y" : "n"}`] : [`--modify=${isFillingAllowed ? "form" : "none"}`];
  const exitCodeBefore = process.exitCode;
  const exitCode = qpdf.callMain(["/plain.pdf", "--allow-weak-crypto", "--encrypt", `--user-password=${openPassword}`, `--owner-password=${permissionsPassword}`, `--bits=${keyBits}`, ...(restrictions ?? [...fillingRestrictions, "--extract=n"]), ...(bits === 128 ? ["--use-aes=n"] : bits === "128-aes" ? ["--use-aes=y"] : []), "--", "/protected.pdf"]);
  process.exitCode = exitCodeBefore;
  if (exitCode !== 0) throw new Error(`qpdf could not protect the test PDF (exit ${exitCode})`);
  return qpdf.FS.readFile("/protected.pdf");
}
