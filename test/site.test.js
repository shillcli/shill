import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { LIB_FILES } from '../scripts/sync-docs-lib.mjs';
import { startDevSite } from '../scripts/dev-site.mjs';
import { startGitHubMock } from '../fixtures/web-mock.js';
import { generate, parseRepoInput, clampCount } from '../src/web.js';
import handler, { cleanPath, clearCache } from '../api/github.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('docs/lib copies are identical to src', () => {
  for (const f of LIB_FILES) assert.equal(read(`docs/lib/${f}`), read(`src/${f}`), `docs/lib/${f} drifted, run node scripts/sync-docs-lib.mjs`);
});

test('docs/lib has no Node built-ins, so it runs in the browser', () => {
  for (const f of LIB_FILES) assert.doesNotMatch(read(`docs/lib/${f}`), /from 'node:|require\(|process\./, f);
});

test('parseRepoInput accepts slugs and GitHub links', () => {
  assert.equal(parseRepoInput('honojs/hono'), 'honojs/hono');
  assert.equal(parseRepoInput(' https://github.com/vitejs/vite/tree/main/packages '), 'vitejs/vite');
  assert.equal(parseRepoInput('github.com/acme/rocket.git'), 'acme/rocket');
  assert.equal(parseRepoInput('git@github.com:acme/rocket.git'), 'acme/rocket');
  assert.equal(parseRepoInput('https://github.com/acme/rocket?tab=readme'), 'acme/rocket');
  for (const bad of ['', 'rocket', 'not a repo', 'a/..', '-x/y', 'https://gitlab.com/a', 'a b/c']) assert.equal(parseRepoInput(bad), null, bad);
  assert.equal(clampCount(500), 100);
  assert.equal(clampCount(1), 5);
  assert.equal(clampCount('x'), 30);
});

test('generate: since the latest release, with every output', async (t) => {
  const gh = await startGitHubMock();
  t.after(gh.close);
  const steps = [];
  const r = await generate({ repo: 'https://github.com/acme/rocket', baseUrl: gh.base, now: '2026-10-14T00:00:00Z', onStep: (s) => steps.push(s) });
  assert.equal(r.label, 'since v1.4.0');
  assert.equal(r.version.next, 'v2.0.0');
  assert.equal(r.version.bump, 'major');
  assert.equal(r.version.estimate, false);
  assert.equal(r.tag, 'v2.0.0');
  assert.deepEqual(Object.keys(r.posts), ['x', 'thread', 'discord', 'telegram', 'linkedin']);
  assert.ok(r.counts.x.length <= 280);
  assert.ok(r.posts.thread.length >= 3 && r.posts.thread.length <= 6);
  assert.ok(r.posts.thread.every((p) => [...p].length <= 280));
  assert.ok([...r.posts.discord].length <= 2000);
  assert.match(r.posts.x, /^rocket v2\.0\.0 is out/);
  assert.match(r.markdown, /### Breaking Changes/);
  assert.match(r.changelog.section, /^## \[2\.0\.0\] - 2026-10-14/);
  assert.equal(r.changelog.link, '[2.0.0]: https://github.com/acme/rocket/compare/v1.4.0...v2.0.0');
  assert.equal(r.stats.seen, 13);
  assert.equal(r.stats.kept, 8);
  assert.deepEqual(r.contributors.filter((c) => c.firstTime).map((c) => c.login), ['dave']);
  assert.equal(r.highlights[0].breaking, true);
  assert.equal(r.rate.remaining, 53);
  assert.ok(r.rate.calls <= 8, `used ${r.rate.calls} calls`);
  assert.ok(steps.includes('Comparing v1.4.0 with main'));
  assert.ok(gh.requests.some((u) => u.startsWith('/repos/acme/rocket/compare/v1.4.0...main')));
});

test('generate: last N commits is labelled as an estimate', async (t) => {
  const gh = await startGitHubMock();
  t.after(gh.close);
  const r = await generate({ repo: 'acme/rocket', range: 'commits', count: 7, baseUrl: gh.base });
  assert.equal(r.label, 'last 7 commits');
  assert.equal(r.tag, null);
  assert.equal(r.version.estimate, true);
  assert.match(r.version.reasons.at(-1), /^Estimate: based on the last 7 commits/);
  assert.match(r.posts.x, /^New in rocket:/);
  assert.equal(r.firstTimerStatus, 'skipped');
  assert.ok(gh.requests.includes('/repos/acme/rocket/commits?per_page=7&sha=main'));
});

test('generate: no tags falls back to recent commits, nothing new is empty', async (t) => {
  const gh = await startGitHubMock();
  t.after(gh.close);
  const fresh = await generate({ repo: 'acme/fresh', baseUrl: gh.base });
  assert.equal(fresh.range, 'commits');
  assert.match(fresh.notes[0], /no releases or semver tags yet/);
  assert.ok(gh.requests.includes('/repos/acme/fresh/commits?per_page=30&sha=trunk'));
  const quiet = await generate({ repo: 'acme/quiet', baseUrl: gh.base });
  assert.equal(quiet.empty, true);
  assert.equal(quiet.base, 'v3.0.0');
  assert.deepEqual(quiet.posts, {});
});

test('generate: human errors for bad input, missing repo and rate limits', async (t) => {
  const gh = await startGitHubMock();
  t.after(gh.close);
  await assert.rejects(generate({ repo: 'nope', baseUrl: gh.base }), (e) => e.kind === 'bad_input');
  await assert.rejects(generate({ repo: 'acme/missing', baseUrl: gh.base }), (e) => e.kind === 'not_found' && /no public repository called acme\/missing/.test(e.message));
  await assert.rejects(generate({ repo: 'acme/limited', baseUrl: gh.base }), (e) => e.kind === 'rate_limited' && e.reset === 1791990000);
  await assert.rejects(generate({ repo: 'acme/rocket', baseUrl: 'http://127.0.0.1:9' }), (e) => e.kind === 'network');
});

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ''; } };
  return res;
}

test('api/github only proxies the read endpoints the page uses', () => {
  assert.equal(cleanPath('/repos/acme/rocket'), '/repos/acme/rocket');
  assert.equal(cleanPath('/repos/acme/rocket/tags?per_page=100'), '/repos/acme/rocket/tags?per_page=100');
  assert.equal(cleanPath('/repos/acme/rocket/compare/v1.4.0...main'), '/repos/acme/rocket/compare/v1.4.0...main');
  assert.equal(cleanPath('/repos/acme/rocket/commits?per_page=30&sha=main'), '/repos/acme/rocket/commits?per_page=30&sha=main');
  for (const bad of [null, '', 'repos/a/b', '/user', '/repos/a/b/issues', '/repos/a/b/releases/1', '/repos/a/b/commits?access_token=x', 'https://evil.example/repos/a/b', '//evil.example/repos/a/b', '/repos/a/b/../../user', '/search/code?q=x']) {
    assert.equal(cleanPath(bad), null, String(bad));
  }
});

test('api/github forwards, caches, adds the token when set and fails softly', async (t) => {
  const gh = await startGitHubMock();
  t.after(gh.close);
  clearCache();
  const seen = [];
  const fetchSpy = (url, init) => { seen.push({ url, auth: init.headers.authorization }); return fetch(url, init); };
  const opts = { fetch: fetchSpy, env: { GITHUB_TOKEN: 'ghp_test' }, upstream: gh.base };

  const res = fakeRes();
  await handler({ method: 'GET', url: '/api/github?path=' + encodeURIComponent('/repos/acme/rocket/tags?per_page=100') }, res, opts);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body)[0].name, 'v1.4.0');
  assert.equal(res.headers['x-shill-proxy'], '1');
  assert.equal(res.headers['x-ratelimit-limit'], '60');
  assert.match(res.headers['cache-control'], /s-maxage=60/);
  assert.equal(seen[0].auth, 'Bearer ghp_test');

  const again = fakeRes();
  await handler({ method: 'GET', url: '/api/github?path=' + encodeURIComponent('/repos/acme/rocket/tags?per_page=100') }, again, opts);
  assert.equal(again.headers['x-shill-cache'], 'hit');
  assert.equal(seen.length, 1);

  const anon = fakeRes();
  await handler({ method: 'GET', url: '/api/github?path=/repos/acme/rocket' }, anon, { fetch: fetchSpy, env: {}, upstream: gh.base });
  assert.equal(anon.statusCode, 200);
  assert.equal(seen.at(-1).auth, undefined);

  const missing = fakeRes();
  await handler({ method: 'GET', url: '/api/github?path=/repos/acme/missing' }, missing, opts);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers['cache-control'], 'no-store');

  const bad = fakeRes();
  await handler({ method: 'GET', url: '/api/github?path=/user' }, bad, opts);
  assert.equal(bad.statusCode, 400);
  const post = fakeRes();
  await handler({ method: 'POST', url: '/api/github?path=/repos/acme/rocket' }, post, opts);
  assert.equal(post.statusCode, 405);
  const down = fakeRes();
  await handler({ method: 'GET', url: '/api/github?path=/repos/acme/down' }, down, { fetch: () => Promise.reject(new TypeError('fetch failed')), env: {} });
  assert.equal(down.statusCode, 502);
});

test('dev site serves docs/ and routes /api/* like Vercel', async (t) => {
  const gh = await startGitHubMock();
  const site = await startDevSite({ handlerOptions: { upstream: gh.base, env: {} } });
  t.after(() => Promise.all([site.close(), gh.close()]));
  const page = await fetch(site.url + '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<script type="module" src="app.js"><\/script>/);
  assert.match(html, /id="repo"/);
  assert.match(html, /data-example="honojs\/hono"/);
  assert.match(html, /--accent: #FF2E8B/);
  assert.match(html, /v1\.1\.0/);
  assert.equal((await fetch(site.url + '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(site.url + '/lib/web.js')).status, 200);
  assert.equal((await fetch(site.url + '/nope.html')).status, 404);
  assert.equal((await fetch(site.url + '/api/missing')).status, 404);
  const api = await fetch(site.url + '/api/github?path=/repos/acme/rocket');
  assert.equal(api.status, 200);
  assert.equal((await api.json()).full_name, 'acme/rocket');
});

test('the site has no long dashes or emojis', () => {
  for (const f of ['docs/index.html', 'docs/app.js', 'docs/demo.js', 'api/github.js', 'src/web.js']) {
    const text = read(f);
    assert.doesNotMatch(text, /[\u2013\u2014]/, f);
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, f);
  }
});

const PW = '/home/claude/src-reels/tools/node_modules/playwright/index.mjs';
const CHROME = '/opt/pw-browsers/chromium';
const canBrowse = existsSync(PW) && existsSync(CHROME);

test('end to end in a real browser against the mock', { skip: !canBrowse && 'playwright not installed here', timeout: 60000 }, async (t) => {
  const { chromium } = await import(PW);
  const gh = await startGitHubMock({ remaining: 500 });
  const empty = await startGitHubMock({ remaining: 0 });
  const site = await startDevSite({ handlerOptions: { upstream: gh.base, env: {} } });
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); await Promise.all([site.close(), gh.close(), empty.close()]); });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));

  // First paint: example data, labelled, with zero network calls to GitHub.
  await page.goto(`${site.url}/?api=${gh.base}`);
  await page.waitForSelector('.demo-note');
  assert.match(await page.textContent('.demo-note'), /example data/);
  assert.equal(await page.locator('.pv').count(), 5);
  assert.equal(gh.requests.length, 0);

  // Type a repo and click.
  await page.fill('#repo', 'https://github.com/acme/rocket');
  await page.click('#go');
  await page.waitForSelector('.rgrid:not([aria-busy]) .big');
  assert.equal(await page.textContent('.big'), 'v2.0.0');
  assert.equal(await page.locator('.pv').count(), 5);
  assert.equal(await page.locator('.demo-note').count(), 0);
  assert.match(page.url(), /\?repo=acme%2Frocket/);
  assert.match(await page.textContent('[data-channel=x] .txt'), /rocket v2\.0\.0 is out/);
  assert.match(await page.textContent('.rate'), /calls left this hour/);
  await page.click('[data-view=changelog]');
  assert.match(await page.textContent('.raw'), /## \[2\.0\.0\]/);

  // Last N commits.
  await page.click('[data-range=commits]');
  await page.waitForSelector('.pill.est');
  assert.match(page.url(), /range=commits&n=30/);

  // Shareable URL auto-runs; error and empty states.
  await page.goto(`${site.url}/?repo=acme/nope&api=${gh.base}`);
  await page.waitForSelector('.state.err');
  assert.match(await page.textContent('.state.err h3'), /Repo not found/);
  await page.goto(`${site.url}/?repo=acme/quiet&api=${gh.base}`);
  await page.waitForSelector('.state');
  assert.match(await page.textContent('.state h3'), /Nothing new since v3\.0\.0/);
  await page.goto(`${site.url}/?repo=nope&api=${gh.base}`);
  await page.waitForSelector('.state.err');
  assert.match(await page.textContent('.state.err h3'), /does not look like a GitHub repo/);

  // Rate limited in the browser: retries through /api/github and still renders.
  await page.goto(`${site.url}/?repo=acme/rocket&api=${empty.base}`);
  await page.waitForSelector('.rgrid:not([aria-busy]) .big');
  assert.match(await page.textContent('.rate'), /through shillcli\.com/);

  // Phone width: no horizontal scroll.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${site.url}/?repo=acme/rocket&api=${gh.base}`);
  await phone.waitForSelector('.rgrid:not([aria-busy]) .big');
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= 390));
  assert.deepEqual(errors, []);
});
