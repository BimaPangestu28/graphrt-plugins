/**
 * Media operations: upload a file from a URL to get a media id for send_media,
 * read a media URL (e.g. for media ids from incoming-message webhooks), delete media.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { pathSegment } from "../lib/shared/path.mjs";
import { defaultFileName, downloadMedia, MEDIA_RULES } from "../lib/media-download.mjs";
import { PHONE_NUMBER_ID_PROPERTY, phoneNumberIdOf } from "./messaging.mjs";

// Large documents (up to 100 MB) need far more than the client's 30 s default; together with the
// 120 s download this stays inside the operation's 300 s limit.
export const UPLOAD_TIMEOUT_MS = 170000;
const MEDIA_ID_PROPERTY = { type: "string", description: "Media id" };
const OWNER_PHONE_NUMBER_ID_PROPERTY = { type: "string", description: "Optional: only succeed if the media belongs to this phone number id" };

function buildUploadForm(fileBlob, filename) {
  const uploadForm = new FormData();
  uploadForm.append("messaging_product", "whatsapp");
  uploadForm.append("type", fileBlob.type);
  uploadForm.append("file", fileBlob, filename || defaultFileName(fileBlob.type));
  return uploadForm;
}

async function uploadMediaFromUrl({ client, args, environment, signal }) {
  const path = `/${pathSegment(phoneNumberIdOf(args, environment))}/media`;
  const downloadOptions = { url: args.url, mediaType: args.media_type, mimeTypeOverride: args.mime_type, signal, resolveHostAddresses: client.resolveHostAddresses };
  const fileBlob = await downloadMedia(client.fetchImpl, downloadOptions);
  // No json/form option: the client passes the FormData through and fetch sets the multipart boundary.
  const uploadResponse = await client.request({
    method: "POST",
    path,
    body: buildUploadForm(fileBlob, args.filename),
    signal,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  if (!uploadResponse?.id) throw new PluginError("WhatsApp accepted the upload but returned no media id", { kind: "api_error" });
  return { data: { id: uploadResponse.id, mime_type: fileBlob.type, file_size: fileBlob.size } };
}

export const mediaOperations = [
  {
    name: "upload_media",
    title: "Upload WhatsApp media",
    description:
      "Download a file from a public https URL and upload it to WhatsApp; returns data.id for send_media. Limits: image 5 MB, video/audio 16 MB, document 100 MB, sticker 500 KB.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public https URL of the file" },
        media_type: { type: "string", enum: Object.keys(MEDIA_RULES), description: "How the file will be sent (image, video, audio, document or sticker)" },
        mime_type: { type: "string", description: "MIME type to use when the server reports no Content-Type or application/octet-stream (ignored otherwise)" },
        filename: { type: "string", description: "File name for the upload (default: upload.<extension from the MIME type>)" },
        phone_number_id: PHONE_NUMBER_ID_PROPERTY,
      },
      required: ["url", "media_type"],
    },
    run: uploadMediaFromUrl,
  },
  {
    name: "get_media_url",
    title: "Get WhatsApp media URL",
    description:
      "Get the download URL, MIME type, size and sha256 of a media id. The URL expires after 5 minutes and needs the access token to download.",
    parameters: { type: "object", properties: { media_id: MEDIA_ID_PROPERTY, phone_number_id: OWNER_PHONE_NUMBER_ID_PROPERTY }, required: ["media_id"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ path: `/${pathSegment(args.media_id)}`, query: { phone_number_id: args.phone_number_id }, signal }),
    }),
  },
  {
    name: "delete_media",
    title: "Delete WhatsApp media",
    description: "Delete uploaded media by id.",
    parameters: { type: "object", properties: { media_id: MEDIA_ID_PROPERTY, phone_number_id: OWNER_PHONE_NUMBER_ID_PROPERTY }, required: ["media_id"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "DELETE", path: `/${pathSegment(args.media_id)}`, query: { phone_number_id: args.phone_number_id }, signal }),
    }),
  },
];
