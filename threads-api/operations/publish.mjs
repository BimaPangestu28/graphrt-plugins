/**
 * Threads publishing: create a media container, wait until Threads has
 * processed it, then publish it. Carousels create one container per item first.
 */
import { rejectInput } from "../lib/client.mjs";
import { pollUntilDone, resolvePollInterval } from "../lib/shared/polling.mjs";

const CONTAINER_POLL_INTERVAL_MS = 5000;
const CONTAINER_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TEXT_CHARACTERS = 500;
const MIN_CAROUSEL_ITEMS = 2;
const MAX_CAROUSEL_ITEMS = 20;
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 4;
const POLL_OPTION_KEYS = ["option_a", "option_b", "option_c", "option_d"];
const DONE_STATUSES = new Set(["FINISHED", "PUBLISHED"]);
const FAILED_STATUSES = new Set(["ERROR", "EXPIRED"]);

export const publishOperations = [
  {
    name: "publish_thread",
    title: "Publish thread",
    description:
      "Publish a Threads post: TEXT, IMAGE, VIDEO or CAROUSEL (2-20 items) from public media URLs, optionally as a reply or quote, with a poll, link, topic tag or reply controls. Waits for Threads to process the media (up to 5 minutes).",
    parameters: {
      type: "object",
      properties: {
        media_type: { type: "string", enum: ["TEXT", "IMAGE", "VIDEO", "CAROUSEL"], default: "TEXT" },
        text: { type: "string", description: `Post text, at most ${MAX_TEXT_CHARACTERS} characters (required for TEXT)` },
        image_url: { type: "string", description: "Public image URL (IMAGE)" },
        video_url: { type: "string", description: "Public video URL (VIDEO)" },
        alt_text: { type: "string", description: "Alt text for IMAGE/VIDEO" },
        carousel_items: {
          type: "array",
          maxItems: MAX_CAROUSEL_ITEMS,
          items: { type: "object" },
          description: "CAROUSEL: 2-20 items, each {image_url} or {video_url}, optional alt_text",
        },
        reply_to_id: { type: "string", description: "Publish as a reply to this media id" },
        quote_post_id: { type: "string", description: "Quote this media id" },
        reply_control: {
          type: "string",
          enum: ["everyone", "accounts_you_follow", "mentioned_only", "parent_post_author_only", "followers_only"],
          description: "Who can reply",
        },
        poll_options: {
          type: "array",
          maxItems: MAX_POLL_OPTIONS,
          items: { type: "string" },
          description: "2-4 poll options (TEXT posts)",
        },
        link_attachment: { type: "string", description: "URL shown as a link preview (TEXT posts)" },
        topic_tag: { type: "string", description: "Topic tag, without #" },
      },
    },
    run: publishThread,
  },
];

async function publishThread({ client, args, environment, signal }) {
  validatePublishArguments(args);
  const containerSettings = { client, environment, signal };
  const containerForm = buildContainerForm(args);
  if (args.media_type === "CAROUSEL") {
    containerForm.children = (await createCarouselChildren(containerSettings, args.carousel_items)).join(",");
  }
  const containerId = await createReadyContainer(containerSettings, containerForm);
  const published = await client.request({ method: "POST", path: "/me/threads_publish", form: { creation_id: containerId }, signal });
  return { data: { id: published.id, container_id: containerId } };
}

function validatePublishArguments(args) {
  // Count code points so emoji count as one character, as Threads does.
  if (args.text !== undefined && [...args.text].length > MAX_TEXT_CHARACTERS) {
    rejectInput(`\`text\` must be at most ${MAX_TEXT_CHARACTERS} characters`);
  }
  if (args.poll_options !== undefined && args.poll_options.length < MIN_POLL_OPTIONS) {
    rejectInput(`\`poll_options\` needs ${MIN_POLL_OPTIONS}-${MAX_POLL_OPTIONS} options`);
  }
  const requiredMedia = { TEXT: "text", IMAGE: "image_url", VIDEO: "video_url" }[args.media_type];
  if (requiredMedia && !args[requiredMedia]) rejectInput(`${args.media_type} needs \`${requiredMedia}\``);
  if (args.media_type === "CAROUSEL") validateCarouselItems(args.carousel_items);
}

function validateCarouselItems(carouselItems) {
  if (!Array.isArray(carouselItems) || carouselItems.length < MIN_CAROUSEL_ITEMS) {
    rejectInput(`CAROUSEL needs ${MIN_CAROUSEL_ITEMS}-${MAX_CAROUSEL_ITEMS} \`carousel_items\``);
  }
  carouselItems.forEach((carouselItem, index) => {
    if (!carouselItem?.image_url && !carouselItem?.video_url) rejectInput(`carousel_items[${index}] needs \`image_url\` or \`video_url\``);
  });
}

function buildContainerForm(args) {
  const isSingleMedia = args.media_type === "IMAGE" || args.media_type === "VIDEO";
  return {
    media_type: args.media_type,
    text: args.text,
    image_url: args.media_type === "IMAGE" ? args.image_url : undefined,
    video_url: args.media_type === "VIDEO" ? args.video_url : undefined,
    alt_text: isSingleMedia ? args.alt_text : undefined,
    reply_to_id: args.reply_to_id,
    quote_post_id: args.quote_post_id,
    reply_control: args.reply_control,
    poll_attachment: buildPollAttachment(args.poll_options),
    link_attachment: args.link_attachment,
    topic_tag: args.topic_tag,
  };
}

function buildPollAttachment(pollOptions) {
  if (!pollOptions) return undefined;
  return Object.fromEntries(pollOptions.map((pollOption, index) => [POLL_OPTION_KEYS[index], pollOption]));
}

async function createCarouselChildren(containerSettings, carouselItems) {
  const childIds = [];
  for (const carouselItem of carouselItems) {
    const childForm = carouselItem.video_url
      ? { is_carousel_item: true, media_type: "VIDEO", video_url: carouselItem.video_url, alt_text: carouselItem.alt_text }
      : { is_carousel_item: true, media_type: "IMAGE", image_url: carouselItem.image_url, alt_text: carouselItem.alt_text };
    childIds.push(await createReadyContainer(containerSettings, childForm));
  }
  return childIds;
}

async function createReadyContainer({ client, environment, signal }, containerForm) {
  const container = await client.request({ method: "POST", path: "/me/threads", form: containerForm, signal });
  await pollUntilDone({
    readStatus: () => client.request({ path: `/${encodeURIComponent(container.id)}`, query: { fields: "status,error_message" }, signal }),
    isDone: (statusResult) => DONE_STATUSES.has(statusResult.status),
    isFailed: (statusResult) =>
      FAILED_STATUSES.has(statusResult.status) ? `${statusResult.status}: ${statusResult.error_message ?? "no details"}` : false,
    intervalMs: resolvePollInterval(environment, CONTAINER_POLL_INTERVAL_MS),
    timeoutMs: CONTAINER_POLL_TIMEOUT_MS,
    signal,
  });
  return container.id;
}
