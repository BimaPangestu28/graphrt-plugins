# google-vision operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-vision.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `detect_text` | OCR an image: returns {text, locale}. mode dense (default) for documents and photos of pages, sparse for signs and labels | image, image_base64, mode, language_hints |
| `detect_labels` | Describe what an image shows: [{label, score, topicality, mid}], best first | image, image_base64, max_results |
| `detect_faces` | Find faces with bounding boxes and emotion likelihoods (joy, sorrow, anger, surprise); no identity recognition | image, image_base64, max_results, include_landmarks |
| `detect_safe_search` | Likelihood that an image is adult, spoof, medical, violent or racy (VERY_UNLIKELY ... VERY_LIKELY) | image, image_base64 |
| `analyze_image` | Run several Vision features on one image (logos, landmarks, objects, colors, web matches, ...) and return Vision's response | image, image_base64, features, max_results, language_hints |
| `annotate_images` | Vision's images:annotate for up to 16 images: responses[i] belongs to requests[i] and may hold its own error | **requests** |
| `annotate_files` | OCR up to 5 pages of one inline PDF, TIFF or GIF: responses[0].responses[page] | **requests** |
