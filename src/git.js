/** Local mode: read commits and tags from a git checkout with `git` itself. */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { ShillError } from './errors.js';
import { parseDuration } from './github.js';

function git(dir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).trim().split('\n')[0];
        if (err.code === 'ENOENT') reject(new ShillError('git is not installed or not on PATH'));
        else reject(new ShillError(`git ${args[0]} failed in ${dir}: ${msg}`));
      } else resolve(stdout);
    });
  });
}

/** Turn a remote URL into "owner/repo" when it points at GitHub. */
export function slugFromRemote(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Guess a GitHub login from a noreply address like 123+alice@users.noreply.github.com. */
export function loginFromEmail(email) {
  const m = /^(?:\d+\+)?([\w-]+)@users\.noreply\.github\.com$/i.exec(String(email || ''));
  return m ? m[1] : null;
}

export async function repoInfo(dir) {
  const root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  let slug = null;
  try { slug = slugFromRemote(await git(dir, ['remote', 'get-url', 'origin'])); } catch { /* no remote */ }
  return { root, slug, name: slug ? slug.split('/')[1] : basename(root) };
}

/** Tags reachable from HEAD. */
export async function listTags(dir) {
  const out = await git(dir, ['tag', '--merged', 'HEAD']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function refExists(dir, ref) {
  try { await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true; } catch { return false; }
}

/** Resolve --since for a local repo into git log arguments and a label. */
export async function resolveLocalSince(dir, since, now = new Date()) {
  if (!since) return { args: [], beforeArgs: null, label: 'all history', tag: null };
  const dur = parseDuration(since, now);
  if (dur) return { args: [`--since=${dur.toISOString()}`], beforeArgs: [`--until=${dur.toISOString()}`], label: `last ${since}`, tag: null };
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) throw new ShillError(`Invalid date for --since: ${since}`);
    return { args: [`--since=${d.toISOString()}`], beforeArgs: [`--until=${d.toISOString()}`], label: `since ${since}`, tag: null };
  }
  if (!(await refExists(dir, since))) throw new ShillError(`Tag or ref "${since}" not found in the local repository`);
  return { args: [], range: since, beforeArgs: [since], label: `since ${since}`, tag: since };
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** Read commits newest first, shaped like GitHub API commit objects (plus `files`). */
export async function localCommits(dir, { since, until, max = 200, slug = null, now } = {}) {
  const resolved = await resolveLocalSince(dir, since, now);
  const tip = until || 'HEAD';
  if (until && !(await refExists(dir, until))) throw new ShillError(`Ref "${until}" not found in the local repository`);
  const rev = resolved.range ? `${resolved.range}..${tip}` : tip;
  const fmt = `${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%cI${FIELD}%B${FIELD}`;
  const out = await git(dir, ['log', `--max-count=${max}`, `--format=${fmt}`, '--numstat', ...resolved.args, rev, '--']);
  const commits = [];
  for (const chunk of out.split(RECORD)) {
    if (!chunk.trim()) continue;
    const [sha, parents, name, email, date, cdate, message, numstat = ''] = chunk.split(FIELD);
    const login = loginFromEmail(email);
    commits.push({
      sha,
      html_url: slug ? `https://github.com/${slug}/commit/${sha}` : null,
      commit: { message: message.trim(), author: { name, email, date }, committer: { date: cdate } },
      author: login ? { login } : null,
      parents: parents.trim() ? parents.trim().split(' ').map((p) => ({ sha: p })) : [],
      files: numstat.split('\n').filter((l) => /^\S+\t\S+\t/.test(l)).length,
    });
  }
  return { commits, label: resolved.label, tag: resolved.tag, beforeArgs: resolved.beforeArgs };
}

/** Author names and noreply logins that committed before the range. */
export async function priorAuthors(dir, beforeArgs) {
  if (!beforeArgs) return null;
  const out = await git(dir, ['log', `--format=%an${FIELD}%ae`, ...beforeArgs, '--']);
  const set = new Set();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [name, email] = line.split(FIELD);
    set.add(name);
    const login = loginFromEmail(email);
    if (login) set.add(login);
  }
  return set;
}
