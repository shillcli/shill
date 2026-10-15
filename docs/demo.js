// Example data for the first paint of shillcli.com and for the offline tests.
// acme/rocket is not a real repository. The page labels this as example data.

const day = (d) => `2026-10-${String(d).padStart(2, '0')}T12:00:00Z`;
let n = 0;
function c(message, login, d, { parents = 1 } = {}) {
  n++;
  const sha = (n.toString(16).padStart(2, '0') + 'b7e4c1d9a0').repeat(4).slice(0, 40);
  return {
    sha,
    html_url: `https://github.com/acme/rocket/commit/${sha}`,
    commit: { message, author: { name: login, date: day(d) }, committer: { date: day(d) } },
    author: { login },
    parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
  };
}

/** Commits since v1.4.0, oldest first, the way the compare endpoint returns them. */
export const DEMO_COMMITS = [
  c('refactor(core): split upload queue into its own module', 'carol', 2),
  c('fix: retry uploads when the server returns 503 (#45)', 'bob', 3),
  c('chore(deps): bump undici from 6.1.0 to 6.2.1', 'dependabot[bot]', 3),
  c('perf(build): cache compiled templates between runs (#44)', 'carol', 4),
  c('docs: fix typo in README', 'alice', 5),
  c('feat(cli): add --dry-run flag to preview uploads (#42)', 'alice', 6),
  c('Merge pull request #46 from bob/retry\n\nretry on 503', 'bob', 6, { parents: 2 }),
  c('feat(upload): show a progress bar for large files (#47)', 'dave', 8),
  c('fix(auth): clearer error when the token is missing (#48)', 'bob', 9),
  c('docs: document the --dry-run flag', 'alice', 10),
  c('feat!: drop support for config.yml (#50)\n\nBREAKING CHANGE: use rocket.config.json instead', 'alice', 11),
  c('fix: retry uploads when the server returns 503', 'bob', 12),
  c('v1.4.1', 'alice', 12),
];

export const DEMO_REPO = {
  full_name: 'acme/rocket',
  description: 'Upload anything, from anywhere. (example data)',
  default_branch: 'main',
  stargazers_count: 1284,
  html_url: 'https://github.com/acme/rocket',
  owner: { login: 'acme', avatar_url: null },
};

export const DEMO_TAGS = ['v1.4.0', 'v1.3.2', 'v1.3.1', 'v1.3.0', 'v1.2.0'];
export const DEMO_FIRST_TIMERS = ['dave'];

/** Answer a GitHub API path for acme/rocket, or null. Shared by the page and the mock server. */
export function demoAnswer(pathAndQuery) {
  const url = new URL(pathAndQuery, 'https://api.github.com');
  const p = url.pathname;
  if (p === '/repos/acme/rocket') return DEMO_REPO;
  if (p === '/repos/acme/rocket/tags') return DEMO_TAGS.map((name) => ({ name, commit: { sha: 'c'.repeat(40) } }));
  if (p === '/repos/acme/rocket/releases') return [{ tag_name: 'v1.4.0', draft: false }];
  if (p.startsWith('/repos/acme/rocket/compare/')) {
    return { status: 'ahead', ahead_by: DEMO_COMMITS.length, total_commits: DEMO_COMMITS.length, base_commit: { commit: { committer: { date: '2026-10-01T09:00:00Z' } } }, commits: DEMO_COMMITS };
  }
  if (p === '/repos/acme/rocket/commits') {
    const author = url.searchParams.get('author');
    if (author) return DEMO_FIRST_TIMERS.includes(author) ? [] : [DEMO_COMMITS[0]];
    const per = Number(url.searchParams.get('per_page') || 30);
    return [...DEMO_COMMITS].reverse().slice(0, per);
  }
  return null;
}

/** A fetch that serves the example repo without touching the network. */
export async function demoFetch(input) {
  const url = new URL(String(input));
  const body = demoAnswer(url.pathname + url.search);
  return new Response(JSON.stringify(body ?? { message: 'Not Found' }), {
    status: body ? 200 : 404,
    headers: { 'content-type': 'application/json' },
  });
}
