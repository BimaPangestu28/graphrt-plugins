/**
 * Mailchimp member addressing. Member endpoints take `{subscriber_hash}`, the MD5 of the lower-cased email
 * (https://mailchimp.com/developer/marketing/docs/methods-parameters/). The wrappers here let callers pass `email`
 * (or, for upserts, the `email_address` they send anyway) and compute the hash, so no caller hashes by hand.
 */
import { createHash } from "node:crypto";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const EMAIL_PROPERTY = { type: "string", minLength: 3, description: "Member email address (used instead of subscriber_hash)" };

/**
 * Computes Mailchimp's subscriber hash.
 *
 * @param emailAddress - Member email (string)
 * @returns Lower-case hex MD5 of the trimmed, lower-cased address (string)
 *
 * @example
 * computeSubscriberHash("Ada@Example.com"); // "3e3417d7ef77d5932a6734b916515ed5"
 */
export function computeSubscriberHash(emailAddress) {
  return createHash("md5").update(emailAddress.trim().toLowerCase()).digest("hex");
}

/**
 * Wraps a declarative member operation so `subscriber_hash` may be replaced by `email` (or `email_address`).
 *
 * @param operation - Generated operation with a `subscriber_hash` path param (object)
 * @returns Operation whose schema adds `email` and no longer requires `subscriber_hash` (object)
 */
export function wrapMemberOperation(operation) {
  const { properties, required } = operation.parameters;
  return {
    ...operation,
    parameters: {
      ...operation.parameters,
      properties: { ...properties, email: EMAIL_PROPERTY },
      required: required.filter((paramName) => paramName !== "subscriber_hash"),
    },
    run: (context) => operation.run({ ...context, args: resolveSubscriberHash(context.args) }),
  };
}

/**
 * Fills `subscriber_hash` from `email` (or `email_address`), or checks that a given hash matches them.
 *
 * @param args - Operation arguments (object)
 * @returns Arguments with `subscriber_hash` and without `email` (object)
 * @throws PluginError kind `invalid_input` - No way to address the member, or a hash for another address
 */
export function resolveSubscriberHash(args) {
  const { email, ...forwardedArgs } = args;
  const memberEmail = email ?? forwardedArgs.email_address;
  if (forwardedArgs.subscriber_hash !== undefined) {
    assertHashMatchesEmails(forwardedArgs.subscriber_hash, [email, forwardedArgs.email_address]);
    return forwardedArgs;
  }
  if (typeof memberEmail !== "string" || memberEmail.trim() === "") {
    throw new PluginError("Pass `email` (or `subscriber_hash`, the MD5 of the lower-cased email) to address a member", { kind: "invalid_input" });
  }
  return { ...forwardedArgs, subscriber_hash: computeSubscriberHash(memberEmail) };
}

// A hash for one member with the email of another would update (or upsert into) the wrong member.
function assertHashMatchesEmails(subscriberHash, emailAddresses) {
  const givenHash = String(subscriberHash).trim().toLowerCase();
  for (const emailAddress of emailAddresses) {
    if (typeof emailAddress !== "string" || emailAddress.trim() === "") continue;
    if (computeSubscriberHash(emailAddress) !== givenHash) {
      throw new PluginError(`\`subscriber_hash\` does not match ${JSON.stringify(emailAddress.slice(0, 100))}; pass only the email, or the hash of the same address`, { kind: "invalid_input" });
    }
  }
}
