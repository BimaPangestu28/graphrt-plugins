/**
 * Media operation: upload an image from a URL and get a media id for
 * create_post (tweet_image) or send_dm (dm_image).
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { downloadImage } from "../lib/image-download.mjs";

const IMAGE_FILE_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

function buildUploadForm(imageBlob, mediaCategory) {
  const uploadForm = new FormData();
  const fileExtension = IMAGE_FILE_EXTENSIONS[imageBlob.type] ?? "img";
  uploadForm.append("media", imageBlob, `upload.${fileExtension}`);
  uploadForm.append("media_category", mediaCategory);
  return uploadForm;
}

export const mediaOperations = [
  {
    name: "upload_media",
    title: "Upload X image",
    description: "Download an image (https, up to 5 MB) and upload it to X. Returns data.data.id for create_post media_ids or send_dm media_id.",
    parameters: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "Public https URL of a JPEG, PNG, GIF or WEBP image" },
        media_category: { type: "string", enum: ["tweet_image", "dm_image"], default: "tweet_image", description: "dm_image for DM attachments" },
      },
      required: ["image_url"],
    },
    run: async ({ client, args, signal }) => {
      const imageBlob = await downloadImage(args.image_url, { fetchImpl: client.fetchImpl, resolveHostAddresses: client.resolveHostAddresses, signal });
      // No json/form option: the client passes the FormData through and fetch sets the multipart boundary.
      const uploadResponse = await client.request({ method: "POST", path: "/2/media/upload", body: buildUploadForm(imageBlob, args.media_category), signal });
      if (!uploadResponse?.data?.id) throw new PluginError("X accepted the upload but returned no media id", { kind: "api_error" });
      return { data: uploadResponse };
    },
  },
];
