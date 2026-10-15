# Contributing to shill

shill does one thing: turn a range of commits into notes, a version and posts. A good
patch makes that output better for most people who ship in public. If you are not
sure an idea fits, open an issue first and paste the output you wish you got.

## Get it running

```sh
git clone https://github.com/OWNER/shill.git
cd shill
npm test          # no install step, there are no dependencies
```

You need Node 18 or newer and git.

Try it by hand against the mock GitHub server:

```sh
node fixtures/demo-server.mjs 4999 &
SHILL_GITHUB_API=http://127.0.0.1:4999 node bin/shill.js acme/rocket --since v1.0.0 --channels all
SHILL_GITHUB_API=http://127.0.0.1:4999 node bin/shill.js ui
```

## Where things live

| Path | What it does |
| --- | --- |
| `src/index.js` | `shill()`, `nextVersion()`, `changelogEntry()`, the pipeline |
| `src/github.js`, `src/git.js` | Commit sources: GitHub REST API and `git log` |
| `src/parse.js`, `src/highlights.js`, `src/semver.js` | Parsing, ranking, the version bump |
| `src/render.js`, `src/channels.js`, `src/changelog.js` | Notes, channel drafts, CHANGELOG.md |
| `src/llm.js` | The optional OpenAI or Anthropic pass |
| `src/publish.js`, `src/watch.js`, `src/action.js` | Posting, watch mode, the Action |
| `src/mcp.js`, `src/ui.js`, `src/ui.html`, `src/fonts/` | MCP server and dashboard |
| `fixtures/` | Mock servers, temp git repos, the demo server |

## House rules

1. No runtime dependencies. Node built-ins and global `fetch` only.
2. Every change comes with a test that runs offline against `fixtures/mocks.js`.
   Tests never hit GitHub, an LLM, Discord or Telegram.
3. Conventional Commits, please. shill writes its own release notes from them.
4. No em or en dashes anywhere, generated text included. A test checks drafts for them.
5. Changed a flag or an output? Update the README example from a real run.

## Bugs

Open an issue with the command, the `--json` output and `node --version`. Strip tokens
and private repo names first.
