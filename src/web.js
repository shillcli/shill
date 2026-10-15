/**
 * The browser engine behind shillcli.com: a public GitHub repo in, notes, next version,
 * CHANGELOG entry and every channel draft out. Template mode only, zero dependencies,
 * no Node built-ins, so docs/lib/web.js is a byte-for-byte copy of this file.
 */
import { ShillError } from './errors.js';
import { GitHubClient, DEFAULT_GITHUB_API } from './github.js';
import { analyze } from './parse.js';
import { renderMarkdown } from './render.js';
import { latestTag, parseVersion, suggestNext } from './semver.js';
import { pickHighlights, leaderboard } from './highlights.js';
import { CHANNELS, renderPosts, postStats } from './channels.js';
import { changelogSection, compareLink } from './changelog-core.js';

export const ALL_CHANNELS = Object.keys(CHANNELS);
export const MIN_COMMITS = 5;
export const MAX_COMMITS = 100;

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[\w.-]{1,100}$/;

/**
 * Accept "owner/repo", a github.com URL (with or without https, .git, /tree/...),
 * or "git@github.com:owner/repo.git". Returns "owner/repo" or null.
 */
export function parseRepoInput(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/^git@github\.com:/i, '').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const [owner, repo] = s.split('/');
  if (!owner || !repo) return null;
  const name = repo.replace(/\.git$/i, '');
  if (!NAME_RE.test(owner) || !REPO_RE.test(name) || name === '.' || name === '..') return null;
  return `${owner}/${name}`;
}

/** Clamp the "last N commits" value to what one API page can return. */
export function clampCount(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 30;
  return Math.min(MAX_COMMITS, Math.max(MIN_COMMITS, v));
}

/** Error kinds the page knows how to explain. */
export class WebError extends ShillError {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'WebError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/**
 * Wrap fetch so every response records GitHub's rate limit headers and status.
 * `state` is mutated: { remaining, limit, reset, lastStatus, calls }.
 */
export function trackingFetch(fetchImpl, state) {
  return async (url, init) => {
    state.calls = (state.calls || 0) + 1;
    const res = await fetchImpl(url, init);
    state.lastStatus = res.status;
    const h = (k) => res.headers.get(k);
    if (h('x-ratelimit-remaining') !== null) {
      state.remaining = Number(h('x-ratelimit-remaining'));
      state.limit = Number(h('x-ratelimit-limit')) || state.limit;
      state.reset = Number(h('x-ratelimit-reset')) || state.reset;
    }
    return res;
  };
}

/** Turn whatever went wrong into a WebError with a message a person can act on. */
export function explain(err, { repo, rate = {}, found = false } = {}) {
  if (err instanceof WebError) return err;
  const msg = String(err?.message || err);
  const status = rate.lastStatus;
  const limited = status === 429 || (status === 403 && (rate.remaining === 0 || /rate limit/i.test(msg)));
  if (limited) {
    return new WebError('rate_limited', 'GitHub allows 60 API calls an hour per visitor without a token, and this connection has used them up.', { reset: rate.reset || null });
  }
  if (status === 404 && !found) return new WebError('not_found', `GitHub has no public repository called ${repo}. Check the spelling, or it may be private.`);
  if (status === 404) return new WebError('not_found', `GitHub could not find the commits for that range in ${repo}. Try the last N commits instead.`);
  if (status === 451 || status === 403) return new WebError('forbidden', `GitHub refused to share ${repo} (status ${status}).`);
  if (/Could not reach/i.test(msg) || /fetch|network/i.test(msg)) return new WebError('network', 'Could not reach the GitHub API. Check your connection and try again.');
  return new WebError('unknown', msg.replace(/ for https?:\/\/\S+/, ''));
}

function today(now) {
  const d = now ? new Date(now) : new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Generate everything for one repo. Options:
 *   repo        "owner/repo" (already parsed)
 *   range       "release" (since the latest release or semver tag, default) or "commits"
 *   count       N for range "commits"
 *   fetch       fetch implementation (defaults to globalThis.fetch)
 *   baseUrl     GitHub API base, default https://api.github.com
 *   onStep      called with a short status line while it works
 *   firstTimerChecks  max contributors to check for a first commit (each costs one call)
 */
export async function generate(options = {}) {
  const repoIn = parseRepoInput(options.repo);
  if (!repoIn) throw new WebError('bad_input', 'Paste a public GitHub repo as owner/repo or a github.com link.');
  const rate = options.rate || {};
  const fetchImpl = trackingFetch(options.fetch || globalThis.fetch.bind(globalThis), rate);
  const client = new GitHubClient({ baseUrl: options.baseUrl || DEFAULT_GITHUB_API, fetch: fetchImpl });
  const step = options.onStep || (() => {});
  const wantRange = options.range === 'commits' ? 'commits' : 'release';
  const count = clampCount(options.count ?? 30);
  const notes = [];
  let repo = repoIn;
  let found = false;

  try {
    step('Looking up the repo');
    const { data: meta } = await client.request(`/repos/${repo}`);
    repo = meta.full_name || repo;
    found = true;
    const branch = meta.default_branch || 'HEAD';

    step('Reading tags');
    const tags = await client.listTags(repo);
    let base = latestTag(tags);
    if (!base && wantRange === 'release') {
      const releases = await client.listReleases(repo, { perPage: 5 });
      base = releases[0]?.tag_name || null;
    }

    let range = wantRange;
    const fellBack = range === 'release' && !base;
    if (fellBack) range = 'commits';

    let raw;
    let label;
    let truncated = false;
    let baseDate = null;
    if (range === 'release') {
      step(`Comparing ${base} with ${branch}`);
      const { data: cmp } = await client.request(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`);
      raw = [...(cmp.commits || [])].reverse();
      label = `since ${base}`;
      baseDate = cmp.base_commit?.commit?.committer?.date || cmp.base_commit?.commit?.author?.date || null;
      if (Number(cmp.total_commits) > raw.length) {
        truncated = true;
        notes.push(`GitHub returns at most ${raw.length} commits for one comparison; ${cmp.total_commits} landed since ${base}, so the oldest ones are left out.`);
      }
    } else {
      step(`Reading the last ${count} commits`);
      const { data } = await client.request(`/repos/${repo}/commits?per_page=${count}&sha=${encodeURIComponent(branch)}`);
      if (!Array.isArray(data)) throw new WebError('unknown', `Unexpected response listing commits for ${repo}.`);
      raw = data;
      label = `last ${raw.length} commits`;
      if (fellBack) notes.push(`${repo} has no releases or semver tags yet, so this covers the last ${raw.length} commits.`);
    }

    const analysis = analyze(raw, { repo });
    const firstTimers = new Set();
    let firstTimerStatus = range === 'release' ? 'checked' : 'skipped';
    if (range === 'release' && baseDate && analysis.entries.length) {
      const budget = Number.isFinite(options.firstTimerChecks) ? options.firstTimerChecks : 4;
      const logins = leaderboard(analysis.entries).map((c) => c.login).filter(Boolean).filter((l) => !/\[bot\]$/.test(l));
      const pick = logins.slice(0, budget);
      if (rate.remaining !== undefined && rate.remaining < pick.length + 6) firstTimerStatus = 'skipped';
      else {
        if (pick.length) step('Checking for first-time contributors');
        await Promise.all(pick.map(async (login) => {
          try { if (await client.isFirstTimer(repo, login, baseDate)) firstTimers.add(login); } catch { /* best effort */ }
        }));
        if (logins.length > pick.length) firstTimerStatus = 'partial';
      }
    }

    const semverBase = range === 'release' && parseVersion(base) ? base : latestTag(tags);
    const version = analysis.entries.length ? suggestNext(semverBase, analysis.entries) : { current: semverBase, next: semverBase, bump: null, reasons: ['No releasable commits in this range.'] };
    version.estimate = range !== 'release';
    if (version.estimate && analysis.entries.length) {
      version.reasons.push(semverBase
        ? `Estimate: based on the last ${raw.length} commits, which may include changes already released in ${semverBase}.`
        : `Estimate: based on the last ${raw.length} commits, not on a release range.`);
    }

    const tag = range === 'release' && version.bump ? version.next : null;
    const highlights = pickHighlights(analysis.entries, 3);
    const contributors = leaderboard(analysis.entries, firstTimers);
    const name = repo.split('/')[1];
    const link = `https://github.com/${repo}/releases`;
    const ctx = { repo, name, version: tag, label, groups: analysis.groups, stats: analysis.stats, highlights, contributors, link };
    const posts = analysis.entries.length ? renderPosts(ctx, ALL_CHANNELS) : {};
    const markdown = renderMarkdown({ repo, label, groups: analysis.groups, stats: analysis.stats, contributors });
    const clVersion = version.next || 'v0.1.0';
    const changelog = analysis.entries.length
      ? { version: clVersion, section: changelogSection({ version: clVersion, date: today(options.now), entries: analysis.entries }), link: compareLink(repo, clVersion, range === 'release' ? base : null) }
      : null;

    return {
      repo, range, label, base: range === 'release' ? base : null, branch, count, truncated, notes,
      meta: {
        description: meta.description || '', stars: meta.stargazers_count ?? null, url: meta.html_url || `https://github.com/${repo}`,
        avatar: meta.owner?.avatar_url || null, owner: meta.owner?.login || repo.split('/')[0],
      },
      tag, version, markdown, posts, counts: postStats(posts), changelog, highlights, contributors, firstTimerStatus,
      stats: analysis.stats, empty: analysis.entries.length === 0, rate: { ...rate },
    };
  } catch (err) {
    throw explain(err, { repo, rate, found });
  }
}
