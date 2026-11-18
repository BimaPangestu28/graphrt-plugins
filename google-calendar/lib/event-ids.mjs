/**
 * Client-generated Google Calendar event ids.
 *
 * Calendar accepts an `id` on insert if it uses base32hex characters (lowercase a-v and 0-9) and
 * is 5 to 1024 characters long. Sending our own id makes inserts safe to retry: a repeated insert
 * gets 409 `duplicate` instead of creating a second event.
 */
import { createHash, randomBytes } from "node:crypto";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const BASE32HEX_ALPHABET = "0123456789abcdefghijklmnopqrstuv";
const EVENT_ID_PATTERN = /^[a-v0-9]{5,1024}$/;
const KEY_NAMESPACE = "graphrt-google-calendar-event\u0000";
const RANDOM_ID_BYTES = 20;

/**
 * Encodes bytes as lowercase base32hex without padding.
 *
 * @param bytes - Input (Uint8Array)
 * @returns Encoded text (string)
 */
export function encodeBase32Hex(bytes) {
  let encoded = "";
  let bitBuffer = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      encoded += BASE32HEX_ALPHABET[(bitBuffer >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
    bitBuffer &= (1 << bitCount) - 1;
  }
  return bitCount > 0 ? encoded + BASE32HEX_ALPHABET[(bitBuffer << (5 - bitCount)) & 31] : encoded;
}

/**
 * Derives a stable event id from an idempotency key (SHA-256, base32hex, 52 characters).
 *
 * @param idempotencyKey - Caller's key, e.g. an order or booking id (string)
 * @returns Event id (string)
 *
 * @example
 * deriveEventId("booking-42") === deriveEventId("booking-42"); // true
 */
export function deriveEventId(idempotencyKey) {
  return encodeBase32Hex(createHash("sha256").update(KEY_NAMESPACE + idempotencyKey).digest());
}

/**
 * Creates a random event id (160 bits, 32 characters).
 *
 * @param randomBytesImpl - `(size) => Uint8Array` (function, default crypto.randomBytes)
 * @returns Event id (string)
 */
export function generateRandomEventId(randomBytesImpl = randomBytes) {
  return encodeBase32Hex(randomBytesImpl(RANDOM_ID_BYTES));
}

/**
 * Checks a caller-supplied event id against Google's rules for new ids.
 *
 * @param eventId - Candidate id (string)
 * @returns The id (string)
 * @throws PluginError kind `invalid_input`
 */
export function assertValidNewEventId(eventId) {
  if (!EVENT_ID_PATTERN.test(eventId)) {
    throw new PluginError("`event_id` must be 5-1024 characters of lowercase a-v and 0-9 (base32hex)", { kind: "invalid_input" });
  }
  return eventId;
}
