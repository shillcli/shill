/** CHANGELOG.md maintenance in Keep a Changelog format. Re-running for the same version is a no-op. */
import { readFile, writeFile } from 'node:fs/promises';
import { insertSection } from './changelog-core.js';

export { HEADER, bareVersion, changelogSection, compareLink, insertSection } from './changelog-core.js';

/** Read, update and write a changelog file. Returns { path, changed, text }. */
export async function writeChangelog(path, section, version, link) {
  let before = '';
  try { before = await readFile(path, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const text = insertSection(before, section, version, link);
  const changed = text !== before;
  if (changed) await writeFile(path, text);
  return { path, changed, text };
}
