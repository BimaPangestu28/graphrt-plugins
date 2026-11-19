# s3

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **Amazon S3** and S3-compatible object storage
(Cloudflare R2, MinIO, Backblaze B2, Wasabi, ...). It talks to the S3 REST API directly. Requests are signed with
AWS Signature Version 4, implemented in [`lib/aws-sigv4.mjs`](lib/aws-sigv4.mjs) and checked against the official
AWS SigV4 test suite and the S3 documentation examples. No AWS SDK, no npm dependencies.

## Features
- **`list_buckets`**, **`list_objects`** (ListObjectsV2: prefix, delimiter "folders", `start_after`, pages of up to
  1000 keys with `next_cursor`). Keys are listed with `encoding-type=url` and decoded, so any key survives.
- **`head_object`:** size, content type, ETag, dates, storage class and `x-amz-meta-*` user metadata.
- **`get_object`:** `output: "file"` streams the object into `S3_DOWNLOAD_DIR` (size-capped, never overwrites a
  file); `output: "text"` returns at most `S3_MAX_TEXT_BYTES` as UTF-8 text with `truncated` and `total_bytes`
  (only that many bytes are requested, with a Range header). Optional `range` and `version_id`.
- **`put_object`:** from a file inside `S3_UPLOAD_DIR` or from `text`, with content type, cache control,
  content disposition, storage class, metadata and `only_if_absent` (`If-None-Match: *`).
- **`copy_object`:** server-side copy (up to 5 GB), keeping (`COPY`) or replacing (`REPLACE`) the metadata.
- **`delete_object`** and **`presign_get_url`** (node only, see Safety).
- Every operation is a node `s3.<operation>`; the agent tools are listed under Safety. Full reference:
  [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- An access key with only the permissions your workflow needs, e.g. `s3:ListAllMyBuckets`, `s3:ListBucket` and
  `s3:GetObject` for read-only use, plus `s3:PutObject` / `s3:DeleteObject` for writes. On R2, create an API token
  with "Object Read only" or "Object Read & Write" for specific buckets.

## Installation
```bash
graphrt plugin install ./s3
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | (none) | Standard AWS credentials (session token for temporary credentials) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` | (none) | Used instead of the AWS_* ones when set, so R2/MinIO keys can live next to AWS keys |
| `S3_REGION` (or `AWS_REGION`, `AWS_DEFAULT_REGION`) | `us-east-1` | Signing region. `auto` for Cloudflare R2. |
| `S3_ENDPOINT` | `https://s3.<region>.amazonaws.com` | Origin of an S3-compatible service, e.g. `https://<account-id>.r2.cloudflarestorage.com` or `http://localhost:9000`. https only, except http for localhost. |
| `S3_FORCE_PATH_STYLE` | `1` with `S3_ENDPOINT`, else `0` | `1`: `https://endpoint/bucket/key`; `0`: `https://bucket.endpoint/key`. On AWS, buckets with dots always use path style (TLS). |
| `S3_DOWNLOAD_DIR` | (off) | Absolute directory `get_object` may write into. Without it, only `output: "text"` works. |
| `S3_UPLOAD_DIR` | (off) | Absolute directory `put_object` may read files from. Without it, only `text` uploads work. |
| `S3_MAX_DOWNLOAD_BYTES` | `104857600` (100 MiB) | Largest object `get_object` saves |
| `S3_MAX_UPLOAD_BYTES` | `104857600` (100 MiB, at most 1 GiB) | Largest upload (the body is hashed in memory for the signature) |
| `S3_MAX_TEXT_BYTES` | `1048576` (1 MiB) | Most bytes `output: "text"` returns |
| `S3_TIMEOUT_MS` | `30000` | Per-request timeout for listings, HEAD and DELETE |
| `S3_TRANSFER_TIMEOUT_MS` | `300000` | Timeout for downloads, uploads and copies (the plugin's host timeout is 360 s) |
| `S3_TOOL_ALLOW_WRITES` | (off) | `1` lets agent tools call `put_object` and `copy_object` |
| `S3_ALLOWED_BUCKETS` | (any) | Comma-separated buckets agent tools may touch (list, head, get, put, and both sides of a copy); `list_buckets` shows tools only these. Nodes are not limited. |
| `S3_EXPECTED_BUCKET_OWNER` | (off) | 12-digit AWS account id sent as `x-amz-expected-bucket-owner` (and `x-amz-source-expected-bucket-owner` for copies) on every bucket request, so a request to a bucket owned by another account fails with 403 |

**Per-node credentials:** a node's `access_token` replaces the credentials for that node:
`ACCESS_KEY_ID:SECRET_ACCESS_KEY` or `ACCESS_KEY_ID:SECRET_ACCESS_KEY:SESSION_TOKEN`, from a workflow env variable of
type `secret`, with `--trust-plugin s3`. Agent tools never choose credentials.

## Quick Start
```bash
export AWS_ACCESS_KEY_ID=AKIA... AWS_SECRET_ACCESS_KEY=... AWS_REGION=eu-west-1
graphrt run s3/example.yaml --plugins .
```

## Usage
```yaml
- { id: list, type: s3.list_objects, bucket: invoices, prefix: "2026/11/", limit: 100 }
- { id: fetch, type: s3.get_object, bucket: invoices, key: "{{#list.data.objects.0.key#}}" }   # -> data.path in S3_DOWNLOAD_DIR
- { id: upload, type: s3.put_object, bucket: reports, key: "daily/summary.txt", text: "{{#llm.text#}}" }
- { id: share, type: s3.presign_get_url, bucket: reports, key: "daily/summary.txt", expires_in_seconds: 86400 }
```
Pagination: pass the previous output's `next_cursor` as `cursor` until it is empty.

## Safety
- **Exfiltration limits:** without `S3_ALLOWED_BUCKETS`, an agent with read tools can read any bucket the credentials
  can, and with writes opted in it can copy or upload into any bucket the credentials can write, including a bucket
  in another account that grants them access. Set `S3_ALLOWED_BUCKETS` and `S3_EXPECTED_BUCKET_OWNER` for agents,
  and scope the IAM policy to those buckets. Non-streamed responses (listings, errors) are capped at 8 MiB.
- **Agent tools are read-only by default:** `list_buckets`, `list_objects`, `head_object` and `get_object` are tools.
  `put_object` and `copy_object` are refused for tools unless `S3_TOOL_ALLOW_WRITES=1`.
- **Node only:** `delete_object`, and `presign_get_url` because a presigned URL is a bearer credential (anyone who
  has it can download the object until it expires). It is never offered to an LLM.
- **Local files:** downloads only into `S3_DOWNLOAD_DIR` (single-component file names, exclusive create, size cap,
  partial files removed on failure); uploads only from regular files inside `S3_UPLOAD_DIR` (realpath on both sides,
  so symlinks cannot leave it; FIFOs and devices refused).
- **Secrets:** the secret key and session token are never logged and are redacted from every error. Requests that
  get a redirect (bucket in another region) are not followed; the error names the bucket's region.
- **Keys:** keys with `.` or `..` path segments are refused (HTTP clients normalize them away, so the request would
  not reach that key). MinIO also refuses `//` in keys.
- **Retries:** every request is idempotent and is retried twice after 5xx, `SlowDown` or network errors, except a
  conditional `only_if_absent` upload (a retry could not tell its own earlier success from a conflict).

## Costs
S3 bills requests (LIST/PUT/COPY per 1,000, GET per 10,000), storage and data transfer out; R2 has no egress fees.
See the provider's pricing page.

## Testing
- `npm test` at the repo root runs the SigV4 vectors, XML parsing and request/response tests with a fake fetch.
- `test/integration.test.mjs` is an opt-in round trip against a throwaway S3-compatible server, e.g.
  `docker run --rm -p 127.0.0.1:19000:9000 -e MINIO_ROOT_USER=itadmin -e MINIO_ROOT_PASSWORD=... minio/minio server /data`
  then `S3_INTEGRATION_ENDPOINT=http://127.0.0.1:19000 S3_INTEGRATION_ACCESS_KEY_ID=itadmin S3_INTEGRATION_SECRET_ACCESS_KEY=... node --test test/integration.test.mjs`.

## License
Apache-2.0
