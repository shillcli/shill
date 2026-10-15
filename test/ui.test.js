import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startUi } from '../src/ui.js';
import { startServer, githubHandler, commit, SAMPLE } from '../fixtures/mocks.js';

function request(port, path, { method = 'GET', body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method, host: '127.0.0.1', headers: { host: host || `127.0.0.1:${port}`, 'content-type': 'application/json' } }, async (res) => {
      let text = '';
      for await (const c of res) text += c;
      resolve({ status: res.statusCode, type: res.headers['content-type'], text });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('dashboard serves the page, meta and generated drafts', async (t) => {
  const gh = await startServer(githubHandler(SAMPLE.map((m) => commit(m)), { tags: ['v1.0.0'] }));
  const ui = await startUi({ port: 0, version: '1.0.0', base: { env: { SHILL_GITHUB_API: gh.base } } });
  t.after(() => Promise.all([ui.close(), gh.close()]));
  assert.match(ui.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const page = await request(ui.port, '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /<title>shill dashboard<\/title>/);
  assert.match(page.text, /--accent: #FF2E8B/);
  assert.match(page.text, /Plus Jakarta Sans/);

  const font = await request(ui.port, '/fonts/space-mono-latin-400-normal.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.type, 'font/woff2');
  assert.equal((await request(ui.port, '/fonts/..%2Fui.js')).status, 404);
  assert.equal((await request(ui.port, '/fonts/missing.woff2')).status, 404);

  const meta = JSON.parse((await request(ui.port, '/api/meta')).text);
  assert.equal(meta.version, '1.0.0');
  assert.equal(meta.ai, 'none');
  assert.equal(meta.channels.discord.limit, 2000);

  const gen = await request(ui.port, '/api/generate', { method: 'POST', body: { repo: 'acme/rocket', since: 'latest' } });
  assert.equal(gen.status, 200, gen.text);
  const r = JSON.parse(gen.text);
  assert.equal(r.version.next, 'v2.0.0');
  assert.deepEqual(Object.keys(r.posts), ['x', 'thread', 'discord', 'telegram', 'linkedin']);
  assert.equal(r.counts.x.limit, 280);
  assert.equal(r.highlights[0].type, 'breaking');

  const bad = await request(ui.port, '/api/generate', { method: 'POST', body: { repo: 'nope' } });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).error, /owner\/repo/);
  assert.equal((await request(ui.port, '/api/meta', { host: 'evil.example' })).status, 403);
  assert.equal((await request(ui.port, '/nope')).status, 404);
});
