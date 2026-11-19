/**
 * `download_item`: saves a file's content into ONEDRIVE_DOWNLOAD_DIR. Written by hand because Graph's
 * `/items/{id}/content` answers 302 to a pre-authenticated URL on another host
 * (https://learn.microsoft.com/en-us/graph/api/driveitem-get-content): a declarative binary response would follow
 * that redirect with whatever the fetch implementation does with the Authorization header. Instead the operation
 * reads the item's `@microsoft.graph.downloadUrl` (with the bearer token, on graph.microsoft.com) and downloads it
 * with the shared public-https fetch, which sends no credential and checks every redirect hop. The URL must be on
 * a OneDrive or SharePoint host, and it is never returned.
 */
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";
import { downloadPublicHttpsToFile } from "./shared/public-https-fetch.mjs";

export const DOWNLOAD_DIR_ENV = "ONEDRIVE_DOWNLOAD_DIR";
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 540000;
// Where Graph's pre-authenticated download URLs point: OneDrive personal (*.1drv.com, *.livefilestore.com) and
// OneDrive for Business / SharePoint (*.sharepoint.com). Personal OneDrive now also serves them from
// *.microsoftpersonalcontent.com.
const DOWNLOAD_HOST_SUFFIXES = [".1drv.com", ".livefilestore.com", ".sharepoint.com", ".onedrive.com", ".microsoftpersonalcontent.com"];
const ITEM_SELECT = "id,name,size,file,@microsoft.graph.downloadUrl";

export const downloadItemOperation = {
  name: "download_item",
  title: "Download file",
  description: `Download a file's content into $${DOWNLOAD_DIR_ENV} (up to 250 MB); returns {item, path, bytes, content_type}`,
  parameters: {
    type: "object",
    properties: { item_id: { type: "string", description: "File item id (from list_children, search or get_item)" } },
    required: ["item_id"],
  },
  run: (context) => downloadItem(context),
};

async function downloadItem({ client, args, environment, signal }) {
  const directory = readDownloadDirectory(environment);
  const item = await client.request({ path: `/me/drive/items/${pathSegment(args.item_id)}`, query: { $select: ITEM_SELECT }, signal, redactResponse: true });
  const downloadUrl = readDownloadUrl(item);
  const savedFile = await downloadPublicHttpsToFile(downloadUrl, {
    directory,
    fileBaseName: `download_item-${Date.now()}-${randomBytes(3).toString("hex")}`,
    fetchImpl: client.fetchImpl,
    resolveHostAddresses: client.resolveHostAddresses,
    signal,
    maxBytes: MAX_DOWNLOAD_BYTES,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    label: "download_item",
  }).catch((downloadError) => {
    throw hideDownloadUrl(downloadError, downloadUrl);
  });
  return { data: { item: { id: item.id, name: item.name, size: item.size }, path: savedFile.path, bytes: savedFile.bytes, content_type: savedFile.content_type }, next_cursor: null };
}

/**
 * Removes the pre-authenticated download URL from a download error: anyone holding it can read the file.
 *
 * @param downloadError - Error from the download (Error)
 * @param downloadUrl - The URL to hide (string)
 * @returns The error with the URL replaced, same kind and retryability (Error)
 */
export function hideDownloadUrl(downloadError, downloadUrl) {
  if (!(downloadError instanceof PluginError) || !downloadError.message.includes(downloadUrl)) return downloadError;
  const message = downloadError.message.split(downloadUrl).join("[pre-authenticated download URL]");
  return new PluginError(message, { kind: downloadError.kind, retryable: downloadError.retryable });
}

function readDownloadDirectory(environment) {
  const directory = environment?.[DOWNLOAD_DIR_ENV]?.trim();
  if (!directory || !isAbsolute(directory)) {
    throw new PluginError(`download_item saves the file to disk: set ${DOWNLOAD_DIR_ENV} to an absolute directory path`, { kind: "invalid_input" });
  }
  return directory;
}

/**
 * Reads and checks an item's pre-authenticated download URL.
 *
 * @param item - driveItem with `@microsoft.graph.downloadUrl` (object)
 * @returns The URL (string)
 * @throws PluginError kind `invalid_input` - Not a file (folders have no content), or the URL is not https on a
 *   OneDrive/SharePoint host
 */
export function readDownloadUrl(item) {
  const downloadUrl = item?.["@microsoft.graph.downloadUrl"];
  if (!item?.file || typeof downloadUrl !== "string") {
    throw new PluginError("download_item works on files only (this item has no file content to download)", { kind: "invalid_input" });
  }
  const parsedUrl = URL.canParse(downloadUrl) ? new URL(downloadUrl) : null;
  const isOneDriveHost = parsedUrl?.protocol === "https:" && DOWNLOAD_HOST_SUFFIXES.some((suffix) => parsedUrl.hostname.toLowerCase().endsWith(suffix));
  if (!isOneDriveHost) {
    throw new PluginError(`Refusing the download URL host ${parsedUrl?.hostname ?? "(invalid URL)"}: only OneDrive and SharePoint download hosts are allowed`, { kind: "invalid_input" });
  }
  return downloadUrl;
}
