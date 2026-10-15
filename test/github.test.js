import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, nextLink, parseDuration, resolveSince } from '../src/github.js';
import { ShillError } from '../src/errors.js';
import { startServer, githubHandler, commit } from '../fixtures/mocks.js';

test('parseDuration and nextLink', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  assert.equal(parseDuration('7d', now).toISOString(), '2026-10-07T00:00:00.000Z');
  assert.equal(parseDuration('12h', now).toISOString(), '2026-10-13T12:00:00.000Z');
  assert.equal(parseDuration('v1.0.0', now), null);
  assert.equal(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=5>; rel="last"'), 'https://x/a?page=2');
  assert.equal(nextLink('<https://x/a?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});

test('follows pagination and respects max', async (t) => {
  const commits = Array.from({ length: 250 }, (_, i) => commit(`feat: change ${i}`));
  const srv = await startServer(githubHandler(commits));
  t.after(srv.close);
  const gh = new GitHubClient({ baseUrl: srv.base, token: 'tok' });

  const all = await gh.listCommits('acme/rocket', { since: '2026-01-01T00:00:00Z', max: 1000 });
  assert.equal(all.length, 250);
  const pages = srv.requests.filter((r) => r.url.startsWith('/repos/acme/rocket/commits'));
  assert.equal(pages.length, 3);
  assert.match(pages[0].url, /per_page=100/);
  assert.match(pages[0].url, /since=2026-01-01/);
  assert.equal(pages[0].headers.authorization, 'Bearer tok');

  srv.requests.length = 0;
  const some = await gh.listCommits('acme/rocket', { max: 120, until: 'main' });
  assert.equal(some.length, 120);
  assert.equal(srv.requests.length, 2);
  assert.match(srv.requests[0].url, /sha=main/);
});

test('resolves annotated tags, release fallback, dates and durations', async (t) => {
  const srv = await startServer(githubHandler([]));
  t.after(srv.close);
  const gh = new GitHubClient({ baseUrl: srv.base });
  const tag = await resolveSince(gh, 'acme/rocket', 'v1.0.0');
  assert.deepEqual(tag, { date: '2026-09-01T00:00:00Z', excludeSha: 'f'.repeat(40), label: 'since v1.0.0' });
  const rel = await resolveSince(gh, 'acme/rocket', 'v0.9.0');
  assert.equal(rel.date, '2026-08-01T00:00:00Z');
  const date = await resolveSince(gh, 'acme/rocket', '2026-10-01');
  assert.equal(date.date, '2026-10-01T00:00:00.000Z');
  const dur = await resolveSince(gh, 'acme/rocket', '7d', new Date('2026-10-14T00:00:00Z'));
  assert.equal(dur.label, 'last 7d');
  await assert.rejects(resolveSince(gh, 'acme/rocket', 'v9.9.9'), /Tag "v9.9.9" not found/);
});

test('reports clear errors for 404 and rate limits', async (t) => {
  const srv = await startServer((req) => req.url.includes('limited')
    ? { status: 403, json: { message: 'API rate limit exceeded' } }
    : { status: 404, json: { message: 'Not Found' } });
  t.after(srv.close);
  const gh = new GitHubClient({ baseUrl: srv.base });
  await assert.rejects(gh.listCommits('acme/missing'), (err) => err instanceof ShillError && /404.*not found/i.test(err.message));
  await assert.rejects(gh.listCommits('acme/limited'), /rate limited.*GITHUB_TOKEN/);
});
