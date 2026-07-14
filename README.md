# pi-websearch

Local **WebSearch** and **WebFetch** tools for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), modeled on the Claude Code harness's web tools but running fully on your machine — no server-side search tool required.

- **WebSearch** — DuckDuckGo search via the [`ddgr`](https://github.com/jarun/ddgr) CLI.
- **WebFetch** — URL retrieval via a pluggable backend (headless Playwright by default, `w3m` as a lightweight fallback), HTML→markdown conversion, and a small-model summarization step.

## Install

Install as a pi package (recommended):

```bash
pi install github.com/jeroeness/pi-websearch
```

Or clone into an auto-discovered extensions directory:

```bash
git clone https://github.com/jeroeness/pi-websearch ~/.pi/agent/extensions/pi-websearch
cd ~/.pi/agent/extensions/pi-websearch && npm install --omit=dev   # turndown + lru-cache
```

Or load ad-hoc for a single run:

```bash
pi -e /path/to/pi-websearch/index.ts
```

## Tools

### `WebSearch`
Searches DuckDuckGo through `ddgr`. Supports `allowed_domains` / `blocked_domains`
(mapped to `site:` / `-site:` operators; at most one of the two per query). Returns
the upstream model-facing format so agents cite sources:

```
Web search results for query: "<query>"

Links: [{"title":"…","url":"…"}, …]

<snippet commentary>

REMINDER: You MUST include the sources above in your response …
```

### `WebFetch`
Fetches a URL through the selected backend, converts HTML to markdown, and applies
your `prompt` to the content with a small, fast model. Returns the processed result
string. Cross-host redirects are surfaced (not silently followed) as a
`REDIRECT DETECTED` message so the agent re-fetches explicitly; a self-cleaning
15-minute LRU cache speeds up repeat fetches.

**Permission:** preapproved docs/code domains (see `preapproved.ts`) auto-allow and are
eligible for a raw-markdown passthrough fast path; any other hostname is asked once per
session before the first fetch.

## Configuration (environment)

| Variable | Values | Default |
|---|---|---|
| `PI_WEBFETCH_BACKEND` | `playwright` \| `w3m` | `playwright` |
| `PI_WEBFETCH_MODEL` | `provider/id` | `anthropic/claude-haiku-4-5` |

## Requirements

System binaries (resolved via `which`, with `/opt/homebrew/bin` and `/usr/local/bin`
fallbacks):

| Tool | Needed for | Install |
|---|---|---|
| `ddgr` | WebSearch | `brew install ddgr` / `pipx install ddgr` |
| `playwright` + Chromium | WebFetch (default backend) | `npm i -g playwright && playwright install chromium` |
| `w3m` | WebFetch (`PI_WEBFETCH_BACKEND=w3m`) | `brew install w3m` / `apt install w3m` |

A globally-installed Playwright is auto-resolved from the `playwright` CLI location, so
it does not need to live in this package's `node_modules`. If `turndown` is unavailable,
WebFetch falls back to a tag-stripping converter.

Node runtime dependencies (`turndown`, `lru-cache`) are declared in `package.json`. The
`@earendil-works/*` packages are `devDependencies` for type-checking only — the pi host
injects them at runtime.

## Layout

```
index.ts            Extension entry: registers both tools + WebFetch permission gate
bin.ts              which/fallback binary resolution
ddgr.ts             ddgr backend + domain-filter mapping
websearch-tool.ts   WebSearch tool + output formatting
preapproved.ts      Preapproved host allowlist
webfetch-prompt.ts  WebFetch description + secondary-model prompt (copyright guardrails)
backends.ts         Playwright + w3m fetch backends
webfetch-utils.ts   Validation, cache, http→https, redirect detection, HTML→markdown
webfetch-model.ts   Small-model summarization step
webfetch-tool.ts    WebFetch tool wiring
```

## Development

```bash
npm install       # dev + runtime deps
npm run typecheck # tsc --noEmit
```

## License

MIT © Jeroen Esseveld
