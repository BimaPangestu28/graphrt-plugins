/**
 * Parameter schemas shared by the image-tools operations.
 */
import { OUTPUT_FORMATS } from "../lib/client.mjs";

export { OUTPUT_NAME_PARAMETER } from "../lib/file-access.mjs";

export const MAX_OUTPUT_DIMENSION = 16383;
export const INPUT_PARAMETER = {
  type: "string",
  description: "Image file (jpeg, png, webp, gif, tiff, avif, heif) inside IMAGE_TOOLS_INPUT_DIRS (or IMAGE_TOOLS_OUTPUT_DIR); absolute, ~/..., or relative to the first input directory",
};
export const FORMAT_PARAMETER = { type: "string", enum: OUTPUT_FORMATS, description: "Output format (default: the input's format; heif becomes jpeg)" };
export const QUALITY_PARAMETER = { type: "integer", minimum: 1, maximum: 100, description: "Encoder quality 1-100 (jpeg, webp, avif, tiff; for png it enables palette quantisation)" };
export const DIMENSION_SCHEMA = { type: "integer", minimum: 1, maximum: MAX_OUTPUT_DIMENSION };
