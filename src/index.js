import { readFile } from 'node:fs/promises';
import { ShillError } from './errors.js';
import { GitHubClient, DEFAULT_GITHUB_API, resolveSince, parseDuration } from './github.js';
import { analyze } from './parse.js';
import { renderMarkdown } from './render.js';
import { PROVIDERS, generate } from './llm.js';
import { latestTag, suggestNext } from './semver.js';
import { pickHighlights, leaderboard } from './highlights.js';
import { parseChannels, renderPosts, xPost, postStats } from './channels.js';
import { changelogSection, compareLink, writeChangelog } from './changelog.js';
import * as local from './git.js';

export { ShillError } from './errors.js';
export { GitHubClient } from './github.js';
export { parseMessage, noiseReason, analyze } from './parse.js';
export { renderMarkdown, templateTweet, truncateTweet, tweetLength, tweetProblems } from './render.js';
export { parseVersion, latestTag, previousTag, suggestNext } from './semver.js';
export { scoreEntry, pickHighlights, leaderboard } from './highlights.js';
export { CHANNELS, parseChannels, renderPosts, postProblems, escapeHtml } from './channels.js';
export { changelogSection, insertSection, writeChangelog } from './changelog.js';
export { postDiscord, postTelegram, publish, writeDrafts } from './publish.js';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const TONES = ['plain', 'hype', 'technical'];

/** Pick a provider: explicit choice wins, then whichever API key is present, else "none". */
export function pickProvider(explicit, env = process.env) {
  if (explicit) {
    if (explicit !== 'none' && !PROVIDERS[explicit]) throw new ShillError(`Unknown provider "${explicit}" (use openai, anthropic or none)`, { exitCode: 2 });
    return explicit;
  }
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'none';
}

const isTagLike = (since) => Boolean(since) && since !== 'latest' && !parseDuration(since) && !/^\d{4}-\d{2}-\d{2}/.test(since);

export function githubClient(options = {}, env = process.env) {
  return new GitHubClient({
    token: options.githubToken ?? env.GITHUB_TOKEN,
    baseUrl: options.githubApi || env.SHILL_GITHUB_API || DEFAULT_GITHUB_API,
    fetch: options.fetch,
  });
}

/** Fetch raw commits plus range metadata from GitHub or from a local checkout. */
async function collect(options, env, maxCommits) {
  let since = options.since;
  let latestUsed = false;
  if (options.local) {
    const dir = options.dir || process.cwd();
    const info = await local.repoInfo(dir);
    const slug = options.repo || info.slug;
    if (since === 'latest') { since = latestTag(await local.listTags(dir)); latestUsed = true; }
    const got = await local.localCommits(dir, { since, until: options.until, max: maxCommits, slug, now: options.now });
    let firstTimers = new Set();
    const prior = await local.priorAuthors(dir, got.beforeArgs);
    if (prior) {
      for (const c of got.commits) {
        const key = c.author?.login || c.commit.author.name;
        if (!prior.has(key) && !prior.has(c.commit.author.name)) firstTimers.add(key);
      }
    }
    return { source: 'local', slug, name: slug ? slug.split('/')[1] : info.name, label: got.label, raw: got.commits, excludeSha: null, since, latestUsed, firstTimers };
  }
  const repo = options.repo;
  if (!repo || !REPO_RE.test(repo)) throw new ShillError(`Expected a repository as owner/repo, got "${repo ?? ''}"`, { exitCode: 2 });
  const client = githubClient(options, env);
  if (since === 'latest') { since = latestTag(await client.listTags(repo)); latestUsed = true; }
  const range = await resolveSince(client, repo, since, options.now);
  const raw = await client.listCommits(repo, { since: range.date, until: options.until, max: maxCommits });
  const firstTimers = new Set();
  if (range.date && options.firstTimers !== false) {
    const logins = [...new Set(raw.map((c) => c.author?.login).filter(Boolean))].slice(0, 15);
    await Promise.all(logins.map(async (login) => {
      try { if (await client.isFirstTimer(repo, login, range.date)) firstTimers.add(login); } catch { /* best effort */ }
    }));
  }
  return { source: 'github', slug: repo, name: repo.split('/')[1], label: range.label, raw, excludeSha: range.excludeSha, since, latestUsed, firstTimers };
}

/**
 * Generate release notes, a version suggestion and channel drafts.
 * @returns {Promise<object>} see README "Programmatic API"
 */
export async function shill(options = {}) {
  const env = options.env || process.env;
  const maxCommits = Number(options.maxCommits ?? 200);
  if (!Number.isInteger(maxCommits) || maxCommits < 1) throw new ShillError('--max-commits must be a positive integer', { exitCode: 2 });
  const tone = options.tone || 'plain';
  if (!TONES.includes(tone)) throw new ShillError(`Unknown tone "${tone}" (use ${TONES.join(', ')})`, { exitCode: 2 });
  const channels = parseChannels(options.channels);
  const provider = pickProvider(options.provider, env);
  const apiKey = provider === 'none' ? null : options.apiKey ?? env[PROVIDERS[provider].envKey];
  if (provider !== 'none' && !apiKey) throw new ShillError(`--provider ${provider} needs ${PROVIDERS[provider].envKey} to be set`, { exitCode: 2 });
  if (!options.local && (!options.repo || !REPO_RE.test(options.repo))) throw new ShillError(`Expected a repository as owner/repo, got "${options.repo ?? ''}"`, { exitCode: 2 });
  let voice = options.voice || '';
  if (!voice && options.voiceFile) {
    try { voice = await readFile(options.voiceFile, 'utf8'); } catch (err) { throw new ShillError(`Could not read --voice file ${options.voiceFile}: ${err.message}`, { exitCode: 2 }); }
  }

  const src = await collect(options, env, maxCommits);
  const display = src.slug || src.name;
  const label = options.until ? `${src.label} up to ${options.until}` : src.label;
  const analysis = { repo: display, label, ...analyze(src.raw, { repo: src.slug, excludeSha: src.excludeSha }) };
  const sinceTag = isTagLike(src.since) ? src.since : null;
  const version = sinceTag || src.latestUsed ? suggestNext(sinceTag, analysis.entries) : null;
  const tag = options.tag || (version?.bump ? version.next : null);
  const highlights = pickHighlights(analysis.entries, 3);
  const contributors = leaderboard(analysis.entries, src.firstTimers);
  const link = src.slug ? (options.tag ? `https://github.com/${src.slug}/releases/tag/${options.tag}` : `https://github.com/${src.slug}/releases`) : null;
  const ctx = { repo: src.slug, name: src.name, version: tag, label, groups: analysis.groups, stats: analysis.stats, highlights, contributors, link };

  let markdown = renderMarkdown({ ...analysis, contributors });
  const posts = renderPosts(ctx, channels);
  let tweet = posts.x ?? xPost(ctx);
  const warnings = [];
  let usedProvider = 'none';
  if (provider !== 'none' && analysis.stats.kept > 0) {
    const ai = await generate({
      provider, apiKey, model: options.model, baseUrl: options.llmBase || env.SHILL_LLM_BASE, tone, fetch: options.fetch, channels, voice,
    }, { ...analysis, version: tag, highlights, contributors });
    markdown = ai.notes;
    tweet = ai.tweet;
    if (posts.x !== undefined) posts.x = tweet;
    Object.assign(posts, ai.posts);
    warnings.push(...ai.warnings);
    usedProvider = provider;
  }

  return {
    repo: display, slug: src.slug, source: src.source, range: label, since: src.since || null, tag, provider: usedProvider,
    markdown, tweet, posts, counts: postStats(posts), version, highlights, contributors, stats: analysis.stats, entries: analysis.entries, warnings,
  };
}

/** Suggest the next version since the latest tag (or `since`). No AI involved. */
export async function nextVersion(options = {}) {
  const r = await shill({ ...options, since: options.since ?? 'latest', provider: 'none', channels: ['x'] });
  const v = r.version || suggestNext(null, r.entries);
  return { repo: r.repo, range: r.range, ...v, stats: r.stats, highlights: r.highlights.map((h) => h.subject) };
}

/** Build a Keep a Changelog section and optionally write it into a file. */
export async function changelogEntry(options = {}) {
  const r = await shill({ ...options, since: options.since ?? 'latest', provider: 'none', channels: ['x'] });
  const v = r.version || suggestNext(null, r.entries);
  const version = options.version || v.next;
  const section = changelogSection({ version, date: options.date, entries: r.entries });
  const link = compareLink(r.slug, version, isTagLike(r.since) ? r.since : null);
  const out = { repo: r.repo, version, previous: v.current, section, link, written: null };
  if (options.write) out.written = await writeChangelog(options.file || 'CHANGELOG.md', section, version, link);
  return out;
}
