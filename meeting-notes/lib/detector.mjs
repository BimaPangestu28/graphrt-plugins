/**
 * When a meeting counts as detected. Pure: time comes in with each observation.
 *
 * A meeting is detected once a meeting candidate has used the microphone for `confirmMs` (a quick mic check is not a
 * meeting). It is reported once: the next one is reported only after the microphone has been free for `releaseMs`
 * (the same meeting, a "Not now" answer, or a recording in progress are never offered twice).
 */

/** The state before anything was observed. */
export const INITIAL_STATE = Object.freeze({ fired: false, pending_since: null, last_in_use: null });

/**
 * One observation.
 *
 * @param state - `{fired, pending_since, last_in_use}` (object)
 * @param observation - `{now, inUse, isRecording}`: time (ms), whether a candidate uses the mic, whether this plugin
 *   records (object)
 * @param timing - `{confirmMs, releaseMs}` (object)
 * @returns `{state, detected}`: the next state and whether a meeting was just detected (object)
 */
export function observe(state, { now, inUse, isRecording }, { confirmMs, releaseMs }) {
  const lastInUse = inUse || isRecording ? now : state.last_in_use;
  const released = !inUse && !isRecording && (lastInUse === null || now - lastInUse >= releaseMs);
  if (state.fired || isRecording) {
    const fired = !released;
    return { state: { fired, pending_since: null, last_in_use: lastInUse }, detected: false };
  }
  if (!inUse) return { state: { fired: false, pending_since: null, last_in_use: lastInUse }, detected: false };
  const pendingSince = state.pending_since ?? now;
  if (now - pendingSince >= confirmMs) return { state: { fired: true, pending_since: null, last_in_use: lastInUse }, detected: true };
  return { state: { fired: false, pending_since: pendingSince, last_in_use: lastInUse }, detected: false };
}
