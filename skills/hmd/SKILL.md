---
name: hmd
description: Use hmd for HackMD note workflows or live OpenAPI operations while controlling API quota.
---

# hmd

Use the installed `hmd` binary. Read the nearest command's `--help` when choosing flags.

## Routing

- Prefer `hmd note` for common note workflows. It owns URL normalization, cache use, public reads, and personal/team routing.
- Use `hmd api --help` for operations outside that surface. Pass its live operation ID to `hmd api call`; use `hmd api describe <operation-id>` when parameters are unclear.

## Quota

- Reuse default cached reads. Use `--fresh` only when the task requires current server state.
- Prefer `note cat`, `note view`, or `note diff` for content. They try unauthenticated public Markdown before the quota-limited API.
- Use `--api never` when a read must spend no API quota, and `--offline` when it must make no network request.
- `note resolve` is local. `note list` reads only personal notes unless given one explicit `--team`.
- Prefer `note update` for content replacement. It skips an unchanged public note and does not preflight private notes through the API.

## Environment and output

Set `HMD_TOKEN` for authenticated operations and `HMD_API_URL` for non-production servers. Set `HMD_WEB_URL` only when it cannot be derived from the API URL.

`note cat` emits Markdown; `note view` emits JSON. `note diff` exits 1 when content differs, which is a comparison result rather than a command failure.

On failure, rerun with `--verbose` to see each cache, public-web, and API attempt. Use the global `--json-errors` flag for stable error codes and structured attempt data. Use `hmd doctor --json` for endpoint, auth, and cache health, and `hmd cache status --json` for cache metrics.
