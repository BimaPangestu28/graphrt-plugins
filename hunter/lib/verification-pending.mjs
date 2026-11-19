/**
 * Hunter's Email Verifier runs for up to 20 s; when it has not finished it answers HTTP 202 ("the verification is
 * still in progress") with no documented body, and the same call should be made again later (Hunter counts the
 * repeat as the same request). The declarative layer does not expose the status code, so this wrapper watches
 * the response status on the run's client and turns a 202 into an explicit pending result.
 */
export const PENDING_HINT = "Hunter is still verifying this address (HTTP 202); call verify_email again with the same email in a few seconds. Hunter counts the repeat as the same request.";

function recordStatuses(client, statuses) {
  return {
    ...client,
    requestWithHeaders: async (request) => {
      const response = await client.requestWithHeaders(request);
      statuses.push(response?.status);
      return response;
    },
  };
}

/**
 * Wraps verify_email: a 202 answer becomes `{status: "pending", hint, response}`.
 *
 * @param operation - Built verify_email operation (object)
 * @returns Operation with the pending mapping (object)
 */
export function reportPendingVerification(operation) {
  return {
    ...operation,
    run: async (context) => {
      const statuses = [];
      const result = await operation.run({ ...context, client: recordStatuses(context.client, statuses) });
      if (statuses.at(-1) !== 202) return result;
      return { ...result, data: { status: "pending", hint: PENDING_HINT, response: result?.data ?? null } };
    },
  };
}
