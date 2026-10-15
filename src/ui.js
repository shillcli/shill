/** Local dashboard: one HTML page plus a small JSON API over node:http. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { shill, ShillError } from './index.js';
import { CHANNELS } from './channels.js';

const PAGE = new URL('./ui.html', import.meta.url);
const FONTS = new URL('./fonts/', import.meta.url);
const FONT_FILE = /^\/fonts\/([a-z0-9-]+\.woff2)$/;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new ShillError('Request body too large', { exitCode: 2 });
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw new ShillError('Request body must be JSON', { exitCode: 2 }); }
}

/** Shape a result for the page. */
export function toView(r) {
  return {
    repo: r.repo, range: r.range, tag: r.tag, provider: r.provider, markdown: r.markdown, posts: r.posts, counts: r.counts, version: r.version,
    highlights: r.highlights.map((h) => ({ subject: h.subject, type: h.breaking ? 'breaking' : h.type, scope: h.scope, score: h.score, sha: h.shortSha, pr: h.pr })),
    contributors: r.contributors, stats: r.stats, warnings: r.warnings,
  };
}

export async function startUi({ port = 4178, host = '127.0.0.1', version = '0.0.0', base = {} } = {}) {
  const env = base.env || process.env;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (LOOPBACK.test(host) && !LOOPBACK.test(req.headers.host || '')) return send(res, 403, { error: 'Forbidden host' });
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await readFile(PAGE, 'utf8'), 'text/html; charset=utf-8');
      const font = req.method === 'GET' && FONT_FILE.exec(url.pathname);
      if (font) {
        try {
          const data = await readFile(new URL(font[1], FONTS));
          res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff' });
          return res.end(data);
        } catch { return send(res, 404, { error: 'Not found' }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/meta') {
        return send(res, 200, {
          version,
          ai: env.OPENAI_API_KEY ? 'openai' : env.ANTHROPIC_API_KEY ? 'anthropic' : 'none',
          channels: Object.fromEntries(Object.entries(CHANNELS).map(([k, v]) => [k, { label: v.label, limit: v.limit }])),
          cwd: process.cwd(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        const b = await readJson(req);
        const opts = {
          ...base, env, repo: b.repo || undefined, since: b.since || undefined, until: b.until || undefined, tag: b.tag || undefined,
          tone: b.tone || undefined, provider: b.provider || undefined, channels: b.channels?.length ? b.channels : 'all',
        };
        if (b.local) { opts.local = true; opts.dir = b.dir || process.cwd(); }
        return send(res, 200, toView(await shill(opts)));
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err instanceof ShillError ? (err.exitCode === 2 ? 400 : 502) : 500;
      return send(res, status, { error: err.message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  return { server, port: actual, url: `http://${host.includes(':') ? `[${host}]` : host}:${actual}/`, close: () => new Promise((r) => server.close(r)) };
}
