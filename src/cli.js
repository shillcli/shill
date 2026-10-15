import { writeFile } from 'node:fs/promises';
import { shill, nextVersion, changelogEntry, ShillError } from './index.js';
import { CHANNELS, parseChannels } from './channels.js';
import { publish, writeDrafts, checkPublish } from './publish.js';
import { tweetLength } from './render.js';

export const HELP = `shill: your repo's shill. commits in, posts out.

reads your commits, drops the noise, writes the release notes, picks the next
version and drafts the posts for x, discord, telegram and linkedin.

Usage
  shill <owner/repo> [options]        notes + post drafts from a GitHub repo
  shill --local [options]             same, from the git checkout you're in
  shill next [<owner/repo>|--local]   next semver version and the commits that decided it
  shill changelog [...] [--write]     Keep a Changelog section for the next version
  shill watch <owner/repo>            poll releases and tags, post each new one once
  shill mcp                           MCP server over stdio, for Claude, Cursor etc.
  shill ui [--port 4178]              local dashboard, drafts only

Range
  --since <ref>        tag (v1.2.0), date (2026-01-31), duration (12h, 7d, 2w) or
                       "latest" (newest semver tag). default: all history
                       (next and changelog default to latest)
  --until <ref>        branch, tag or SHA to stop at. default: default branch / HEAD
  --local              read commits with git from a local checkout, no GitHub API
  --dir <path>         checkout for --local. default: current directory
  --max-commits <n>    stop after this many commits. default: 200

Output
  --channels <list>    x, thread, discord, telegram, linkedin or all. default: x
  --tag <version>      version to announce (and changelog heading). default: the
                       suggested next version when --since is a tag
  --format <fmt>       markdown | tweet | both | json. default: both
  --json               same as --format json
  --out <file>         write output to a file instead of stdout
  --drafts-dir <dir>   write notes.md and one file per channel draft to <dir>
  --write              (changelog) insert the section into CHANGELOG.md
  --file <path>        (changelog) changelog path. default: CHANGELOG.md

AI (optional, templates without a key)
  --provider <name>    openai | anthropic | none. default: openai if OPENAI_API_KEY
                       is set, else anthropic if ANTHROPIC_API_KEY is set, else none
  --model <name>       default: gpt-4o-mini or claude-3-5-haiku-latest
  --tone <tone>        plain | hype | technical. default: plain
  --voice <file>       a few of your past posts, so the drafts sound like you

Posting (off unless you pass these; x is always drafts only)
  --post <list>        discord, telegram
  --discord-webhook <url>
  --telegram-token <token>  --telegram-chat <chat id>

Watch, dashboard
  --interval <sec>     poll interval for watch. default: 300
  --state <file>       watch state file. default: .shill-state.json
  --once               poll once and exit
  --port <n>           dashboard port. default: 4178.  --host <addr> default: 127.0.0.1

  -h, --help           show this help.     -v, --version   show the version

Environment
  GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY
  SHILL_GITHUB_API, SHILL_LLM_BASE, SHILL_TELEGRAM_API   API base URLs
`;

const VALUE_FLAGS = {
  '--since': 'since', '--until': 'until', '--format': 'format', '--tone': 'tone', '--provider': 'provider', '--model': 'model',
  '--max-commits': 'maxCommits', '--out': 'out', '--channels': 'channels', '--voice': 'voiceFile', '--post': 'post',
  '--discord-webhook': 'discordWebhook', '--telegram-token': 'telegramToken', '--telegram-chat': 'telegramChat',
  '--drafts-dir': 'draftsDir', '--dir': 'dir', '--interval': 'interval', '--state': 'stateFile', '--file': 'file',
  '--port': 'port', '--host': 'host', '--tag': 'tag',
};
const BOOL_FLAGS = { '--local': 'local', '--write': 'write', '--once': 'once' };
const FORMATS = ['markdown', 'tweet', 'both', 'json'];
export const COMMANDS = ['next', 'changelog', 'watch', 'mcp', 'ui'];

export function parseArgs(argv) {
  const opts = { format: 'both' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline;
    if (arg.startsWith('--') && arg.includes('=')) [arg, inline] = [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-v' || arg === '--version') opts.version = true;
    else if (arg === '--json') opts.format = 'json';
    else if (BOOL_FLAGS[arg]) opts[BOOL_FLAGS[arg]] = true;
    else if (VALUE_FLAGS[arg]) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new ShillError(`Missing value for ${arg}`, { exitCode: 2 });
      opts[VALUE_FLAGS[arg]] = value;
    } else if (arg.startsWith('-')) throw new ShillError(`Unknown option ${arg} (see --help)`, { exitCode: 2 });
    else positional.push(arg);
  }
  if (COMMANDS.includes(positional[0])) opts.command = positional.shift();
  if (positional.length > 1) throw new ShillError(`Expected one repository, got: ${positional.join(' ')}`, { exitCode: 2 });
  opts.repo = positional[0];
  if (!FORMATS.includes(opts.format)) throw new ShillError(`Unknown format "${opts.format}" (use ${FORMATS.join(', ')})`, { exitCode: 2 });
  if (opts.post) opts.post = opts.post.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return opts;
}

function creds(opts, env) {
  return { discordWebhook: opts.discordWebhook, telegramToken: opts.telegramToken, telegramChat: opts.telegramChat, telegramApi: env.SHILL_TELEGRAM_API };
}

function channelBlock(name, value) {
  const spec = CHANNELS[name];
  if (Array.isArray(value)) {
    return `${spec.label} (${value.length} posts):\n\n${value.map((p) => `${p}\n[${tweetLength(p)}/${spec.limit}]`).join('\n\n')}`;
  }
  return `${spec.label} (${tweetLength(value)}/${spec.limit}):\n\n${value}`;
}

export function formatOutput(result, format, extra = {}) {
  if (format === 'json') {
    return JSON.stringify({
      repo: result.repo, range: result.range, tag: result.tag, provider: result.provider, markdown: result.markdown, tweet: result.tweet,
      posts: result.posts, counts: result.counts, version: result.version,
      highlights: result.highlights.map((h) => ({ subject: h.subject, type: h.breaking ? 'breaking' : h.type, score: h.score, sha: h.shortSha, pr: h.pr })),
      contributors: result.contributors, stats: result.stats, warnings: result.warnings, ...extra,
    }, null, 2) + '\n';
  }
  if (format === 'markdown') return result.markdown.trimEnd() + '\n';
  if (format === 'tweet') return result.tweet + '\n';
  const rule = '-'.repeat(40);
  const posts = Object.keys(result.posts).length ? result.posts : { x: result.tweet };
  let out = result.markdown.trimEnd() + '\n';
  for (const [name, value] of Object.entries(posts)) out += `\n${rule}\n${channelBlock(name, value)}\n`;
  if (result.version?.bump) out += `\n${rule}\nSuggested version: ${result.version.next} (${result.version.bump})\n`;
  return out;
}

async function emit(text, opts, stdout, stderr, note) {
  if (opts.out) {
    await writeFile(opts.out, text);
    stderr.write(`shill: wrote ${opts.out}${note ? ` (${note})` : ''}\n`);
  } else stdout.write(text);
}

async function runNext(opts, io) {
  const r = await nextVersion(opts);
  if (opts.format === 'json') return emit(JSON.stringify(r, null, 2) + '\n', opts, io.stdout, io.stderr);
  const lines = [r.bump ? `${r.next}` : `${r.next} (no release needed)`, '', `Current: ${r.current || 'none (no semver tag)'}`, `Bump:    ${r.bump || 'none'}`, `Range:   ${r.range} (${r.stats.kept} of ${r.stats.seen} commits kept)`, '', 'Why:', ...r.reasons.map((x) => `- ${x}`)];
  if (r.highlights.length) lines.push('', 'Top changes:', ...r.highlights.map((h) => `- ${h}`));
  return emit(lines.join('\n') + '\n', opts, io.stdout, io.stderr);
}

async function runChangelog(opts, io) {
  const r = await changelogEntry({ ...opts, version: opts.tag, write: opts.write, file: opts.file });
  if (opts.format === 'json') return emit(JSON.stringify({ ...r, written: r.written && { path: r.written.path, changed: r.written.changed } }, null, 2) + '\n', opts, io.stdout, io.stderr);
  if (r.written) {
    io.stderr.write(r.written.changed ? `shill: updated ${r.written.path} with ${r.version}\n` : `shill: ${r.written.path} already has ${r.version}, no change\n`);
    return;
  }
  return emit(r.section.trimEnd() + '\n' + (r.link ? `\n${r.link}\n` : ''), opts, io.stdout, io.stderr);
}

async function runGenerate(opts, io, env) {
  if (!opts.repo && !opts.local) { io.stderr.write('error: missing <owner/repo> (or use --local)\n\n' + HELP); return 2; }
  const post = opts.post || [];
  const c = creds(opts, env);
  checkPublish(post, c);
  const channels = [...new Set([...parseChannels(opts.channels), ...post])];
  const result = await shill({ ...opts, channels });
  for (const w of result.warnings) io.stderr.write(`warning: ${w}\n`);
  const extra = {};
  if (opts.draftsDir) {
    const files = await writeDrafts(opts.draftsDir, result);
    io.stderr.write(`shill: wrote ${files.length} drafts to ${opts.draftsDir}\n`);
    extra.drafts = files;
  }
  if (post.length) {
    extra.published = await publish(result, post, c);
    for (const p of extra.published) io.stderr.write(`shill: posted to ${p.channel}${p.id ? ` (message ${p.id})` : ''}\n`);
  }
  await emit(formatOutput(result, opts.format, extra), opts, io.stdout, io.stderr, `${result.stats.kept} of ${result.stats.seen} commits kept, provider: ${result.provider}`);
  return 0;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, version = '0.0.0', env = process.env } = {}) {
  const io = { stdout, stderr };
  try {
    const opts = parseArgs(argv);
    if (opts.help) { stdout.write(HELP); return 0; }
    if (opts.version) { stdout.write(version + '\n'); return 0; }
    opts.env = env;
    if (opts.command === 'mcp') {
      const { serveMcp } = await import('./mcp.js');
      await serveMcp({ version });
      return 0;
    }
    if (opts.command === 'ui') {
      const { startUi } = await import('./ui.js');
      const ui = await startUi({ port: opts.port ? Number(opts.port) : 4178, host: opts.host, version, base: { env } });
      stdout.write(`shill dashboard: ${ui.url}\n(Ctrl+C to stop)\n`);
      await new Promise(() => {});
    }
    if (opts.command === 'watch') {
      const { watch } = await import('./watch.js');
      const events = await watch({ ...opts, channels: [...new Set([...parseChannels(opts.channels), ...(opts.post || [])])], creds: creds(opts, env) });
      if (opts.once && opts.format === 'json') stdout.write(JSON.stringify(events.map(({ result, ...e }) => ({ ...e, posts: result?.posts })), null, 2) + '\n');
      return 0;
    }
    if (opts.command === 'next') { await runNext(opts, io); return 0; }
    if (opts.command === 'changelog') { await runChangelog(opts, io); return 0; }
    return await runGenerate(opts, io, env);
  } catch (err) {
    if (err instanceof ShillError) {
      stderr.write(`error: ${err.message}\n`);
      return err.exitCode;
    }
    stderr.write(`unexpected error: ${err?.stack || err}\n`);
    return 1;
  }
}
