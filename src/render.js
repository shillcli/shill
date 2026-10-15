import { SECTIONS } from './parse.js';

export const TWEET_LIMIT = 280;

const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const HASHTAG_RE = /(^|\s)#[\p{L}_][\p{L}\p{N}_]*/gu;

/** Count characters the way people see them (code points, not UTF-16 units). */
export function tweetLength(text) {
  return [...text].length;
}

/** Remove emojis, hashtags, long dashes and stray whitespace. */
export function cleanTweet(text) {
  return String(text || '')
    .replace(EMOJI_RE, '')
    .replace(HASHTAG_RE, '$1')
    .replace(/\s*[\u2013\u2014]\s*/g, ', ')
    .replace(/^["']|["']$/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

/** Problems that make a tweet unusable as-is. Empty array means valid. */
export function tweetProblems(text, limit = TWEET_LIMIT) {
  const problems = [];
  if (!text) problems.push('empty');
  if (tweetLength(text) > limit) problems.push(`too long (${tweetLength(text)} > ${limit} characters)`);
  if (new RegExp(HASHTAG_RE.source, 'u').test(text)) problems.push('contains hashtags');
  if (new RegExp(EMOJI_RE.source, 'u').test(text)) problems.push('contains emojis');
  return problems;
}

/** Cut a tweet at a word boundary so it fits, appending "...". */
export function truncateTweet(text, limit = TWEET_LIMIT) {
  if (tweetLength(text) <= limit) return text;
  const chars = [...text].slice(0, limit - 3).join('');
  const cut = chars.replace(/\s+\S*$/, '').replace(/[\s,;:.\-]+$/, '');
  return (cut.length > limit / 2 ? cut : chars.trimEnd()) + '...';
}

function formatEntry(e) {
  const scope = e.scope ? `**${e.scope}:** ` : '';
  const sha = e.url ? `[${e.shortSha}](${e.url})` : e.shortSha;
  const pr = e.pr ? ` #${e.pr}` : '';
  const who = e.author ? ` by @${e.author}` : e.authorName ? ` by ${e.authorName}` : '';
  let line = `- ${scope}${e.subject} (${sha}${pr})${who}`;
  if (e.breakingNote && e.breakingNote !== e.subject) line += `\n  - ${e.breakingNote}`;
  return line;
}

/** Render grouped entries to Markdown release notes without any AI. */
export function renderMarkdown({ repo, label, groups, stats, contributors }) {
  const lines = [`## ${repo}: ${label}`, ''];
  if (!stats.kept) {
    lines.push('No notable changes.');
    return lines.join('\n') + '\n';
  }
  for (const [key, title] of SECTIONS) {
    const list = groups[key];
    if (!list?.length) continue;
    lines.push(`### ${title}`, '', ...list.map(formatEntry), '');
  }
  const people = contributors || [...new Set(Object.values(groups).flat().map((e) => e.author).filter(Boolean))].map((login) => ({ login, name: login }));
  if (people.length) lines.push(`Contributors: ${people.map((c) => (c.login ? '@' + c.login : c.name)).join(', ')}`, '');
  const first = people.filter((c) => c.firstTime);
  if (first.length) lines.push(`First-time contributors: ${first.map((c) => (c.login ? '@' + c.login : c.name)).join(', ')}. Welcome.`, '');
  return lines.join('\n');
}

function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

/** Build a deterministic launch tweet from grouped entries. Always fits the limit. */
export function templateTweet({ repo, groups, stats }, limit = TWEET_LIMIT) {
  const name = repo.split('/')[1] || repo;
  const counts = [];
  if (groups.breaking?.length) counts.push(plural(groups.breaking.length, 'breaking change'));
  if (groups.feat?.length) counts.push(plural(groups.feat.length, 'new feature'));
  if (groups.fix?.length) counts.push(plural(groups.fix.length, 'fix', 'fixes'));
  if (groups.perf?.length) counts.push(plural(groups.perf.length, 'performance improvement'));
  const head = counts.length ? `New in ${name}: ${counts.join(', ')}.` : `New in ${name}: ${plural(stats.kept, 'change')}.`;
  const highlights = [...(groups.breaking || []), ...(groups.feat || []), ...(groups.fix || []), ...(groups.perf || [])]
    .slice(0, 3)
    .map((e) => e.subject.replace(/\.$/, ''));
  const link = `https://github.com/${repo}/releases`;
  let body = head;
  for (const h of highlights) {
    const candidate = `${body}\n- ${h}`;
    if (tweetLength(`${candidate}\n\n${link}`) > limit) break;
    body = candidate;
  }
  const full = `${body}\n\n${link}`;
  return tweetLength(full) <= limit ? full : truncateTweet(body, limit);
}
