/** Deterministic, offline pre-pass: parse, filter, dedupe and group commits. */

export const SECTIONS = [
  ['breaking', 'Breaking Changes'],
  ['feat', 'Features'],
  ['fix', 'Bug Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['chore', 'Maintenance'],
  ['other', 'Other Changes'],
];

const TYPE_ALIASES = {
  feat: 'feat', feature: 'feat', fix: 'fix', bugfix: 'fix', hotfix: 'fix', perf: 'perf',
  refactor: 'refactor', docs: 'docs', doc: 'docs',
  chore: 'chore', build: 'chore', ci: 'chore', test: 'chore', tests: 'chore', style: 'chore', deps: 'chore',
};

const HEADER_RE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;
const BREAKING_RE = /^BREAKING[ -]CHANGE:\s*(.+)$/m;

/** Parse a raw commit message into a Conventional Commit shape. */
export function parseMessage(message) {
  const [rawHeader = '', ...rest] = String(message || '').split('\n');
  const header = rawHeader.trim();
  const body = rest.join('\n').trim();
  const m = HEADER_RE.exec(header);
  const breakingNote = BREAKING_RE.exec(body)?.[1]?.trim() || null;
  if (!m) {
    return { type: 'other', rawType: null, scope: null, subject: header, body, breaking: Boolean(breakingNote), breakingNote, conventional: false };
  }
  const rawType = m[1].toLowerCase();
  return {
    type: TYPE_ALIASES[rawType] || 'other',
    rawType,
    scope: m[2] ? m[2].trim() || null : null,
    subject: m[4].trim(),
    body,
    breaking: Boolean(m[3]) || Boolean(breakingNote),
    breakingNote,
    conventional: true,
  };
}

/** Return a reason string if the commit is noise, else null. */
export function noiseReason(subject, parsed = parseMessage(subject), parentCount = 1) {
  const s = subject.trim();
  if (parentCount > 1 || /^Merge (pull request|branch|remote-tracking branch|tag) /i.test(s)) return 'merge';
  if (/^(bump|update) [\w@./-]+ (from|to) v?\d/i.test(s) || /^(chore|build)\(deps(-dev)?\):/i.test(s)) return 'bump';
  if (/^(release|version|bump version|chore\(release\):)?\s*v?\d+\.\d+\.\d+(-[\w.]+)?$/i.test(s)) return 'bump';
  if (/^chore(\([^)]*\))?: (release|bump version)/i.test(s)) return 'bump';
  if (/\btypos?\b/i.test(s)) return 'typo';
  if (/^(wip\b|fixup!|squash!|amend!)/i.test(s) || /^\.+$/.test(s)) return 'wip';
  if (parsed.subject.length < 3) return 'empty';
  return null;
}

/** Normalize a subject for duplicate detection. */
export function dedupeKey(subject) {
  return subject.toLowerCase().replace(/\s*\(#\d+\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Convert raw GitHub API commit objects into filtered, grouped entries. */
export function analyze(rawCommits, { repo, excludeSha = null } = {}) {
  const stats = { seen: 0, kept: 0, dropped: { merge: 0, bump: 0, typo: 0, wip: 0, empty: 0, duplicate: 0 }, byType: {} };
  const seen = new Set();
  const entries = [];
  for (const c of rawCommits) {
    if (excludeSha && c.sha === excludeSha) continue;
    stats.seen++;
    const message = c.commit?.message || '';
    const parsed = parseMessage(message);
    const reason = noiseReason(message.split('\n')[0], parsed, c.parents?.length || 1);
    if (reason) { stats.dropped[reason]++; continue; }
    const key = dedupeKey(parsed.subject);
    if (seen.has(key)) { stats.dropped.duplicate++; continue; }
    seen.add(key);
    const pr = /\(#(\d+)\)\s*$/.exec(parsed.subject)?.[1] || null;
    const entry = {
      ...parsed,
      subject: parsed.subject.replace(/\s*\(#\d+\)\s*$/, ''),
      sha: c.sha,
      shortSha: (c.sha || '').slice(0, 7),
      url: c.html_url || (repo ? `https://github.com/${repo}/commit/${c.sha}` : null),
      author: c.author?.login || null,
      authorName: c.commit?.author?.name || null,
      pr,
      date: c.commit?.author?.date || null,
      files: Array.isArray(c.files) ? c.files.length : Number.isFinite(c.files) ? c.files : null,
    };
    entries.push(entry);
    stats.kept++;
    const t = entry.breaking ? 'breaking' : entry.type;
    stats.byType[t] = (stats.byType[t] || 0) + 1;
  }
  return { entries, groups: groupEntries(entries), stats };
}

/** Group entries by section key; breaking changes get their own section. */
export function groupEntries(entries) {
  const groups = {};
  for (const e of entries) {
    const key = e.breaking ? 'breaking' : e.type;
    (groups[key] ||= []).push(e);
  }
  return groups;
}
