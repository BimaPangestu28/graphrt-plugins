# image-tools operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `image-tools.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `metadata` | Format, displayed width and height (after EXIF orientation), channels, colour space, alpha, density, pages and whether EXIF/ICC/XMP data is present | **input** |
| `resize` | Resizes to target_width and/or target_height (the other side keeps the aspect ratio). `fit` decides how both sides are used: inside (default), cover (crop), contain (pad), fill (stretch), outside | **input**, target_width, target_height, fit, enlarge, background, format, quality, output_name |
| `crop` | Cuts out a rectangle given by left, top, crop_width and crop_height in pixels of the displayed (auto-oriented) image | **input**, **left**, **top**, **crop_width**, **crop_height**, format, quality, output_name |
| `rotate` | Rotates by any angle (multiples of 90 are lossless in size; other angles fill corners with `background`) and optionally mirrors vertically (flip) or horizontally (flop) | **input**, angle, flip, flop, background, format, quality, output_name |
| `convert` | Re-encodes an image as jpeg, png, webp, avif, gif or tiff | **input**, **format**, quality, output_name |
| `compress` | Re-encodes at a lower quality (default 75) without metadata, optionally capping the longest side; reports the size saved | **input**, quality, max_dimension, format, output_name |
| `thumbnails` | Writes up to 10 thumbnails of one image at the given widths (aspect ratio kept, never enlarged), default webp | **input**, widths, format, quality, output_name |
| `watermark` | Places a text line or a second image (scaled to a share of the width) on an image at one of nine positions, with margin and opacity | **input**, text, image, placement, margin, opacity, font_size, color, image_scale, format, quality, output_name |
