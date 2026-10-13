# hmd

`hmd` is a dynamic, agent-friendly HackMD CLI. It reads the current OpenAPI document at runtime, offers a raw `gh api`-style request interface, persists GET responses across processes, and reads public note Markdown without spending API quota.

## Installation

```bash
npm install --global @stanley2058/hmd
```

## Requirements

- Node.js 22 or newer at runtime
- Bun for development

The project uses Bun 1.4, Bun Build, Bun Test, TypeScript 7, and Oxc. The built CLI targets Node.js and does not require Bun at runtime.

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
bun run lint
bun run format:check

node dist/hmd.js --help
```

## Configuration

```bash
export HMD_TOKEN=your-api-token

# Existing HackMD CLI token name is also supported.
export HMD_API_ACCESS_TOKEN=your-api-token

# Test against a local or Enterprise API server.
export HMD_API_URL=http://localhost:3000/v1

# Optional when the web origin cannot be derived from HMD_API_URL.
export HMD_WEB_URL=http://localhost:3000

# Optional shared cache override.
export HMD_CACHE_DIR=/path/to/shared/hmd-cache
```

`HMD_API_URL` defaults to `https://api.hackmd.io/v1`. Its Swagger document is read from `$HMD_API_URL/docs/swagger.json`.

The shared cache defaults to `${XDG_CACHE_HOME:-~/.cache}/hmd`. Each entry stores its fetch time. Swagger, public Markdown, and authenticated API responses use separate namespaces.

## Dynamic API commands

```bash
# Shows a compact live operation list and links to active and upstream Swagger.
hmd api --help

hmd api operations
hmd api operations --json
hmd api describe GetNote

hmd api call GetNote -F noteId=abc
hmd api call GetHistory -F limit=20 --cache 1h

hmd api request GET /notes/abc
printf '{"content":"# Updated"}' |
  hmd api request PATCH /notes/abc \
    --input - \
    -H 'Content-Type: application/json'
```

`-F` coerces booleans, numbers, and `null`; `-f` always sends a string. Prefix a typed field value with `@` to read it from a file.

The default operation table puts the OpenAPI operation ID first because that is the value accepted by `hmd api call`. Use `hmd api operations --json` for descriptions and tags.

Successful GET responses are cached for five minutes by default:

```bash
hmd api call GetNote -F noteId=abc --cache 1h
hmd api call GetNote -F noteId=abc --fresh
hmd api call GetNote -F noteId=abc --offline
```

## Note commands

`hmd note` provides a stable interface for common workflows while `hmd api` follows the live Swagger document:

```bash
hmd note list
hmd note list --team team-path

hmd note view URL
hmd note resolve URL

printf '# New note\n' | hmd note create --title 'New note'
hmd note create --team team-path --file README.md

hmd note update URL --file README.md
hmd note diff URL README.md
hmd note delete URL
```

`note list` only reads the personal workspace or the team explicitly selected with `--team`; it never scans every team. `note resolve` normalizes an ID or URL without making a network request. `note diff` exits with status 0 when the content matches and 1 when it differs.

`note view`, `note cat`, `note diff`, `note update` (`edit`), and `note delete` (`rm`) pass complete named URLs to the API for server-side resolution. Each uncached API operation makes one request, with no team or note-list lookups. Keep the complete URL, including its namespace; a custom permalink alone is insufficient. The default `/notes` route handles personal and accessible team notes and uses personal API quota. Pass `--team <path>` to use the team endpoint and team quota instead. Public reads still run first unless `--api always` is set; `--api never` makes no API request. `note resolve` remains local.

```bash
hmd note view https://hackmd.io/@hackmd-design/bottom-discussion --team hackmd-design
```

`note update` checks the free public Markdown representation before sending content. If content is the only update and it is unchanged, it skips the API write. A failed public read proceeds directly to the API write. The API resolves named URLs within the write request. Use `--force` to skip the public comparison.

### Zero-quota public reads

```bash
hmd note cat https://hackmd.io/@uid/noteid
hmd note cat URL --meta
hmd note cat URL --api never
hmd note cat URL --verbose
```

`hmd note cat`, `hmd note view`, and `hmd note diff` try the shared cache, then HackMD's public Markdown representation, then the authenticated v1 API. The public request never receives the API token. `--api never` guarantees that the command will not spend API quota; `--api always` skips the public transport.

## Cache

```bash
hmd cache status
hmd cache status --json
hmd cache clear
```

## Diagnostics

Use `--verbose` to print every cache, public-web, and API attempt, including failed attempts and fallbacks. Use the global `--json-errors` flag when an agent needs stable error codes and structured attempt details:

```bash
hmd note cat URL --fresh --verbose
hmd --json-errors note cat URL --fresh
hmd cache status --json
hmd doctor --json
```

`hmd doctor` reports the binary version, configured API and web URLs, token presence, live Swagger reachability, authenticated identity when a token is set, and cache writability. It never prints the token. The authenticated check makes one uncached `GET /me` request when a token is configured. HackMD exempts that endpoint from API usage accounting.

## Shell completion

Every built-in command supports `--help`. Generate a completion script with:

```bash
# bash
source <(hmd completion bash)

# zsh
source <(hmd completion zsh)

# fish
hmd completion fish | source
```

Completion candidates include operation IDs from the cached or current Swagger document.

## Agent skill

The npm package includes a compact agent skill at `skills/hmd/SKILL.md`.

## Publishing

Publish locally after authenticating with npm:

```bash
npm publish --access public
```

The publish hooks run the checks and rebuild the CLI. To publish through GitHub Actions instead, push a tag matching `package.json`:

```bash
git tag v0.1.2
git push origin main refs/tags/v0.1.2
```

Pushing a tag such as `v0.1.2` runs the npm publishing workflow. The tag must match the version in `package.json`. The first publish requires a write-capable npm token in the `NPM_TOKEN` repository secret; later releases can use npm trusted publishing configured for `.github/workflows/publish.yml`.

## License

MIT
