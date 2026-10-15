/** Model Context Protocol server over stdio (JSON-RPC 2.0, newline-delimited). */
import { createInterface } from 'node:readline';
import { shill, nextVersion, changelogEntry } from './index.js';
import { CHANNELS } from './channels.js';

export const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST = '2025-06-18';

const source = {
  repo: { type: 'string', description: 'GitHub repository as owner/repo. Omit when local_path is set.' },
  local_path: { type: 'string', description: 'Path to a local git checkout. Reads commits with git instead of the GitHub API.' },
  since: { type: 'string', description: 'Start of the range: a tag (v1.2.0), a date (2026-01-31), a duration (7d) or "latest" for the newest semver tag.' },
  until: { type: 'string', description: 'Branch, tag or SHA to stop at. Default: default branch or HEAD.' },
};

export const TOOLS = [
  {
    name: 'release_notes',
    description: 'Generate Markdown release notes for a commit range, with highlights, contributors (first-timers flagged) and stats. Uses an LLM only if an API key is configured on the server.',
    inputSchema: { type: 'object', properties: { ...source, tone: { type: 'string', enum: ['plain', 'hype', 'technical'] }, provider: { type: 'string', enum: ['openai', 'anthropic', 'none'] } }, additionalProperties: false },
  },
  {
    name: 'next_version',
    description: 'Suggest the next semantic version from commit types since the latest tag: breaking -> major, feat -> minor, anything else -> patch. Returns the version and the reasons.',
    inputSchema: { type: 'object', properties: source, additionalProperties: false },
  },
  {
    name: 'draft_posts',
    description: 'Draft launch posts for a release: X post, X thread (3 to 6 numbered posts), Discord (Markdown), Telegram (HTML) and LinkedIn. Returns each draft with its character count and limit. Never posts anything.',
    inputSchema: {
      type: 'object',
      properties: {
        ...source,
        channels: { type: 'array', items: { type: 'string', enum: Object.keys(CHANNELS) }, description: 'Channels to draft. Default: all.' },
        tag: { type: 'string', description: 'Version to announce, e.g. v1.4.0. Default: the suggested next version.' },
        tone: { type: 'string', enum: ['plain', 'hype', 'technical'] },
        voice: { type: 'string', description: 'Examples of the author\'s past posts, used to steer the LLM voice.' },
        provider: { type: 'string', enum: ['openai', 'anthropic', 'none'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'changelog_entry',
    description: 'Build a Keep a Changelog section for the next version. With write=true and local_path set, inserts it at the top of CHANGELOG.md (re-running replaces the same section, never duplicates).',
    inputSchema: {
      type: 'object',
      properties: { ...source, version: { type: 'string', description: 'Version heading. Default: the suggested next version.' }, date: { type: 'string', description: 'YYYY-MM-DD. Default: today.' }, write: { type: 'boolean' }, file: { type: 'string', description: 'Changelog path. Default: CHANGELOG.md in local_path.' } },
      additionalProperties: false,
    },
  },
];

class ParamsError extends Error {}

function toOptions(args, base) {
  if (args.repo !== undefined && typeof args.repo !== 'string') throw new ParamsError('repo must be a string');
  if (!args.repo && !args.local_path) throw new ParamsError('Provide repo (owner/repo) or local_path');
  const opts = { ...base, repo: args.repo, since: args.since, until: args.until };
  if (args.local_path) { opts.local = true; opts.dir = args.local_path; }
  return opts;
}

const slim = (r) => ({ repo: r.repo, range: r.range, provider: r.provider, version: r.version, highlights: r.highlights.map((h) => ({ subject: h.subject, type: h.breaking ? 'breaking' : h.type, score: h.score, sha: h.shortSha, pr: h.pr })), contributors: r.contributors, stats: r.stats, warnings: r.warnings });

async function callTool(name, args, base) {
  const opts = toOptions(args, base);
  if (name === 'release_notes') {
    const r = await shill({ ...opts, tone: args.tone, provider: args.provider, channels: ['x'] });
    return `${r.markdown.trimEnd()}\n\n${JSON.stringify(slim(r), null, 2)}`;
  }
  if (name === 'next_version') return JSON.stringify(await nextVersion(opts), null, 2);
  if (name === 'draft_posts') {
    const r = await shill({ ...opts, channels: args.channels?.length ? args.channels : 'all', tag: args.tag, tone: args.tone, voice: args.voice, provider: args.provider, since: opts.since ?? 'latest' });
    return JSON.stringify({ repo: r.repo, tag: r.tag, provider: r.provider, posts: r.posts, counts: r.counts, warnings: r.warnings }, null, 2);
  }
  if (name === 'changelog_entry') {
    const file = args.file || (args.local_path ? `${args.local_path.replace(/\/+$/, '')}/CHANGELOG.md` : 'CHANGELOG.md');
    const r = await changelogEntry({ ...opts, version: args.version, date: args.date, write: Boolean(args.write), file });
    return JSON.stringify({ version: r.version, previous: r.previous, section: r.section, link: r.link, written: r.written ? { path: r.written.path, changed: r.written.changed } : null }, null, 2);
  }
  return null;
}

/** Handle one JSON-RPC message. Returns a response object, or null for notifications. */
export async function handleMessage(msg, { version, base = {} } = {}) {
  const isRequest = msg && msg.id !== undefined && msg.id !== null;
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
  if (!isRequest) return null;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST, capabilities: { tools: {} }, serverInfo: { name: 'shill', version } });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      if (typeof args !== 'object' || Array.isArray(args)) return fail(-32602, 'arguments must be an object');
      try {
        return reply({ content: [{ type: 'text', text: await callTool(name, args, base) }] });
      } catch (err) {
        if (err instanceof ParamsError) return fail(-32602, err.message);
        return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** Run the server until stdin closes. */
export function serveMcp({ input = process.stdin, output = process.stdout, version = '0.0.0', base = {} } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const p = handleMessage(msg, { version, base }).then((res) => { if (res) output.write(JSON.stringify(res) + '\n'); });
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
  process.stderr.write(`shill mcp ${version}: ready on stdio\n`);
  return new Promise((resolve) => rl.on('close', () => Promise.allSettled([...pending]).then(resolve)));
}
