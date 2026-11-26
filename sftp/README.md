# sftp

**Status:** beta · **ToS risk:** none. Loopback ssh2 tests for host-key pinning; checked live only against an unreachable host, never a real SSH server. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for **one SFTP server**: list, stat and read remote
files, download them to a local directory and upload local files, using the [`ssh2`](https://www.npmjs.com/package/ssh2)
package. The server's host key is pinned, credentials come only from the environment, remote paths stay inside
`SFTP_ROOT` and local paths inside allowlisted directories.

## Features
- **`list_directory`:** name, type, size, modified time and permission bits, sorted; `limit` with `truncated`.
- **`stat`:** one remote path.
- **`read_file`:** UTF-8 or base64, `offset` and `max_bytes` (never more than `SFTP_MAX_READ_BYTES`), `truncated`
  and `next_offset`.
- **`download`:** a remote file to a new file with a generated name (`<name>-<timestamp>-<random>.<ext>`) in
  `SFTP_OUTPUT_DIR`; size-capped, nothing local is overwritten.
- **`upload`:** a local file from `SFTP_INPUT_DIRS` to a remote path; `create_parents` makes missing remote
  directories. `overwrite: true` (workflow nodes only) replaces an existing regular file.
- **`make_directory`**, and **`delete_path`** (workflow nodes only: one file, symlink or empty directory).

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer.
- `npm install` in this directory (installs `ssh2` 1.17.0; its optional native helpers are not required).

## Installation
```bash
cd sftp && npm install && cd ..
graphrt plugin install ./sftp
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `SFTP_HOST`, `SFTP_PORT` | (required), `22` | The server |
| `SFTP_USERNAME` | (required) | Login name |
| `SFTP_PASSWORD` | | Password authentication |
| `SFTP_PRIVATE_KEY` / `SFTP_PRIVATE_KEY_PATH` | | Private key as text, or the path of a key file; `SFTP_PRIVATE_KEY_PASSPHRASE` if it is encrypted |
| `SFTP_HOST_FINGERPRINT` | (required) | The server's host key, `SHA256:...` as `ssh-keygen -l` prints it; comma-separated for a key rotation |
| `SFTP_ROOT` | (required) | Absolute directory on the server that every remote path stays inside |
| `SFTP_INPUT_DIRS` | | Comma-separated local directories that uploads may read from |
| `SFTP_OUTPUT_DIR` | | Existing local directory that downloads are written to |
| `SFTP_MAX_INPUT_BYTES`, `SFTP_MAX_OUTPUT_BYTES` | 1 GiB | Largest upload / download |
| `SFTP_MAX_READ_BYTES` | 1 MiB | Most bytes one `read_file` returns |
| `SFTP_TOOL_ALLOW_WRITES` | (off) | `1` lets **agents** call `upload` (new files only) and `make_directory` |
| `SFTP_CONNECT_TIMEOUT_MS` | `15000` | Handshake time limit |
| `SFTP_OPERATION_TIMEOUT_MS` | `600000` | Whole-call time limit (connect + work); the connection is closed when it passes |

Get the fingerprint and **check it out of band** (from the server's admin, or the server's console with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`):
```bash
ssh-keyscan -p 22 sftp.example.com 2>/dev/null | ssh-keygen -lf -
```

## Quick Start
```bash
export SFTP_HOST=sftp.example.com SFTP_USERNAME=deploy SFTP_PRIVATE_KEY_PATH=~/.ssh/deploy_ed25519
export SFTP_HOST_FINGERPRINT=SHA256:... SFTP_ROOT=/home/deploy/exchange SFTP_OUTPUT_DIR=~/sftp-downloads
graphrt run sftp/example.yaml --plugins .
```

## Usage
Remote paths are virtual: `/` is `SFTP_ROOT`, and results show paths that way, so the server's layout is not
exposed. A download result:
```json
{ "remote_path": "/report.csv", "path": "/Users/me/sftp-downloads/report-20261119-080102-1a2b3c4d.csv", "file_name": "report-20261119-080102-1a2b3c4d.csv", "size_bytes": 1832 }
```

## Safety
- **Host key pinning:** the key the server presents must match `SFTP_HOST_FINGERPRINT`. There is no
  trust-on-first-use; an unknown key fails with `auth_error`, naming the key that was seen.
- **Credentials** come only from the environment: nodes take no `access_token` and tools never take credentials.
  No SSH agent, no `~/.ssh` keys and no keyboard-interactive login are used. The password, private key and
  passphrase are redacted from every error.
- **Remote paths** are normalised against `/` (so `..` cannot climb above `SFTP_ROOT`), then the server's
  `realpath` must still be inside `SFTP_ROOT`, so symlinks out are refused; outside paths get the same `not_found`
  as missing ones. SFTP has no `O_NOFOLLOW`, so a user with write access on the server could still race a symlink
  in between: treat `SFTP_ROOT` as a guard rail, and use a chrooted SFTP account when that matters.
- **Local paths** use the local media plugins' file-access module (copied as `lib/file-access.mjs`; keep the copies
  in step): realpath on both sides with a separator-suffixed prefix, no FIFOs, devices or hard-linked files, and
  downloads only as new generated names through a private staging directory.
- **Uploads are staged:** written to `.<name>.<random>.partial` with an exclusive create, then renamed. The
  plugin checks that the target does not exist before the upload and again right before the rename. On OpenSSH
  servers a plain SFTP rename never replaces a file, so nothing can be overwritten. Some other servers implement
  rename as replace: there, a file created in the moment between the second check and the rename would be
  replaced. An overwrite (nodes only) uses the `posix-rename@openssh.com` extension. A failed upload removes the
  staging file.
- **Agents vs nodes:** tool calls are read-only by default (downloads to `SFTP_OUTPUT_DIR` are allowed: setting
  it is the opt-in). `SFTP_TOOL_ALLOW_WRITES=1` allows uploads of new files and `make_directory`; overwrites and
  `delete_path` are workflow nodes only.
- **Limits:** handshake and whole-call timeouts, cancel closes the connection, size caps on reads and transfers,
  four calls at a time, a new connection per call.

## Errors
| Kind | When |
|------|------|
| `setup_required` | A required variable is missing or malformed (including an `SFTP_HOST_FINGERPRINT` that lists no valid `SHA256:` fingerprint), the key file cannot be read, or `ssh2` is not installed |
| `auth_error` | The host key is not pinned, or the login was rejected |
| `network_error` | DNS, refused or timed-out connection (retryable) |
| `not_found` | The path is missing or outside `SFTP_ROOT` / the local allowlist |
| `permission_denied` | An agent tried to write without the opt-in or to overwrite, or the server refused |
| `invalid_input` | Bad arguments, not a regular file, a target that exists, over a size cap |
| `timeout` / `cancelled` | `SFTP_OPERATION_TIMEOUT_MS` passed or the call was cancelled |
| `plugin_error` | Other server failures (e.g. deleting a non-empty directory) |

## License
Apache-2.0
