# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-14

### Added

- shillcli.com runs the tool in the browser: paste a public GitHub repo and get the next
  version, release notes, a CHANGELOG entry and X, X thread, Discord, Telegram and
  LinkedIn drafts as previews with counts and copy buttons. Range: since the latest
  release or semver tag, or the last N commits (labelled as an estimate). Results are
  shareable by URL (`?repo=owner/repo&range=commits&n=50`) and run on load.
- `src/web.js`: the browser engine. One compare call covers a release range, so a repo
  costs about 3 to 8 GitHub API calls. Human errors for bad input, missing repos,
  network problems and rate limits.
- `api/github.js`: read-only GitHub proxy (allowlisted endpoints, 60 s cache, 8 s
  timeout) the page falls back to when a visitor runs out of API calls. Optional
  `GITHUB_TOKEN` raises its limit.
- `scripts/dev-site.mjs` (local Vercel stand-in) and `scripts/sync-docs-lib.mjs`.
  Tests for the engine, the proxy, the docs/lib copies and the page end to end in
  Chromium against a mock GitHub API.

### Changed

- The pure half of `src/changelog.js` moved to `src/changelog-core.js` so the browser
  can use it. `src/changelog.js` re-exports it; the public API is unchanged.

## [1.0.0] - 2026-10-14

Released as Shill: npm package `shill`, command `shill`, env vars prefixed
`SHILL_`, MCP server name `shill`.

### Added

- `shill next`: suggests the next semantic version from commit types since the
  latest tag (breaking: major, feat: minor, anything else: patch) and prints why.
- `shill changelog [--write]`: Keep a Changelog section for the next version,
  inserted below `[Unreleased]` in CHANGELOG.md with a compare link. Re-running
  replaces the same section and keeps its original date, so it is idempotent.
- Multi-channel drafts with `--channels x,thread,discord,telegram,linkedin` (or
  `all`): single X post, numbered X thread of 3 to 6 posts (each at most 280
  characters), Discord Markdown (at most 2000), Telegram HTML with all commit text
  escaped (at most 4096) and a plain-text LinkedIn post. Character counts in the
  output, JSON and dashboard.
- Opt-in publishing: `--post discord --discord-webhook <url>` and
  `--post telegram --telegram-token <t> --telegram-chat <id>`. X is never posted;
  `--drafts-dir` writes every draft to files. Tokens are removed from error messages.
- `shill watch owner/repo --interval 300`: watch mode that polls releases and
  tags, generates notes for each new one and posts to the configured channels.
  State is kept in a JSON file (atomic writes); the first poll is a baseline,
  each channel is posted once, failed channels retry up to three times.
- Highlights ranking (breaking, feat, perf, PR linked, files changed) that picks
  the top three commits for every post, and a contributors leaderboard with
  first-time contributors called out.
- `--local`: reads commits, tags and file counts from the local checkout with
  `git log`, no GitHub API needed. GitHub noreply emails map to @logins.
- `--voice voice.md`: examples of your past posts steer the LLM's voice.
- `--since latest` and `--tag <version>`.
- GitHub Action (`action.yml`, node20): writes notes into the release body between
  markers, drafts to a directory, job summary, outputs (`notes`, `next_version`,
  `drafts_dir`, `tweet`), optional Discord and Telegram posting via secrets.
- MCP server (`shill mcp`) with tools `release_notes`, `next_version`,
  `draft_posts` and `changelog_entry`.
- Dashboard (`shill ui`): pick a repo (GitHub or local) and range, see the next
  version, highlights, contributors, the notes and every channel draft previewed
  as an X, Discord, Telegram or LinkedIn post, with character rings and copy buttons.
  Fonts ship in `src/fonts/` and are served locally, nothing loads from a CDN.
- Brand kit (flat megaphone app icon, flat mark, banner, coin image, terminal demo,
  dashboard screenshot) on a light blush palette with a #FF2E8B accent, Plus Jakarta
  Sans and Space Mono, and a landing page in `docs/`.

### Changed

- The AI pass now receives the version, highlights and contributors, returns
  drafts for every requested channel, and each draft is validated against its
  channel's rules. A draft that fails falls back to the template with a warning.
- Release notes list first-time contributors.
- Test helpers moved to `fixtures/` so `node --test` does not pick them up.
- Output in `both` format lists every requested channel with its character count.

## [0.1.0] - 2026-10-14

### Added

- `shill <owner/repo>` CLI with `--since`, `--until`, `--format`, `--json`,
  `--tone`, `--provider`, `--model`, `--max-commits` and `--out`.
- GitHub commit fetching with pagination, tag resolution (lightweight and
  annotated tags, with a releases fallback), date and duration ranges.
- Deterministic Conventional Commits pass: grouping, breaking change detection,
  noise filtering (merges, dependency bumps, version commits, typo fixes, WIP)
  and deduplication.
- Optional AI pass with OpenAI or Anthropic, with tweet validation, one retry
  and clean truncation.
- Programmatic API: `import { shill } from 'shill'`.
- Example GitHub Actions workflow that fills the release body on publish.

[1.1.0]: https://github.com/OWNER/shill/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/OWNER/shill/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/OWNER/shill/releases/tag/v0.1.0
