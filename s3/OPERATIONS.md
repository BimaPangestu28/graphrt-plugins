# s3 operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `s3.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_buckets` | List the buckets the credentials can see (name, creation date, region) | prefix, limit, cursor |
| `list_objects` | List objects in a bucket (ListObjectsV2): keys, sizes, dates; prefix and delimiter for folders; paginated with next_cursor | **bucket**, prefix, delimiter, start_after, limit, cursor |
| `head_object` | Read an object's size, content type, ETag, dates and user metadata without downloading it | **bucket**, **key**, version_id |
| `get_object` | Download an object: output "file" streams it into S3_DOWNLOAD_DIR (size-capped) and returns the path; output "text" returns up to S3_MAX_TEXT_BYTES as UTF-8 text with a truncated flag | **bucket**, **key**, output, file_name, range, version_id |
| `put_object` | Upload an object from a file inside S3_UPLOAD_DIR or from text; replaces an existing object unless only_if_absent (as an agent tool only when S3_TOOL_ALLOW_WRITES=1) | **bucket**, **key**, file_path, text, content_type, cache_control, content_disposition, storage_class, metadata, only_if_absent |
| `copy_object` | Copy an object (up to 5 GB) to another key or bucket on the server side (as an agent tool only when S3_TOOL_ALLOW_WRITES=1) | **source_bucket**, **source_key**, source_version_id, **bucket**, **key**, metadata_directive, metadata, content_type |
| `delete_object` | Delete an object (or one version of it); workflow nodes only | **bucket**, **key**, version_id |
| `presign_get_url` | Create a presigned GET URL that lets anyone holding it download the object until it expires; workflow nodes only | **bucket**, **key**, version_id, expires_in_seconds, response_content_disposition, response_content_type |
