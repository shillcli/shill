// Mock GitHub API for the website tests. Serves the example repo from docs/demo.js plus
// a few special repos for the other states, with CORS and rate limit headers like GitHub.
import http from 'node:http';
import { demoAnswer, DEMO_COMMITS } from '../docs/demo.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'ETag, Link, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
};

/**
 * Start the mock. Options:
 *   remaining  starting x-ratelimit-remaining (decrements per call)
 *   delay      ms to wait before each answer (to see loading states)
 */
export async function startGitHubMock({ remaining = 60, delay = 0 } = {}) {
  const requests = [];
  const state = { remaining };
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'access-control-allow-headers': '*' }); return res.end(); }
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const send = (status, json, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...CORS, 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': String(Math.max(0, state.remaining)), 'x-ratelimit-reset': '1791990000', ...extra });
      res.end(JSON.stringify(json));
    };
    if (/^\/repos\/acme\/limited/.test(p) || state.remaining <= 0) return send(403, { message: 'API rate limit exceeded for 127.0.0.1.' }, { 'x-ratelimit-remaining': '0' });
    state.remaining--;
    if (p === '/repos/acme/quiet') return send(200, { full_name: 'acme/quiet', default_branch: 'main', owner: { login: 'acme' } });
    if (p === '/repos/acme/quiet/tags') return send(200, [{ name: 'v3.0.0' }]);
    if (p.startsWith('/repos/acme/quiet/compare/')) return send(200, { total_commits: 0, commits: [], base_commit: { commit: { committer: { date: '2026-10-01T00:00:00Z' } } } });
    if (p === '/repos/acme/quiet/commits') return send(200, DEMO_COMMITS.slice(0, 5).reverse());
    if (p === '/repos/acme/fresh') return send(200, { full_name: 'acme/fresh', default_branch: 'trunk', owner: { login: 'acme' } });
    if (p === '/repos/acme/fresh/tags' || p === '/repos/acme/fresh/releases') return send(200, []);
    if (p === '/repos/acme/fresh/commits') return send(200, [...DEMO_COMMITS].reverse().slice(0, Number(url.searchParams.get('per_page') || 30)));
    const body = demoAnswer(req.url);
    return body ? send(200, body) : send(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
