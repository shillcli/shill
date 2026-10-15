/**
 * GET /api/github?path=/repos/owner/repo/...
 *
 * Read-only GitHub API proxy, used by shillcli.com only after the visitor's own
 * 60 calls an hour run out. Works without configuration (unauthenticated, from the
 * server's address); set GITHUB_TOKEN in the Vercel project to raise the limit to
 * 5000 an hour. Only the endpoints the page needs are allowed.
 */

const UPSTREAM = 'https://api.github.com';
const TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;
const MAX_PATH = 600;
const SEG = '[A-Za-z0-9_.-]+';
const ALLOWED = [
  new RegExp(`^/repos/${SEG}/${SEG}$`),
  new RegExp(`^/repos/${SEG}/${SEG}/(tags|releases|commits)$`),
  new RegExp(`^/repos/${SEG}/${SEG}/compare/[^/?#]+\\.\\.\\.[^/?#]+$`),
];
const ALLOWED_PARAMS = new Set(['per_page', 'page', 'sha', 'since', 'until', 'author']);
const PASS_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'link'];

const cache = new Map();

/** Validate and normalise the requested path. Returns "/repos/...?..." or null. */
export function cleanPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > MAX_PATH) return null;
  let url;
  try { url = new URL(raw, UPSTREAM); } catch { return null; }
  if (url.origin !== UPSTREAM) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (pathname.includes('..') && !/\/compare\//.test(pathname)) return null;
  if (/\/\.\.?(\/|$)/.test(pathname)) return null;
  if (!ALLOWED.some((re) => re.test(url.pathname))) return null;
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (!ALLOWED_PARAMS.has(k) || v.length > 200) return null;
    params.set(k, v);
  }
  const q = params.toString();
  return url.pathname + (q ? `?${q}` : '');
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-shill-proxy', '1');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Exposed for tests: forget cached responses. */
export function clearCache() { cache.clear(); }

export default async function handler(req, res, { fetch: fetchImpl = globalThis.fetch, env = process.env, upstream = env.SHILL_GITHUB_API || UPSTREAM } = {}) {
  if (req.method !== 'GET') return send(res, 405, { message: 'Only GET is allowed' }, { allow: 'GET', 'cache-control': 'no-store' });
  const q = new URL(req.url, 'http://localhost').searchParams;
  const path = cleanPath(q.get('path'));
  if (!path) return send(res, 400, { message: 'path must be a GitHub repo read endpoint this site uses' }, { 'cache-control': 'no-store' });

  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return send(res, hit.status, hit.body, { ...hit.headers, 'x-shill-cache': 'hit' });

  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'shillcli.com', 'x-github-api-version': '2022-11-28' };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let up;
  try {
    up = await fetchImpl(upstream.replace(/\/+$/, '') + path, { headers, signal: ctrl.signal });
  } catch (err) {
    return send(res, 502, { message: `GitHub did not answer in time (${err.name === 'AbortError' ? 'timeout' : 'network error'})` }, { 'cache-control': 'no-store' });
  } finally {
    clearTimeout(timer);
  }
  const body = await up.text();
  const out = {};
  for (const h of PASS_HEADERS) {
    const v = up.headers.get(h);
    if (v !== null) out[h] = v;
  }
  out['cache-control'] = up.ok ? 'public, s-maxage=60, stale-while-revalidate=300' : 'no-store';
  if (up.ok) {
    cache.set(path, { at: Date.now(), status: up.status, body, headers: out });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  }
  return send(res, up.status, body, out);
}
