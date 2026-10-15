/** Semantic version helpers and the next-version suggestion. */

const SEMVER_RE = /^(v?)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse "v1.2.3" or "1.2.3-rc.1" into parts, or null when it is not semver. */
export function parseVersion(tag) {
  const m = SEMVER_RE.exec(String(tag || '').trim());
  if (!m) return null;
  return { prefix: m[1], major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]), pre: m[5] || null, raw: tag };
}

/** Compare two parsed versions. Prereleases sort before their release. */
export function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** Highest semver tag in a list. Stable releases win over prereleases. */
export function latestTag(names = []) {
  const parsed = names.map(parseVersion).filter(Boolean);
  const stable = parsed.filter((v) => !v.pre);
  const pool = stable.length ? stable : parsed;
  if (!pool.length) return null;
  return pool.sort(compareVersions).at(-1).raw;
}

/** Highest semver tag strictly lower than `tag`, or null. */
export function previousTag(names = [], tag) {
  const cur = parseVersion(tag);
  if (!cur) return null;
  const lower = names.map(parseVersion).filter((v) => v && compareVersions(v, cur) < 0 && !v.pre);
  return lower.length ? lower.sort(compareVersions).at(-1).raw : null;
}

export function formatVersion({ prefix = '', major, minor, patch }) {
  return `${prefix}${major}.${minor}.${patch}`;
}

function quote(list) {
  const shown = list.slice(0, 2).map((e) => `"${e.subject}"`).join(', ');
  return list.length > 2 ? `${shown} and ${list.length - 2} more` : shown;
}

/**
 * Suggest the next version from commit types: breaking -> major, feat -> minor,
 * anything else -> patch. Returns { current, next, bump, reasons }.
 */
export function suggestNext(lastTag, entries = []) {
  const parsed = parseVersion(lastTag) || { prefix: 'v', major: 0, minor: 0, patch: 0, pre: null };
  const current = lastTag && parseVersion(lastTag) ? lastTag : null;
  const breaking = entries.filter((e) => e.breaking);
  const feats = entries.filter((e) => !e.breaking && e.type === 'feat');
  const reasons = [];
  let bump = null;
  if (!entries.length) {
    reasons.push('No releasable commits since the last tag.');
  } else if (breaking.length) {
    bump = 'major';
    reasons.push(`${breaking.length} breaking change${breaking.length > 1 ? 's' : ''}: ${quote(breaking)}.`);
  } else if (feats.length) {
    bump = 'minor';
    reasons.push(`${feats.length} new feature${feats.length > 1 ? 's' : ''}: ${quote(feats)}.`);
  } else {
    bump = 'patch';
    reasons.push(`${entries.length} fix or maintenance commit${entries.length > 1 ? 's' : ''}, no features or breaking changes.`);
  }
  let next = { ...parsed };
  if (parsed.pre && bump) {
    reasons.push(`${current} is a prerelease, so the next version releases it.`);
  } else if (bump === 'major') next = { ...parsed, major: parsed.major + 1, minor: 0, patch: 0 };
  else if (bump === 'minor') next = { ...parsed, minor: parsed.minor + 1, patch: 0 };
  else if (bump === 'patch') next = { ...parsed, patch: parsed.patch + 1 };
  if (!current) reasons.push('No semver tag found, counting from 0.0.0.');
  return { current, next: formatVersion(next), bump, reasons };
}
