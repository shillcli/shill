/** Agent watch mode: poll a repo for new releases and tags, generate notes, post once. */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ShillError } from './errors.js';
import { shill, githubClient } from './index.js';
import { parseVersion, compareVersions, previousTag } from './semver.js';
import { publish, writeDrafts, checkPublish } from './publish.js';

const MAX_ATTEMPTS = 3;

export async function loadState(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data && typeof data === 'object' && data.repos ? data : { version: 1, repos: {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, repos: {} };
    throw new ShillError(`State file ${file} is not valid JSON: ${err.message}`);
  }
}

/** Write state atomically so a crash never leaves a half-written file. */
export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await rename(tmp, file);
}

/** Releases (non-draft) plus semver tags without a release, oldest first. */
export async function listCandidates(client, repo) {
  const [releases, tags] = await Promise.all([client.listReleases(repo), client.listTags(repo)]);
  const byTag = new Map();
  for (const r of releases) byTag.set(r.tag_name, { tag: r.tag_name, releaseId: r.id, prerelease: Boolean(r.prerelease) });
  for (const t of tags) if (!byTag.has(t) && parseVersion(t)) byTag.set(t, { tag: t, releaseId: null, prerelease: Boolean(parseVersion(t).pre) });
  const all = [...byTag.values()];
  const order = (a, b) => {
    const va = parseVersion(a.tag); const vb = parseVersion(b.tag);
    if (va && vb) return compareVersions(va, vb);
    return va ? 1 : vb ? -1 : a.tag.localeCompare(b.tag);
  };
  return { candidates: all.sort(order), tagNames: [...new Set([...tags, ...releases.map((r) => r.tag_name)])] };
}

/**
 * One poll. First poll of a repo records what exists as a baseline and posts nothing.
 * Each new tag is processed once; a channel is retried on later polls only if it failed.
 */
export async function pollOnce(options, state, log = () => {}) {
  const env = options.env || process.env;
  const repo = options.repo;
  const client = githubClient(options, env);
  const { candidates, tagNames } = await listCandidates(client, repo);
  const rs = (state.repos[repo] ||= { initialized: false, tags: {} });
  const now = (options.clock || (() => new Date()))().toISOString();
  if (!rs.initialized) {
    for (const c of candidates) rs.tags[c.tag] = { seenAt: now, baseline: true, done: true, posted: [] };
    rs.initialized = true;
    log(`baseline: ${candidates.length} existing release(s) and tag(s) recorded for ${repo}, nothing posted`);
    return [];
  }
  const events = [];
  const targets = options.post || [];
  for (const c of candidates) {
    const entry = rs.tags[c.tag];
    if (entry?.done) continue;
    const rec = entry || (rs.tags[c.tag] = { seenAt: now, posted: [], attempts: 0, done: false });
    const since = previousTag(tagNames, c.tag);
    log(`new ${c.releaseId ? 'release' : 'tag'} ${c.tag} (notes since ${since || 'the first commit'})`);
    const event = { tag: c.tag, since, posted: [], errors: [], drafts: [] };
    let result;
    try {
      result = await shill({ ...options, since: since || undefined, until: c.tag, tag: c.tag });
    } catch (err) {
      rec.attempts = (rec.attempts || 0) + 1;
      rec.lastError = err.message;
      rec.done = rec.attempts >= MAX_ATTEMPTS;
      event.errors.push(`generate: ${err.message}`);
      log(`could not generate notes for ${c.tag}: ${err.message}`);
      events.push(event);
      if (options.stateFile) await saveState(options.stateFile, state);
      continue;
    }
    if (options.draftsDir) event.drafts = await writeDrafts(join(options.draftsDir, c.tag.replace(/[^\w.-]/g, '_')), result);
    for (const t of targets.filter((x) => !rec.posted.includes(x))) {
      try {
        await publish(result, [t], options.creds || {});
        rec.posted.push(t);
        event.posted.push(t);
        log(`posted ${c.tag} to ${t}`);
      } catch (err) {
        event.errors.push(`${t}: ${err.message}`);
        log(`failed to post ${c.tag} to ${t}: ${err.message}`);
      }
    }
    rec.attempts = (rec.attempts || 0) + 1;
    rec.done = targets.every((t) => rec.posted.includes(t)) || rec.attempts >= MAX_ATTEMPTS;
    if (event.errors.length) rec.lastError = event.errors.join('; ');
    event.result = result;
    events.push(event);
    if (options.stateFile) await saveState(options.stateFile, state);
  }
  return events;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Poll forever (or once with options.once). Returns the events of the last poll. */
export async function watch(options) {
  const log = options.log || ((m) => process.stderr.write(`shill watch: ${m}\n`));
  if (!options.repo || !/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new ShillError('watch needs a repository as owner/repo', { exitCode: 2 });
  const interval = Number(options.interval ?? 300);
  if (!Number.isFinite(interval) || interval < 10) throw new ShillError('--interval must be at least 10 seconds', { exitCode: 2 });
  checkPublish(options.post || [], options.creds || {});
  const stateFile = options.stateFile || '.shill-state.json';
  const state = await loadState(stateFile);
  let events = [];
  for (;;) {
    try {
      events = await pollOnce({ ...options, stateFile }, state, log);
      await saveState(stateFile, state);
    } catch (err) {
      if (options.once) throw err;
      log(`poll failed: ${err.message}`);
    }
    if (options.once || options.signal?.aborted) return events;
    await sleep(interval * 1000, options.signal);
    if (options.signal?.aborted) return events;
  }
}
