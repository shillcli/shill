/** CHANGELOG.md text in Keep a Changelog format. Pure functions, safe to run in the browser. */

export const HEADER = `# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).
`;

const KINDS = [
  ['Added', (e) => !e.breaking && e.type === 'feat'],
  ['Changed', (e) => e.breaking || ['perf', 'refactor', 'other'].includes(e.type)],
  ['Fixed', (e) => !e.breaking && e.type === 'fix'],
];

function item(e) {
  const scope = e.scope ? `**${e.scope}:** ` : '';
  const prefix = e.breaking ? '**Breaking:** ' : '';
  const ref = e.pr ? ` (#${e.pr})` : e.shortSha ? ` (${e.shortSha})` : '';
  let line = `- ${prefix}${scope}${e.subject}${ref}`;
  if (e.breakingNote && e.breakingNote !== e.subject) line += `\n  ${e.breakingNote}`;
  return line;
}

/** Strip a leading "v" so headings read "## [1.2.0]". */
export function bareVersion(v) {
  return String(v).replace(/^v(?=\d)/, '');
}

/** Render one "## [x.y.z] - date" section. */
export function changelogSection({ version, date = new Date().toISOString().slice(0, 10), entries = [] }) {
  const lines = [`## [${bareVersion(version)}] - ${date}`, ''];
  let any = false;
  for (const [kind, match] of KINDS) {
    const list = entries.filter(match);
    if (!list.length) continue;
    any = true;
    lines.push(`### ${kind}`, '', ...list.map(item), '');
  }
  if (!any) lines.push('Maintenance only, no user-facing changes.', '');
  return lines.join('\n');
}

/** Compare link reference line, e.g. "[1.2.0]: https://github.com/o/r/compare/v1.1.0...v1.2.0". */
export function compareLink(repo, version, previous) {
  if (!repo) return null;
  const tag = /^v/.test(previous || '') || !previous ? `v${bareVersion(version)}` : bareVersion(version);
  const url = previous ? `https://github.com/${repo}/compare/${previous}...${tag}` : `https://github.com/${repo}/releases/tag/${tag}`;
  return `[${bareVersion(version)}]: ${url}`;
}

const HEADING_RE = /^## \[([^\]]+)\]/;

/**
 * Insert (or replace) the section for `version` in changelog text.
 * New sections go below "## [Unreleased]" when present, else above the newest release.
 */
export function insertSection(text, section, version, link = null) {
  const v = bareVersion(version);
  const src = text && text.trim() ? text.replace(/\r\n/g, '\n') : HEADER;
  const lines = src.split('\n');
  const body = section.trimEnd().split('\n');
  const existing = lines.findIndex((l) => HEADING_RE.exec(l)?.[1] === v);
  if (existing !== -1) {
    const oldDate = / - (\d{4}-\d{2}-\d{2})/.exec(lines[existing])?.[1];
    if (oldDate) body[0] = body[0].replace(/ - \d{4}-\d{2}-\d{2}/, ` - ${oldDate}`);
    let end = lines.findIndex((l, i) => i > existing && (/^## /.test(l) || /^\[[^\]]+\]: /.test(l)));
    if (end === -1) end = lines.length;
    lines.splice(existing, end - existing, ...body, '');
  } else {
    let at = lines.findIndex((l) => HEADING_RE.test(l) && HEADING_RE.exec(l)[1].toLowerCase() !== 'unreleased');
    if (at === -1) {
      at = lines.findIndex((l) => /^\[[^\]]+\]: /.test(l));
      if (at === -1) { while (lines.length && lines.at(-1) === '') lines.pop(); lines.push(''); at = lines.length; }
    }
    lines.splice(at, 0, ...body, '');
  }
  if (link && !lines.some((l) => l.startsWith(`[${v}]: `))) {
    while (lines.length && lines.at(-1) === '') lines.pop();
    const firstRef = lines.findIndex((l) => /^\[[^\]]+\]: /.test(l));
    if (firstRef === -1) lines.push('', link);
    else lines.splice(firstRef, 0, link);
  }
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}
