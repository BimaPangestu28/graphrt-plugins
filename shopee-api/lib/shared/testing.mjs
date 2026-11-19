/**
 * Test helpers for plugin operations: a fetch double that records requests
 * and replays canned responses.
 */

/**
 * Creates a fake fetch that returns `responses` in order and records each call.
 *
 * @param responses - Items `{status?, body?, headers?}` (Array<object>)
 * @returns fetch-compatible function with a `calls` array of `{url, method, headers, body, json}`
 *
 * @example
 * const fakeFetch = createRecordingFetch([{ body: { id: "1" } }]);
 * await runOperation("create_post", { message: "hi" });
 * assert.equal(fakeFetch.calls[0].method, "POST");
 */
export function createRecordingFetch(responses = []) {
  const remainingResponses = [...responses];
  const calls = [];
  const recordingFetch = async (url, init = {}) => {
    calls.push(describeCall(url, init));
    const { status = 200, body = {}, headers = {} } = remainingResponses.shift() ?? {};
    const responseText = status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(responseText, { status, headers: { "content-type": "application/json", ...headers } });
  };
  recordingFetch.calls = calls;
  return recordingFetch;
}

function describeCall(url, init) {
  const parsedUrl = new URL(String(url));
  const body = typeof init.body === "string" ? init.body : undefined;
  return {
    url: parsedUrl.toString(),
    path: parsedUrl.pathname,
    query: Object.fromEntries(parsedUrl.searchParams),
    queryEntries: [...parsedUrl.searchParams],
    formData: init.body instanceof FormData ? init.body : undefined,
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    body,
    json: parseJson(body),
    form: init.headers?.["content-type"] === "application/x-www-form-urlencoded" ? Object.fromEntries(new URLSearchParams(body)) : undefined,
  };
}

function parseJson(body) {
  try {
    return body === undefined ? undefined : JSON.parse(body);
  } catch {
    return undefined;
  }
}
