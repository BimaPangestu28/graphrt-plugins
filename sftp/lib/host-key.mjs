/**
 * Host key pinning: the server's key must match one of the SHA256
 * fingerprints in SFTP_HOST_FINGERPRINT (the `SHA256:...` form that
 * `ssh-keygen -l` prints). There is no trust-on-first-use.
 */
import { createHash } from "node:crypto";
import { setupRequired } from "./errors.mjs";

/**
 * Parses comma-separated SHA256 fingerprints (several allow a key rotation).
 *
 * @param text - e.g. "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8" (string)
 * @returns The base64 bodies without padding (string[])
 * @throws PluginError kind `setup_required` - When an entry is not a SHA256 fingerprint, or there is none
 */
export function parseFingerprints(text) {
  const fingerprints = text.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const body = /^sha256:/i.test(entry) ? entry.slice(7).replace(/=+$/, "") : null;
    if (!body || !/^[A-Za-z0-9+/]+$/.test(body)) throw setupRequired(`SFTP_HOST_FINGERPRINT entries must look like SHA256:<base64> (from ssh-keygen -l), got ${JSON.stringify(entry.slice(0, 80))}`);
    return body;
  });
  if (fingerprints.length === 0) throw setupRequired("SFTP_HOST_FINGERPRINT lists no fingerprints");
  return fingerprints;
}

/**
 * The SHA256 fingerprint of a raw host key blob, as `ssh-keygen -l` prints it.
 *
 * @param keyBlob - Host key in SSH wire format (Buffer)
 * @returns "SHA256:<base64 without padding>" (string)
 */
export function fingerprintHostKey(keyBlob) {
  return `SHA256:${createHash("sha256").update(keyBlob).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Builds ssh2's `hostVerifier`, remembering a rejected key's fingerprint for the error message.
 *
 * @param fingerprints - Allowed fingerprint bodies (string[])
 * @returns `{verify: (keyBlob) => boolean, rejectedFingerprint: () => string | null}` (object)
 */
export function createHostVerifier(fingerprints) {
  let rejectedFingerprint = null;
  return {
    verify: (keyBlob) => {
      const seen = fingerprintHostKey(keyBlob);
      const isPinned = fingerprints.includes(seen.slice(7));
      if (!isPinned) rejectedFingerprint = seen;
      return isPinned;
    },
    rejectedFingerprint: () => rejectedFingerprint,
  };
}
