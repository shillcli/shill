import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Start a local HTTP server. `handler(req, body, base)` returns { status, headers, json }. */
export async function startServer(handler, port = 0) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
    const out = (await handler(req, parsed, base)) || { status: 404, json: { message: 'Not Found' } };
    res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) });
    res.end(JSON.stringify(out.json));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

let counter = 0;
export function commit(message, { login = 'alice', parents = 1, sha } = {}) {
  counter++;
  const id = sha || counter.toString(16).padStart(7, '0') + 'a'.repeat(33);
  return {
    sha: id,
    html_url: `https://github.com/acme/rocket/commit/${id}`,
    commit: { message, author: { name: login, date: '2026-10-01T12:00:00Z' }, committer: { date: '2026-10-01T12:00:00Z' } },
    author: login ? { login } : null,
    parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
  };
}

/** A GitHub mock that serves `commits` in pages of `pageSize` and knows tag `v1.0.0`. */
export function githubHandler(commits, { pageSize = 100, tagSha = 'f'.repeat(40), tagDate = '2026-09-01T00:00:00Z', tags = null, releases = [], firstTimers = [], patched = [] } = {}) {
  return (req, body, base) => {
    const url = new URL(req.url, base);
    const p = url.pathname;
    if (p === '/repos/acme/rocket/tags' && tags) return { json: (typeof tags === 'function' ? tags() : tags).map((name) => ({ name, commit: { sha: 'c'.repeat(40) } })) };
    if (p === '/repos/acme/rocket/releases') return { json: typeof releases === 'function' ? releases() : releases };
    const rel = /^\/repos\/acme\/rocket\/releases\/(\d+)$/.exec(p);
    if (rel && req.method === 'PATCH') { patched.push({ id: Number(rel[1]), body: body.body }); return { json: { id: Number(rel[1]), body: body.body } }; }
    const relTag = /^\/repos\/acme\/rocket\/releases\/tags\/(.+)$/.exec(p);
    const list = typeof releases === 'function' ? releases() : releases;
    if (relTag && list.some((r) => r.tag_name === decodeURIComponent(relTag[1]))) return { json: list.find((r) => r.tag_name === decodeURIComponent(relTag[1])) };
    const ref = /^\/repos\/acme\/rocket\/git\/refs\/tags\/(.+)$/.exec(p);
    const tagList = typeof tags === 'function' ? tags() : tags;
    if (ref && tagList?.includes(decodeURIComponent(ref[1])) && decodeURIComponent(ref[1]) !== 'v1.0.0') return { json: { ref: `refs/tags/${ref[1]}`, object: { type: 'commit', sha: tagSha } } };
    if (p === '/repos/acme/rocket/commits' && url.searchParams.get('author')) {
      return { json: firstTimers.includes(url.searchParams.get('author')) ? [] : [commits[0] || {}] };
    }
    if (p === '/repos/acme/rocket/git/refs/tags/v1.0.0') return { json: { ref: 'refs/tags/v1.0.0', object: { type: 'tag', sha: 'annot1' } } };
    if (p === '/repos/acme/rocket/git/tags/annot1') return { json: { object: { type: 'commit', sha: tagSha } } };
    if (p === `/repos/acme/rocket/commits/${tagSha}`) return { json: { sha: tagSha, commit: { committer: { date: tagDate } } } };
    if (p === '/repos/acme/rocket/releases/tags/v0.9.0') return { json: { tag_name: 'v0.9.0', published_at: '2026-08-01T00:00:00Z' } };
    if (p === '/repos/acme/rocket/commits') {
      const page = Number(url.searchParams.get('page') || 1);
      const slice = commits.slice((page - 1) * pageSize, page * pageSize);
      const headers = {};
      if (page * pageSize < commits.length) {
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        headers.link = `<${next}>; rel="next", <${base}/last>; rel="last"`;
      }
      return { json: slice, headers };
    }
    return null;
  };
}

export const SAMPLE = [
  'feat(cli): add --dry-run flag to preview uploads (#42)',
  'fix: retry uploads when the server returns 503',
  'feat!: drop support for config.yml\n\nBREAKING CHANGE: use rocket.config.json instead',
  'perf(build): cache compiled templates between runs',
  "Merge pull request #41 from bob/feature-x\n\nfeat: something",
  'chore(deps): bump undici from 6.1.0 to 6.2.1',
  'docs: fix typo in README',
  'docs: document the --dry-run flag',
  'refactor(core): split upload queue into its own module',
  'fix: retry uploads when the server returns 503',
  'Update CI matrix to Node 22',
  'v1.1.0',
];

/** Mock OpenAI chat completions server reply. */
export const openaiReply = (obj) => ({ json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }] } });

/** Discord webhook mock: records content, answers like ?wait=true. */
export function discordHandler(status = 200) {
  let n = 0;
  return (req, body) => (req.method === 'POST' && req.url.startsWith('/api/webhooks/')
    ? (status === 200 ? { json: { id: `msg${++n}`, content: body.content } } : { status, json: { message: 'Unknown Webhook', code: 10015 } })
    : null);
}

/** Telegram Bot API mock for sendMessage. */
export function telegramHandler() {
  let n = 0;
  return (req, body) => {
    if (!/^\/bot[^/]+\/sendMessage$/.test(req.url)) return null;
    if (req.url !== '/botTEST:TOKEN/sendMessage') return { status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } };
    return { json: { ok: true, result: { message_id: ++n, chat: { id: body.chat_id }, text: body.text } } };
  };
}

/** Create a throwaway git repository with tags and a few authors. Returns its path. */
export function makeGitRepo({ remote = 'https://github.com/acme/rocket.git' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shill-git-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.com' };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git('init', '-q', '-b', 'main');
  let i = 0;
  const commit = (message, author = 'Alice <12+alice@users.noreply.github.com>', files = 1) => {
    i++;
    for (let f = 0; f < files; f++) writeFileSync(join(dir, `file${i}-${f}.txt`), `${message}\n`);
    git('add', '-A');
    const date = `2026-0${Math.min(9, 1 + Math.floor(i / 3))}-1${i % 10}T12:00:00Z`;
    execFileSync('git', ['commit', '-q', '-m', message, '--author', author], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  commit('feat: first public version');
  commit('fix: handle empty config', 'Bob <bob@example.com>');
  git('tag', 'v1.0.0');
  commit('feat(cli): add --dry-run flag to preview uploads (#42)', undefined, 4);
  commit('fix: retry uploads when the server returns 503', 'Bob <bob@example.com>');
  commit('perf(build): cache compiled templates between runs', 'Carol <carol@example.com>', 6);
  commit('docs: fix typo in README');
  commit('chore(deps): bump undici from 6.1.0 to 6.2.1', 'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>');
  commit('feat: upload progress bar', 'Dave <77+dave@users.noreply.github.com>', 3);
  git('tag', 'v1.1.0');
  commit('feat!: drop support for config.yml\n\nBREAKING CHANGE: use rocket.config.json instead', undefined, 8);
  commit('fix: clearer error when the token is missing', 'Bob <bob@example.com>');
  if (remote) git('remote', 'add', 'origin', remote);
  return dir;
}
