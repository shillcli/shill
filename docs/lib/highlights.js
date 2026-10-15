/** Rank commits for posts and build the contributors leaderboard. */

const TYPE_SCORE = { feat: 30, perf: 20, fix: 15, refactor: 6, other: 4, docs: 2, chore: 1 };

/** Score one entry. Higher means more worth announcing. */
export function scoreEntry(e) {
  let score = e.breaking ? 50 : 0;
  score += TYPE_SCORE[e.type] ?? 3;
  if (e.pr) score += 5;
  if (e.scope) score += 2;
  if (Number.isFinite(e.files)) score += Math.min(e.files, 20) * 0.5;
  if (e.body && e.body.length > 40) score += 2;
  return score;
}

/** Top `n` entries by score, ties broken by original (newest first) order. */
export function pickHighlights(entries = [], n = 3) {
  return entries
    .map((e, i) => ({ e, i, score: scoreEntry(e) }))
    .filter((x) => !['chore', 'docs'].includes(x.e.type) || x.e.breaking)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, n)
    .map(({ e, score }) => ({ ...e, score }));
}

/** Contributor key: GitHub login when known, else the git author name. */
export function contributorKey(e) {
  return e.author || e.authorName || null;
}

/** Leaderboard of contributors in the range, most commits first. */
export function leaderboard(entries = [], firstTimers = new Set()) {
  const map = new Map();
  for (const e of entries) {
    const key = contributorKey(e);
    if (!key) continue;
    const row = map.get(key) || { name: key, login: e.author || null, commits: 0, features: 0, fixes: 0, firstTime: firstTimers.has(key) };
    row.commits++;
    if (e.type === 'feat') row.features++;
    if (e.type === 'fix') row.fixes++;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

/** "@alice" for logins, plain name otherwise. */
export function handle(c) {
  return c.login ? `@${c.login}` : c.name;
}
