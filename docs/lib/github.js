import { ShillError } from './errors.js';

export const DEFAULT_GITHUB_API = 'https://api.github.com';

/** Parse "7d", "12h", "2w" into a Date relative to `now`. Returns null if not a duration. */
export function parseDuration(input, now = new Date()) {
  const m = /^(\d+)([hdw])$/.exec(String(input).trim());
  if (!m) return null;
  const hours = { h: 1, d: 24, w: 168 }[m[2]] * Number(m[1]);
  return new Date(now.getTime() - hours * 3600 * 1000);
}

/** Return the URL marked rel="next" in a GitHub Link header, or null. */
export function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

export class GitHubClient {
  constructor({ token, baseUrl = DEFAULT_GITHUB_API, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  async request(pathOrUrl, { allow404 = false, method = 'GET', body } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.baseUrl + pathOrUrl;
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'shill',
      'x-github-api-version': '2022-11-28',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new ShillError(`Could not reach GitHub API at ${this.baseUrl}: ${err.message}`, { cause: err });
    }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let hint = '';
      if (res.status === 404) hint = ' (repository or ref not found, or it is private and GITHUB_TOKEN is missing)';
      if (res.status === 401) hint = ' (GITHUB_TOKEN is invalid)';
      if (res.status === 403 || res.status === 429) hint = ' (rate limited or forbidden; set GITHUB_TOKEN for higher limits)';
      let detail = body.slice(0, 200);
      try { detail = JSON.parse(body).message || detail; } catch { /* keep raw body */ }
      throw new ShillError(`GitHub API ${res.status} for ${url}${hint}: ${detail}`);
    }
    return { data: await res.json(), link: res.headers.get('link') };
  }

  /** Resolve a tag name to { sha, date }. Tries git refs first, then releases. */
  async resolveTag(repo, tag) {
    const ref = await this.request(`/repos/${repo}/git/refs/tags/${encodeURIComponent(tag)}`, { allow404: true });
    if (ref && !Array.isArray(ref.data)) {
      let { sha, type } = ref.data.object;
      if (type === 'tag') {
        const annotated = await this.request(`/repos/${repo}/git/tags/${sha}`);
        sha = annotated.data.object.sha;
      }
      const commit = await this.request(`/repos/${repo}/commits/${sha}`);
      return { sha, date: commit.data.commit.committer.date };
    }
    const rel = await this.request(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });
    if (rel) return { sha: null, date: rel.data.published_at || rel.data.created_at };
    throw new ShillError(`Tag "${tag}" not found in ${repo}`);
  }

  /** List commits newest first, following pagination until `max` is reached. */
  async listCommits(repo, { since, until, max = 200 } = {}) {
    const params = new URLSearchParams({ per_page: '100' });
    if (since) params.set('since', since);
    if (until) params.set('sha', until);
    let url = `/repos/${repo}/commits?${params}`;
    const out = [];
    while (url && out.length < max) {
      const { data, link } = await this.request(url);
      if (!Array.isArray(data)) throw new ShillError(`Unexpected response listing commits for ${repo}`);
      out.push(...data);
      url = nextLink(link);
    }
    return out.slice(0, max);
  }

  /** GET /repos/{owner}/{repo}/releases, newest first. Drafts are skipped. */
  async listReleases(repo, { perPage = 30 } = {}) {
    const { data } = await this.request(`/repos/${repo}/releases?per_page=${perPage}`);
    return Array.isArray(data) ? data.filter((r) => !r.draft) : [];
  }

  /** GET /repos/{owner}/{repo}/tags, returns tag names. */
  async listTags(repo, { perPage = 100 } = {}) {
    const { data } = await this.request(`/repos/${repo}/tags?per_page=${perPage}`);
    return Array.isArray(data) ? data.map((t) => t.name) : [];
  }

  /** GET /repos/{owner}/{repo}/releases/tags/{tag}, or null. */
  async getReleaseByTag(repo, tag) {
    const res = await this.request(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });
    return res ? res.data : null;
  }

  /** PATCH /repos/{owner}/{repo}/releases/{id} with a new body. */
  async updateRelease(repo, id, body) {
    const { data } = await this.request(`/repos/${repo}/releases/${id}`, { method: 'PATCH', body: { body } });
    return data;
  }

  /** True when `login` has no commits in `repo` before `beforeIso`. */
  async isFirstTimer(repo, login, beforeIso) {
    const params = new URLSearchParams({ author: login, until: beforeIso, per_page: '1' });
    const { data } = await this.request(`/repos/${repo}/commits?${params}`);
    return Array.isArray(data) && data.length === 0;
  }
}

/** Turn a --since value (tag, ISO date or duration) into { date, excludeSha, label }. */
export async function resolveSince(client, repo, since, now = new Date()) {
  if (!since) return { date: null, excludeSha: null, label: 'all history' };
  const dur = parseDuration(since, now);
  if (dur) return { date: dur.toISOString(), excludeSha: null, label: `last ${since}` };
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) throw new ShillError(`Invalid date for --since: ${since}`);
    return { date: d.toISOString(), excludeSha: null, label: `since ${since}` };
  }
  const tag = await client.resolveTag(repo, since);
  return { date: tag.date, excludeSha: tag.sha, label: `since ${since}` };
}
