// Mock GitHub API with a small example history, for README examples and screenshots.
// Usage: node fixtures/demo-server.mjs [port]   then   SHILL_GITHUB_API=http://127.0.0.1:<port> shill acme/rocket ...
import { startServer, githubHandler, commit } from './mocks.js';

const history = [
  ['feat!: drop support for config.yml\n\nBREAKING CHANGE: use rocket.config.json instead', 'alice'],
  ['feat(upload): show a progress bar for large files (#47)', 'dave'],
  ['fix: retry uploads when the server returns 503 (#45)', 'bob'],
  ['perf(build): cache compiled templates between runs (#44)', 'carol'],
  ['feat(cli): add --dry-run flag to preview uploads (#42)', 'alice'],
  ['Merge pull request #41 from bob/feature-x', 'bob', 2],
  ['chore(deps): bump undici from 6.1.0 to 6.2.1', 'dependabot[bot]'],
  ['docs: fix typo in README', 'carol'],
  ['docs: document the --dry-run flag', 'alice'],
  ['refactor(core): split upload queue into its own module', 'carol'],
  ['fix: retry uploads when the server returns 503', 'bob'],
  ['v1.1.0', 'alice'],
];
const commits = history.map(([m, login, parents = 1], i) => commit(m, { login, parents, sha: (i + 1).toString(16).padStart(2, '0').repeat(20) }));
const port = Number(process.argv[2] || 0);
const srv = await startServer(githubHandler(commits, { tags: ['v1.0.0', 'v0.9.0'], firstTimers: ['dave'] }), port);
process.stdout.write(srv.base + '\n');
