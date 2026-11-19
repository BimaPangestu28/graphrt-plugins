/**
 * Apollo's add_contact_ids endpoint wants the sequence id twice: in the path and as the `emailer_campaign_id`
 * query parameter. This wrapper hides the second one from callers and fills it from `sequence_id`, and refuses a
 * call without contacts or lists before any request (Apollo would answer 422).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const CAMPAIGN_ID_PARAM = "emailer_campaign_id";

function withoutCampaignIdParameter(parameters) {
  const { [CAMPAIGN_ID_PARAM]: _filledIn, ...properties } = parameters.properties;
  return { ...parameters, properties, required: parameters.required.filter((name) => name !== CAMPAIGN_ID_PARAM) };
}

const isNonEmptyList = (value) => Array.isArray(value) && value.length > 0;

/**
 * Wraps add_contacts_to_sequence.
 *
 * @param operation - Built operation (object)
 * @returns Operation whose emailer_campaign_id is always sequence_id (object)
 */
export function fillSequenceCampaignId(operation) {
  return {
    ...operation,
    parameters: withoutCampaignIdParameter(operation.parameters),
    run: (context) => {
      if (!isNonEmptyList(context.args.contact_ids) && !isNonEmptyList(context.args.label_names)) {
        throw new PluginError("Give `contact_ids` or `label_names`", { kind: "invalid_input" });
      }
      return operation.run({ ...context, args: { ...context.args, [CAMPAIGN_ID_PARAM]: context.args.sequence_id } });
    },
  };
}
